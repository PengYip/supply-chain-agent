// 批量拆分器 Phase 2: 两遍读数共识(设计文档 2026-09-01 §5.3)。
//
// 检测遍(VLM 版面清点)与抽取遍(VLM 凭证抽取)是两次独立读数; 拼贴模糊
// 照片的数字字段两遍不一致是常态(原型实测: 单号 10384417 vs 10394417、
// 净重 34250 vs 54520)。这类字段不可自动入台账: 分歧 -> 压低
// overall_confidence 并强制 needs_review(与现有 extractions.needs_review +
// field_meta._warnings 审核流程衔接)。
//
// 同时提供旋回双候选的择优评分: 共识命中是比 VLM 自报置信度更可靠的
// 方向判别信号(旋反的图仍能"旋转不变地"读出大部分字段, 但读数与检测遍
// 对不上)。

/** 检测遍读数(identifierOrNull + evidence)。 */
export interface DetectionReading {
  identifier: string | null;
  evidence: string;
}

export interface ReadingConsensus {
  /** 分歧清单: message 写入 field_meta._warnings(审核卡可见), fields 为涉及
   *  字段名(数组行叶子归并到容器字段, 如 明细行1.编号 -> 明细行)。 */
  mismatches: Array<{ message: string; fields: string[] }>;
}

/** 两遍读数分歧时 overall_confidence 的强制上限(压低至人工审核优先级)。 */
export const CONSENSUS_MISMATCH_CONFIDENCE_CAP = 0.5;

/** 单号/编号类字段名(车号/卡号/账号等非单据标识字段刻意不匹配)。 */
const IDENT_FIELD_RE = /(单号|编号|号码|票号|报告号|凭证号)/;
/** 重量标签的精确集合(2026-09-01 下游收货证明实测: 子串匹配会把 毛重时间/
 *  皮重时间 这类时间字段误拉进重量共识, 把 evidence "毛重63.16" 与字段
 *  "2026-06-08 19:23:12" 强行比对产生假分歧)。 */
const WEIGHT_LABELS = new Set(['总净重', '净重', '毛重', '皮重', '重量']);
/** 证据标签别名: 磅单实物常用"实重", schema 字段为 净重_吨。 */
const WEIGHT_LABEL_ALIAS: Record<string, string> = { 实重: '净重' };
/** evidence 中"标签 + 数字"读数(净重34250 / 毛重: 45,600 等); 标签后紧跟
 *  时间/日期字样不算(毛重时间 2026-06-08 不是重量读数)。 */
const WEIGHT_EVIDENCE_RE =
  /(总净重|净重|毛重|皮重|实重|重量)(?![时间日期])\s*[:：]?\s*([0-9]+(?:[.,][0-9]+)?)/g;

/** 读数归一: 去掉全部非字母数字字符(空格/连字符/点号等 OCR 噪声)。 */
export function normalizeReadingId(v: string): string {
  return v.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export interface ReadingLeaf {
  key: string;
  /** 数组行叶子的容器字段名(如 明细行), 标量叶子与 key 相同。 */
  container: string;
  /** 裸字段名(数组行叶子为行内字段, 如 净重_吨; 标量叶子与 key 相同)。 */
  field: string;
  value: unknown;
}

/**
 * 展开抽取字段为叶子清单: 顶层标量 + 一层数组行(明细行/rows/指标)。
 * 行内字段以 `容器N.字段` 为 key(如 明细行1.编号), 供单号/重量共识使用。
 */
export function readingLeaves(fields: Record<string, unknown>): ReadingLeaf[] {
  const out: ReadingLeaf[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      v.forEach((row, i) => {
        if (row === null || typeof row !== 'object') return;
        for (const [rk, rv] of Object.entries(row as Record<string, unknown>)) {
          out.push({ key: `${k}${i + 1}.${rk}`, container: k, field: rk, value: rv });
        }
      });
    } else {
      out.push({ key: k, container: k, field: k, value: v });
    }
  }
  return out;
}

/** 数字读数解析: number 直取; 字符串取首个数字串(千分位逗号归一)。 */
function parseReadingNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const m = v.match(/-?[0-9]+(?:[.,][0-9]+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]!.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** 重量读数等价: 相等或恰差 1000 倍(evidence 常以 kg 记, schema 字段为 _吨)。 */
function sameWeightReading(a: number, b: number): boolean {
  const tol = (x: number, y: number): boolean =>
    Math.abs(x - y) <= Math.max(0.01, Math.min(Math.abs(x), Math.abs(y)) * 0.001);
  return tol(a, b) || tol(a * 1000, b) || tol(a, b * 1000);
}

/** 去掉字段名的单位后缀(净重_吨 -> 净重), 与 evidence 标签对齐。 */
function weightLabelOf(key: string): string {
  return key.replace(/_[^_]*$/, '');
}

/** 重量标签归一(实重 -> 净重), 供证据/字段两侧对齐。 */
function canonWeightLabel(label: string): string {
  return WEIGHT_LABEL_ALIAS[label] ?? label;
}

/**
 * 两遍读数共识(纯函数):
 *  - 单号共识: 检测遍 identifier 非空且抽取遍存在单号/编号类字段时, 要求
 *    归一化后互相包含(双向, 容忍 "No." 前缀等格式噪声); 全部对不上 -> 分歧;
 *  - 重量共识: evidence 中带标签的重量读数(净重34250 等)与同名字段不等
 *    (含 kg/吨 千倍换算) -> 分歧。
 * 无可比对(任一侧缺读数)不产生分歧——覆盖缺口由字段置信度兜底, 不是读数冲突。
 */
export function compareReadings(
  detection: DetectionReading,
  fields: Record<string, unknown>,
): ReadingConsensus {
  const mismatches: Array<{ message: string; fields: string[] }> = [];
  const leaves = readingLeaves(fields);

  const want = detection.identifier ? normalizeReadingId(detection.identifier) : '';
  if (want.length >= 4) {
    const idLeaves = leaves.filter(
      (l) => IDENT_FIELD_RE.test(l.key) && typeof l.value === 'string' && l.value.trim().length > 0,
    );
    const matched = idLeaves.some((l) => {
      const got = normalizeReadingId(l.value as string);
      return got.length >= 4 && (got.includes(want) || want.includes(got));
    });
    if (!matched && idLeaves.length > 0) {
      const got = idLeaves.map((l) => `${l.key}=${String(l.value)}`).join(', ');
      mismatches.push({
        message: `两遍读数分歧: 检测遍编号 ${detection.identifier} 与抽取读数(${got})不一致`,
        fields: [...new Set(idLeaves.map((l) => l.container))],
      });
    }
  }

  const evidenceWeights: Array<{ label: string; value: number }> = [];
  for (const m of detection.evidence.matchAll(WEIGHT_EVIDENCE_RE)) {
    const value = Number.parseFloat(m[2]!.replace(',', '.'));
    if (Number.isFinite(value)) evidenceWeights.push({ label: m[1]!, value });
  }
  if (evidenceWeights.length > 0) {
    // 只有标签精确命中(去掉单位后缀后)的叶子才参与重量共识;
    // 毛重时间/皮重时间等时间字段被刻意排除。
    const weightLeaves = leaves.filter((l) => WEIGHT_LABELS.has(canonWeightLabel(weightLabelOf(l.field))));
    for (const leaf of weightLeaves) {
      const got = parseReadingNumber(leaf.value);
      if (got === null) continue;
      const label = canonWeightLabel(weightLabelOf(leaf.field));
      // 先精确对齐标签(总净重↔总净重_吨), 无精确命中再退化为包含(净重↔总净重)。
      const exact = evidenceWeights.filter((e) => canonWeightLabel(e.label) === label);
      const related = exact.length > 0
        ? exact
        : evidenceWeights.filter((e) => {
            const el = canonWeightLabel(e.label);
            return label.includes(el) || el.includes(label);
          });
      if (related.length === 0) continue;
      if (!related.some((e) => sameWeightReading(e.value, got))) {
        mismatches.push({
          message: `两遍读数分歧: 检测遍${label} ${related.map((e) => e.value).join('/')} 与抽取读数 ${leaf.key}=${String(leaf.value)} 不一致`,
          fields: [leaf.container],
        });
      }
    }
  }

  return { mismatches };
}

/**
 * 旋回候选择优评分(纯函数, 分数越高越好):
 *  - 两遍共识命中占大头(+2): 方向旋反的图常仍能读出字段, 但读数与检测遍
 *    对不上, 这比 VLM 自报置信度更可靠;
 *  - 字段置信度均值作次级信号(自报, 无置信度时按 0.5 中性);
 *  - 非空字段数作微量 tie-break(旋反图通常读出的字段更少)。
 */
export function unitCandidateScore(input: {
  fields: Record<string, unknown>;
  fieldConfidences: Record<string, number>;
  mismatchCount: number;
}): number {
  const leaves = readingLeaves(input.fields);
  const filled = leaves.filter(
    (l) => l.value !== null && l.value !== undefined && String(l.value).trim().length > 0,
  ).length;
  const confs = Object.values(input.fieldConfidences).filter(
    (c) => typeof c === 'number' && Number.isFinite(c) && c > 0,
  );
  const meanConf = confs.length > 0 ? confs.reduce((s, c) => s + c, 0) / confs.length : 0.5;
  return (input.mismatchCount > 0 ? 0 : 2) + meanConf + Math.min(filled, 20) * 0.01;
}

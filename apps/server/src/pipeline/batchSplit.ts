// 批量拆分器检测层(spec 2026-09-01 §3): 一个物理文件 ≠ 一份业务单据。
//
// detectDocumentUnits 做的是"版面清点", 不是纯切页:
//  - 空白页先用像素非白占比预判(<5% 跳过 VLM, 省 5-13s/页的调用);
//  - 逐页(150 DPI, 与 pdfRender 同口径)VLM 清点独立完整业务单据区域,
//    输出 unitIndex/formType/confidence/bbox/rotationDeg/evidence/identifierOrNull;
//  - 跨页续表(同 formType + 同单号的相邻页)合并为一个逻辑单据;
//  - bbox 落地时加 2.5% padding(原型 1% 仍出现边缘裁切)。
//
// 产出只是"逻辑单据清单"; 生成子单据/走全链路在 documentEntry 的
// processDocumentWithBatch(灰度入口), 本模块不落库。

import { inflateSync } from 'node:zlib';
import { renderPdfPages, type RenderedPage } from './pdfRender.js';
import { vlmCall } from './vlmClassifier.js';

/** formType 受控词表(设计文档 §3)。 */
export const UNIT_FORM_TYPES = [
  '汽运磅单', '轨道衡称重单', '水尺计重单', '质检报告', '质检汇总表',
  '货转单', '付款凭证', '合同', '微信聊天记录', '数据表格', '空白页', '其他',
] as const;

/**
 * container 文档的固定业务类型(2026-09-01 拍板决策 1)。container 是"物理拼版
 * 文件"不是业务单据, 词表分类只会产噪声, 故跳过分类器直接定类型。刻意不进
 * 模板词表/PATCH 校验/齐套率五维(dimension 未映射 -> 天然排除)。
 */
export const CONTAINER_DOC_TYPE = '单据组' as const;

/**
 * 检测词表 -> 模板注册表 formTypes 的别名桥(Phase 2 抽取路由用)。
 * P1 检测词表按清点质量选定, 与 v2.1 分类词表(templateSeed formTypes)
 * 不同源(如检测输出"汽运磅单", 注册表登记"汽车过磅单票据")。路由仍以
 * formTypeRegistry 的数据为准: 部署模板没有对应 formType 时不路由, 子单据
 * 回落 Phase 1 的 OCR 块路径。微信聊天记录/数据表格/其他 无凭证 schema,
 * 刻意不桥接。
 */
export const UNIT_FORM_TYPE_ALIASES: Readonly<Record<string, string>> = {
  汽运磅单: '汽车过磅单票据',
  轨道衡称重单: '轨道衡称重记录',
  水尺计重单: '水尺计重单',
  质检报告: '化验报告',
  质检汇总表: '收货质检汇总表',
  货转单: '货权转移证明',
  付款凭证: '银行回单',
  合同: '合同扫描件',
};

/** 空白页预判阈值: 非白像素占比 < 5% 视为空白, 跳过 VLM。 */
export const BLANK_NON_WHITE_RATIO = 0.05;

/** bbox 落地 padding(归一化页宽/高的比例, 四边各加)。 */
export const BBOX_PADDING = 0.025;

/** 归一化 bbox, 原点左上, x/y/w/h ∈ [0,1]。 */
export interface UnitBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 检测出的一个逻辑单据(可能跨页合并)。 */
export interface DetectedUnit {
  /** 全局序号(按 pageStart + 阅读顺序), 1-based。 */
  unitIndex: number;
  formType: string;
  /** 合并时取各区域 confidence 的最小值。 */
  confidence: number;
  identifier: string | null;
  evidence: string;
  pageStart: number;
  pageEnd: number;
  /** 单页 unit 的 padded bbox; 跨页合并 unit 为 null(逐页区域在 regions)。 */
  bbox: UnitBBox | null;
  /** 首个区域的旋转角(0/90/180/270)。 */
  rotationDeg: number;
  /** 逐页区域明细(Phase 2 切片用), bbox 已加 padding。 */
  regions: Array<{ page: number; bbox: UnitBBox; rotationDeg: number }>;
}

/** 每页清点摘要(审计/测试用)。 */
export interface PageInventory {
  page: number;
  /** null = PNG 无法解码(按非空白处理, 交给 VLM)。 */
  nonWhiteRatio: number | null;
  blank: boolean;
  unitCount: number;
}

export interface DetectDocumentUnitsResult {
  units: DetectedUnit[];
  pages: PageInventory[];
}

/**
 * 页数超过 BATCH_SPLIT_MAX_PAGES 的可判型错误。灰度入口(processDocumentWithBatch)
 * 据此把超限从"静默回落整本 legacy"区分为显式失败(其余检测失败仍回落, 永不
 * 劣于现状原则不变)。携带实际页数与配置上限, 供失败 reason 使用真实值。
 */
export class BatchSplitPageLimitError extends Error {
  readonly pages: number;
  readonly maxPages: number;
  constructor(pages: number, maxPages: number) {
    super(`页数 ${pages} 超过批量拆分上限 ${maxPages}, 跳过拆分`);
    this.name = 'BatchSplitPageLimitError';
    this.pages = pages;
    this.maxPages = maxPages;
  }
}

/** 可注入依赖(测试用固定页图 + fake VLM)。 */
export interface DetectUnitsDeps {
  renderPages?: (sourcePath: string) => Promise<RenderedPage[]>;
  call?: (
    prompt: string,
    page: { page: number; mime: string; buffer: Buffer },
  ) => Promise<string>;
  concurrency?: number;
}

// ---- 空白页像素预判 ---------------------------------------------------------
//
// pdf-to-img(@napi-rs/canvas)输出的 PNG: 8-bit 深度, 非隔行, truecolor(RGB)或
// truecolor+alpha(RGBA)。这里内置一个最小 PNG 解码器(node:zlib + 标准 unfilter),
// 只支持 8-bit/非隔行/灰度与真彩色——解码失败返回 null(按非空白处理, 绝不因
// 预判失败而漏检)。

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
/** 防御性解码上限(像素总数); 超过视为异常输入返回 null。 */
const MAX_DECODE_PIXELS = 20_000_000;
/** 任一通道低于该值视为非白像素。 */
const NON_WHITE_LEVEL = 240;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 8-bit 非隔行 PNG 并返回非白像素占比。无法安全解码时返回 null。
 * 导出供单元测试直接喂手工构造的 PNG。
 */
export function pngNonWhiteRatio(buf: Buffer): number | null {
  try {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = 0;
    const idat: Buffer[] = [];
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        if (data.length < 13) return null;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8]!;
        colorType = data[9]!;
        interlace = data[12]!;
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      off += 12 + len;
    }
    const channels = PNG_CHANNELS[colorType] ?? 0;
    if (
      width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0 ||
      channels === 0 || width * height > MAX_DECODE_PIXELS || idat.length === 0
    ) {
      return null;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const out = Buffer.allocUnsafe(stride * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]!;
      const srcStart = y * (stride + 1) + 1;
      const cur = out.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
      if (filter === 0) {
        cur.set(raw.subarray(srcStart, srcStart + stride));
      } else if (filter === 1) {
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? cur[i - channels]! : 0;
          cur[i] = (raw[srcStart + i]! + left) & 0xff;
        }
      } else if (filter === 2) {
        for (let i = 0; i < stride; i++) {
          cur[i] = (raw[srcStart + i]! + (prev ? prev[i]! : 0)) & 0xff;
        }
      } else if (filter === 3) {
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? cur[i - channels]! : 0;
          cur[i] = (raw[srcStart + i]! + ((left + (prev ? prev[i]! : 0)) >> 1)) & 0xff;
        }
      } else if (filter === 4) {
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? cur[i - channels]! : 0;
          const up = prev ? prev[i]! : 0;
          const upLeft = prev && i >= channels ? prev[i - channels]! : 0;
          cur[i] = (raw[srcStart + i]! + paeth(left, up, upLeft)) & 0xff;
        }
      } else {
        return null;
      }
    }
    let nonWhite = 0;
    for (let i = 0; i < stride * height; i += channels) {
      let isWhite: boolean;
      if (channels === 4) {
        isWhite = out[i + 3]! === 0 || (
          out[i]! >= NON_WHITE_LEVEL && out[i + 1]! >= NON_WHITE_LEVEL && out[i + 2]! >= NON_WHITE_LEVEL
        );
      } else if (channels === 3) {
        isWhite = out[i]! >= NON_WHITE_LEVEL && out[i + 1]! >= NON_WHITE_LEVEL && out[i + 2]! >= NON_WHITE_LEVEL;
      } else if (channels === 2) {
        isWhite = out[i + 1]! === 0 || out[i]! >= NON_WHITE_LEVEL;
      } else {
        isWhite = out[i]! >= NON_WHITE_LEVEL;
      }
      if (!isWhite) nonWhite += 1;
    }
    return nonWhite / (width * height);
  } catch {
    return null;
  }
}

// ---- VLM 版面清点 prompt(原型验证过的形态, 设计文档 §3) --------------------

export function buildUnitDetectPrompt(): string {
  return [
    '你是供应链单据版面清点器。图片是一份多单据拼版文件中的一页。请清点该页上独立完整的业务单据区域。',
    '',
    '清点规则:',
    '- 数出该页独立完整业务单据的数量; 并排、堆叠、拼贴的照片都各算 1 份独立单据。',
    '- 不把印章、logo、页眉页脚、表格中的单行当作单据。',
    '- 一张化验报表内含多个样品行 = 1 个单据(不要按样品拆分)。',
    '- 化验报告 = 检验机构出具的单批次检验结果, 一个批次一份报告, 有检验机构名称/检验专用章/报告编号, 指标按基准(ar/ad/daf)多行。',
    '- 质检汇总表 = 收货方编制的二次汇总, 每一行是一个批次(或一车)的指标(行首为批次号/车号/日期), 列头同时含重量列与质量指标列, 末尾常有合计/汇总行; 同一页出现多行批次数据+合计 → 质检汇总表, 不要标成质检报告; 整页质检汇总表 = 1 个单据。',
    '- 标题含"化验分析报表/化验报表/煤质化验"但版面为多行批次数据+合计行的, 是质检汇总表(收货方汇总), 严禁仅凭标题"化验"二字判成化验报告/质检报告; 化验报告的判定依据是检验机构署名/检验专用章/报告编号/样品编号/CMA 标志, 不是标题。',
    '- 汽运磅单 = 汽车/汽运过磅, 单车一张(针打小票或照片), 标题常为"计量单/过磅单/汽车衡计量单", 最强判据是"车牌号"字段及省份汉字车牌(如 冀EB6666、云Q27006), 含车牌号的单车票据必为汽运磅单; 关键字: 汽车衡/地磅/车牌号/汽车牌号/空车/重车, 单据只对应一辆车。',
    '- 轨道衡称重单 = 铁路火车计量, 多行表格每行一节车厢/车皮, 关键字: 轨道衡/火车/车皮/车厢/列数。',
    '- 含"汽车/车牌号"且单车结构的必为汽运磅单, 严禁标轨道衡。',
    '- 标题或首部含"合同"/"协议"的整页文书是 1 份 formType=合同 的单据(补充合同/补充协议也属合同)。',
    '- 合同/协议等长文书的条款续页(整页连续正文、页脚页码如 2/7、无新单据标题或独立单号)不是独立单据, 输出 units: []。',
    '- 合同正文内的表格(价格表/检验条款表/结算表)是合同的一部分, 不是独立单据, 不得输出为 数据表格。',
    '- 每个区域给 bbox(归一化坐标 {x,y,w,h}, 原点左上, 取值 0.0-1.0)。',
    '- rotationDeg 只允许 0/90/180/270: 该区域内容需顺时针旋转多少度才能正立阅读。',
    '- 照片横放(文字呈横向)必须报 90 或 270; 上下颠倒(文字倒立)必须报 180。',
    '- 竖版纸面上横躺的表格/截屏/票据照片是常见形态, 遇到必须报 90 或 270, 不得报 0。',
    '- 90 与 270 的区分: 内容顶部朝左(内容从正立逆时针转了90°横躺, 需顺时针转90°正立) → 报 90; 内容顶部朝右(内容从正立顺时针转了90°横躺, 需顺时针转270°正立) → 报 270。',
    '- 实操判据: 看横排文字行的走向/数字串的阅读方向, 配合"内容顶部在哪一侧"交叉验证。',
    '- 0 只表示"确认内容正立", 不允许因为"拿不准"而默认 0; 判断依据是文字/数字的阅读方向, 不是印章或表格线。',
    `- formType 只允许以下值之一: ${UNIT_FORM_TYPES.join(' / ')}。`,
    '- evidence 给出该区域可见的关键短语(标题/单号/单位名等)。',
    '- identifierOrNull 给该单据的单号/报告编号; 区域内可见则原样给出, 不可见为 null。',
    '- confidence 为自评置信度 0.0-1.0; 模糊/拿不准给较低值。',
    '- 整页无业务内容(空白页)输出 units: []。',
    '- unitIndex 按该页阅读顺序(上到下、左到右)从 1 开始编号。',
    '',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。输出结构:',
    '{"units":[{"unitIndex":1,"formType":"质检报告","confidence":0.95,',
    '"bbox":{"x":0.01,"y":0.03,"w":0.48,"h":0.94},"rotationDeg":0,',
    '"evidence":"检测报告 报告编号 HX-2026-081","identifierOrNull":"HX-2026-081"}]}',
  ].join('\n');
}

/** 单页 VLM 输出的一个区域(已结构校验, bbox 未加 padding)。 */
interface RawRegion {
  formType: string;
  confidence: number;
  bbox: UnitBBox;
  rotationDeg: number;
  evidence: string;
  identifier: string | null;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function normalizeBBox(v: unknown): UnitBBox | null {
  if (v === null || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const x = clamp01(num(b.x));
  const y = clamp01(num(b.y));
  const w = clamp01(num(b.w ?? b.width));
  const h = clamp01(num(b.h ?? b.height));
  // 结构性 sanity: 过小的区域是印章/logo 误检, 丢弃。
  if (w < 0.02 || h < 0.02) return null;
  return { x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h };
}

function normalizeRotation(v: unknown): number {
  const r = num(v);
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

/** 容忍输出形状差异: 缺字段补默认, 坏区域丢弃; units 非数组按空页处理。 */
function parsePageUnits(content: string): RawRegion[] {
  const parsed: unknown = JSON.parse(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VLM 清点输出不是 JSON 对象');
  }
  const src = parsed as Record<string, unknown>;
  const list = src.units;
  if (!Array.isArray(list)) return [];
  const out: RawRegion[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const u = item as Record<string, unknown>;
    const bbox = normalizeBBox(u.bbox);
    if (!bbox) continue;
    let formType = typeof u.formType === 'string' && u.formType.length > 0 ? u.formType : '其他';
    // 未知词表标签收敛为 其他, 防止 清点器 杜撰类型绕过下游守卫。
    if (!(UNIT_FORM_TYPES as readonly string[]).includes(formType)) {
      formType = '其他';
    }
    if (formType === '空白页') continue;
    const idRaw = u.identifierOrNull ?? u.identifier;
    const identifier =
      typeof idRaw === 'string' && idRaw.trim().length > 0 ? idRaw.trim() : null;
    out.push({
      formType,
      confidence: Math.min(1, Math.max(0, num(u.confidence))),
      bbox,
      rotationDeg: normalizeRotation(u.rotationDeg),
      evidence: typeof u.evidence === 'string' ? u.evidence.slice(0, 200) : '',
      identifier,
    });
  }
  return out;
}

function padBBox(b: UnitBBox): UnitBBox {
  const x = clamp01(b.x - BBOX_PADDING);
  const y = clamp01(b.y - BBOX_PADDING);
  return {
    x,
    y,
    w: Math.min(clamp01(b.w + BBOX_PADDING * 2), 1 - x),
    h: Math.min(clamp01(b.h + BBOX_PADDING * 2), 1 - y),
  };
}

/** 单号归一(去空白): OCR 空格噪声下 "103 84417" 与 "10384417" 视为同号。 */
function normalizeIdentifier(id: string): string {
  return id.replace(/\s+/g, '');
}

// ---- 检测主流程 -------------------------------------------------------------

/** 逐页清点结果(内部中间态)。 */
interface PageDetection {
  page: number;
  nonWhiteRatio: number | null;
  blank: boolean;
  regions: RawRegion[];
}

async function detectPage(
  page: RenderedPage,
  deps: DetectUnitsDeps,
): Promise<PageDetection> {
  const ratio = pngNonWhiteRatio(page.buffer);
  const blank = ratio !== null && ratio < BLANK_NON_WHITE_RATIO;
  if (blank) return { page: page.page, nonWhiteRatio: ratio, blank, regions: [] };
  const call =
    deps.call ??
    // 2026-09-02: 批量拆分逐页清点复用 vlmCall, 但以 vlm_batch_split 记账区分
    // 于表单分类(vlm_classify), 便于审计页级清点用量。
    ((p: string, pg: { mime: string; buffer: Buffer }) => vlmCall(p, pg, 'vlm_batch_split'));
  const prompt = buildUnitDetectPrompt();
  const once = async (p: string): Promise<RawRegion[]> =>
    parsePageUnits(await call(p, { page: page.page, mime: page.mime, buffer: page.buffer }));
  try {
    return { page: page.page, nonWhiteRatio: ratio, blank, regions: await once(prompt) };
  } catch (first) {
    const hint = first instanceof Error ? first.message : String(first);
    return {
      page: page.page,
      nonWhiteRatio: ratio,
      blank,
      regions: await once(`${prompt}\n\n上次输出无法使用(${hint})。必须严格输出规定 JSON。`),
    };
  }
}

/** 固定并发的工作池(保持页序: 结果按下标回填)。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 跨页续表合并: 相邻页 + 同 formType + 同(非空)单号 → 一个逻辑单据。
 * 保守规则——单号为空不合并(两份匿名磅单背靠背会被错并)。
 *
 * 合同例外(2026-09-02 双章合同事故修复): 合同首页带 合同编号, 续页单号为
 * null —— 单号不得阻断同一份合同内的相邻页合并; 但两份背靠背的不同合同
 * (两首页单号均非空且不同)仍须保持分离。故对 formType=合同 额外放开一条
 * 相邻页合并: 只要不是"双方单号均非空且归一后不同"即合并。
 */
function mergeUnits(pages: PageDetection[]): DetectedUnit[] {
  interface OpenUnit {
    formType: string;
    confidence: number;
    identifier: string | null;
    evidence: string;
    pageStart: number;
    pageEnd: number;
    rotationDeg: number;
    rawRegions: Array<{ page: number; bbox: UnitBBox; rotationDeg: number }>;
  }
  const open: OpenUnit[] = [];
  for (const page of pages) {
    // 页内阅读顺序: 上到下、左到右。
    const regions = [...page.regions].sort(
      (a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x,
    );
    for (const r of regions) {
      let merged = false;
      if (r.identifier !== null) {
        const key = normalizeIdentifier(r.identifier);
        const candidates = open.filter(
          (u) =>
            u.formType === r.formType &&
            u.identifier !== null &&
            normalizeIdentifier(u.identifier) === key &&
            u.pageEnd === page.page - 1,
        );
        if (candidates.length === 1) {
          const u = candidates[0]!;
          u.pageEnd = page.page;
          u.confidence = Math.min(u.confidence, r.confidence);
          u.rawRegions.push({ page: page.page, bbox: r.bbox, rotationDeg: r.rotationDeg });
          merged = true;
        }
      }
      // 合同例外: 续页单号为 null 时, 只要不是"双方单号均非空且归一后不同"
      // (即两份背靠背的不同合同), 就并入最后一个打开的合同 unit。
      if (!merged && r.formType === '合同') {
        const last = open[open.length - 1];
        const idsDiffer =
          last !== undefined &&
          last.formType === '合同' &&
          last.identifier !== null &&
          r.identifier !== null &&
          normalizeIdentifier(last.identifier) !== normalizeIdentifier(r.identifier);
        if (
          last !== undefined &&
          last.formType === '合同' &&
          last.pageEnd === page.page - 1 &&
          !idsDiffer
        ) {
          last.pageEnd = page.page;
          last.confidence = Math.min(last.confidence, r.confidence);
          last.rawRegions.push({ page: page.page, bbox: r.bbox, rotationDeg: r.rotationDeg });
          merged = true;
        }
      }
      if (!merged) {
        open.push({
          formType: r.formType,
          confidence: r.confidence,
          identifier: r.identifier,
          evidence: r.evidence,
          pageStart: page.page,
          pageEnd: page.page,
          rotationDeg: r.rotationDeg,
          rawRegions: [{ page: page.page, bbox: r.bbox, rotationDeg: r.rotationDeg }],
        });
      }
    }
  }
  // 全局排序: 先按起始页; 页内创建顺序即阅读顺序(稳定排序保持)。
  open.sort((a, b) => a.pageStart - b.pageStart);

  // 整本"一份连续文书"守卫(2026-09-02 双章合同事故): 同一份合同被扫描两遍
  // (中间夹空白页)时, 逐页合并会因空白页断开而拆成多份。若全部 unit 都是
  // 合同、且所有非空单号归一后相同(允许 null, 如续页), 则视为同一份合同被
  // 重复扫描进一个文件, 折叠为 1 个 unit —— 灰度入口的 units.length<=1 门
  // 据此把整本路由回 legacy 单文档路径, 合同永不拆分。
  if (
    open.length >= 2 &&
    open.every((u) => u.formType === '合同')
  ) {
    const normIds = open
      .map((u) => (u.identifier === null ? null : normalizeIdentifier(u.identifier)))
      .filter((id): id is string => id !== null);
    const allSame = normIds.every((id) => id === normIds[0]);
    if (allSame) {
      const first = open[0]!;
      const collapsed: OpenUnit = {
        formType: '合同',
        confidence: Math.min(...open.map((u) => u.confidence)),
        identifier: open.find((u) => u.identifier !== null)?.identifier ?? null,
        evidence: first.evidence,
        pageStart: Math.min(...open.map((u) => u.pageStart)),
        pageEnd: Math.max(...open.map((u) => u.pageEnd)),
        rotationDeg: first.rotationDeg,
        rawRegions: open.flatMap((u) => u.rawRegions),
      };
      open.length = 0;
      open.push(collapsed);
    }
  }

  return open.map((u, i) => {
    const regions = u.rawRegions.map((r) => ({ ...r, bbox: padBBox(r.bbox) }));
    return {
      unitIndex: i + 1,
      formType: u.formType,
      confidence: u.confidence,
      identifier: u.identifier,
      evidence: u.evidence,
      pageStart: u.pageStart,
      pageEnd: u.pageEnd,
      bbox: regions.length === 1 ? regions[0]!.bbox : null,
      rotationDeg: u.rotationDeg,
      regions,
    };
  });
}

/**
 * 检测一个 PDF 的全部逻辑单据。逐页 150 DPI 渲染 → 空白预判 → VLM 清点,
 * 按页并发(默认 4)。超页数上限抛 BatchSplitPageLimitError(灰度入口显式失败);
 * 渲染失败/清点异常抛普通错误(灰度入口回落旧路径, 永不劣于现状)。
 */
export async function detectDocumentUnits(
  input: { sourcePath: string; maxPages?: number },
  deps: DetectUnitsDeps = {},
): Promise<DetectDocumentUnitsResult> {
  const render = deps.renderPages ?? renderPdfPages;
  const pages = await render(input.sourcePath);
  const maxPages = input.maxPages ?? Number.POSITIVE_INFINITY;
  if (pages.length > maxPages) {
    throw new BatchSplitPageLimitError(pages.length, maxPages);
  }
  const t0 = performance.now();
  const detections = await mapWithConcurrency(pages, deps.concurrency ?? 4, (p) => detectPage(p, deps));
  const units = mergeUnits(detections);
  const blankPages = detections.filter((d) => d.blank).length;
  console.log(
    `[perf-batch-split] ${input.sourcePath} pages=${pages.length} blank=${blankPages} ` +
    `units=${units.length} ${Math.round(performance.now() - t0)}ms`,
  );
  return {
    units,
    pages: detections.map((d) => ({
      page: d.page,
      nonWhiteRatio: d.nonWhiteRatio,
      blank: d.blank,
      unitCount: d.regions.length,
    })),
  };
}

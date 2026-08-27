// P3 存量合同台账修复(reprocessContracts 脚本)的候选选择/分桶纯函数。
//
// 背景(dev 库实测): 31 份 doc_type=合同 文档缺 contract_ledger 行, 分三类 --
//   1) parse_status='uploaded'  storage-only 老上传, 从未跑处理管道 -> 全管道;
//   2) parsed + extraction ok 但无台账 -> 用现有 extractions.fields 补写台账
//      (不重跑 LLM 抽取 -- 浪费且可能改变结果; 启动回填 findBackfillCandidates
//      只认 extraction 非 ok, 盖不到这类);
//   3) parse failed + 有 extraction 行(fields 可用, 无 block_model) -> 同 2。
// 本模块只放"挑候选 + 分桶"的可测逻辑; DB 查询与管道执行在脚本薄壳内。

/** 候选行投影(SQL 查询结果的最小形状; has* 由 EXISTS 子查询给出)。 */
export interface RepairCandidateRow {
  id: string;
  docType: string;
  parseStatus: string | null;
  extractionStatus: string | null;
  /** documents.id 在 extractions 表是否有行(不论状态)。 */
  hasExtractionRow: boolean;
  /** documents.id 在 contract_ledger 表是否已有行(有则一律跳过)。 */
  hasLedgerRow: boolean;
}

/**
 * full-pipeline = 完整 解析->分类->抽取->台账(ensureDocumentExtracted);
 * ledger-only   = 仅用现有抽取字段补写台账(buildLedgerEntryFromExtraction upsert);
 * skip          = 不动(已有台账 / 状态组合不可判定 / 属其它回填职责)。
 */
export type RepairBucket = 'full-pipeline' | 'ledger-only' | 'skip';

export function bucketContractDoc(row: RepairCandidateRow): RepairBucket {
  // 护栏优先: 已有台账的一律跳过(幂等重跑安全网, 不依赖查询去重)。
  if (row.hasLedgerRow) return 'skip';
  if (row.parseStatus === 'uploaded') return 'full-pipeline';
  const extracted = row.extractionStatus === 'ok' || row.hasExtractionRow;
  if (row.parseStatus === 'parsed' && row.extractionStatus === 'ok' && row.hasExtractionRow) {
    return 'ledger-only';
  }
  if (row.parseStatus === 'failed' && extracted) return 'ledger-only';
  return 'skip';
}

/**
 * 合同子树的全部 doc_type 名(含根 合同 与所有后代层, 如 补充合同/补充协议)。
 * 提单/装箱单这类别名挂在履约凭证分支, 天然不在结果内。不过滤 isActive:
 * 存量文档可能携带已置灰类型的 doc_type 值, 修复脚本要能命中它们。
 */
export function collectContractDocTypeNames(
  types: Array<{ kind: string; name: string; parentId: string | null }>,
  rootName = '合同',
): string[] {
  const byParent = new Map<string, string[]>();
  for (const t of types) {
    if (t.kind !== 'doc_type') continue;
    const key = t.parentId ?? '';
    const list = byParent.get(key) ?? [];
    list.push(t.name);
    byParent.set(key, list);
  }
  const out: string[] = [];
  const stack = [rootName];
  while (stack.length) {
    const name = stack.pop()!;
    out.push(name);
    for (const child of byParent.get(`dt-${name}`) ?? []) stack.push(child);
  }
  return out;
}

/** 分桶统计(供脚本打印 attempted 分布)。 */
export function summarizeBuckets(rows: RepairCandidateRow[]): Record<RepairBucket, number> {
  const s: Record<RepairBucket, number> = { 'full-pipeline': 0, 'ledger-only': 0, skip: 0 };
  for (const r of rows) s[bucketContractDoc(r)] += 1;
  return s;
}

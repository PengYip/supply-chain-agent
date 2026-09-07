// as-of 双时间轴查询谓词（本体建模技术备忘 §4 的 SQL 语义, 逐字对应）:
//   业务时间: 当时为真的事实(valid_at <= t 且尚未失效)
//   系统时间: 当时我们知道什么(ingested_at <= t, 审计/月报复现口径)
// 谓词与表无关: ontology_edges 与 trade_facts 共用; sql 用 ? 占位,
// Postgres 侧经 numberPlaceholders 转 $n。
export interface AsOfPredicate {
  sql: string;
  params: string[];
}

export function asOfBusinessTime(t: string): AsOfPredicate {
  const iso = normalizeIsoUtc(t);
  return { sql: 'valid_at <= ? AND (invalid_at IS NULL OR invalid_at > ?)', params: [iso, iso] };
}

export function asOfSystemTime(t: string): AsOfPredicate {
  return { sql: 'ingested_at <= ?', params: [normalizeIsoUtc(t)] };
}

/** UTC ISO 归一(毫秒精度)。SQLite TEXT 列字典序=时间序依赖统一格式。 */
export function normalizeIsoUtc(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const t = d.getTime();
  if (Number.isNaN(t)) throw new Error(`asof: invalid datetime "${String(input)}"`);
  return new Date(t).toISOString();
}

/** '?' 占位转 PG '$n' 占位(谓词 sql 内无字符串字面量, 安全)。 */
export function numberPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

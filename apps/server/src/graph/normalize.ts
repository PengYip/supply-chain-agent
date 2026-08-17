/**
 * Graph name normalization (design 2026-08-17 §5). Neo4j 实体按 (kind, name)
 * 精确 MERGE，写入前必须归一化：去首尾/内部空白（含全角 U+3000）+ 剥常见公司
 * 后缀，使 "中石化集团有限公司" 与 "中石化" 收敛到同一 Party 节点。合同号不含
 * 这些后缀，同一函数处理无副作用。
 */

// 最长优先：'集团有限公司' 必须先于 '集团'/'有限公司' 被剥。
const SUFFIXES = ['股份有限公司', '有限责任公司', '集团有限公司', '集团公司', '有限公司', '集团'];

export function normalizeName(raw: string): string {
  let s = (raw ?? '').replace(/[\s\u3000]+/g, '').trim();
  if (!s) return '';
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of SUFFIXES) {
      // s.length > suf.length：后缀即全名时保留，避免剥成空串。
      if (s.length > suf.length && s.endsWith(suf)) {
        s = s.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

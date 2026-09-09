// 商品规格归一函数（spec 2026-09-09 决策 #9，normalizeName 的商品版）。
// 登记照存原文，不做强制改写；本函数供匹配侧比对双方归一值：
//   - Phase 1：种子脚本幂等键 normalizeSpec(name)+normalizeSpec(spec)
//   - Phase 2（spec §11）：匹配通道 2 的归一键精确比对依赖此函数
// 只依赖 zod 同代的纯 JS（无 node 内建），可被前端复用。
//
// 归一规则（异写收敛的最小集）：
//   1) NFKC 折全半角（全角字母/数字/符号 -> 半角）
//   2) 去全部空白（首尾/内部/全角空格）
//   3) 乘号族统一：x X * × -> *
//   4) 小写化
const MULTIPLY_CHARS = /[*×xX]/g;

export function normalizeSpec(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(MULTIPLY_CHARS, '*')
    .toLowerCase();
}

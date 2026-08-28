// 空值语义工具(spec 2026-08-28): 模板保底补齐后, 空串字段 == 原文缺失。
// 下游消费者必须把空串当作"字段不存在", 不得让空串遮蔽回退链上的有效值,
// 也不得把空串数值化为 0 参与统计。

/** 空值判定: undefined/null/空串/纯空白 视为缺失。 */
export function isEmptyValue(v: string | number | undefined | null): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim().length === 0);
}

/** 回退链取第一个非空值; 全空返回 undefined(null 视同缺失, 不透出)。 */
export function firstNonEmpty(
  values: Array<string | number | undefined | null>,
): string | number | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim().length === 0)) return v;
  }
  return undefined;
}

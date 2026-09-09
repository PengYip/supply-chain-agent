// 通用 zod 字段级错误投影：flatten 的 fieldErrors + unrecognized_keys 归位到具体字段
// （zod v3 对未知字段的 issue path 为空，直接 flatten 会丢字段定位，表单无法回显）。
// 多段路径取叶子段作键（如 change 端点 payload.role -> 'role'），与表单字段名对齐。
import type { z } from 'zod';

export function fieldLevelErrors(error: z.ZodError): {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
} {
  const flat = error.flatten();
  const fieldErrors: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(flat.fieldErrors)) {
    if (messages) fieldErrors[key] = messages;
  }
  for (const issue of error.issues) {
    // 多段路径: flatten 只按 path[0] 归位会丢叶子字段, 取叶子段回显。
    if (issue.path.length > 1 && issue.code !== 'unrecognized_keys') {
      (fieldErrors[String(issue.path[issue.path.length - 1])] ??= []).push(issue.message);
    }
    if (issue.code === 'unrecognized_keys' && 'keys' in issue) {
      for (const key of issue.keys) {
        (fieldErrors[key] ??= []).push(`未注册字段：${key}`);
      }
    }
  }
  return { formErrors: flat.formErrors, fieldErrors };
}

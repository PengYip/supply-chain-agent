// 通用 zod 字段级错误投影：flatten 的 fieldErrors + unrecognized_keys 归位到具体字段
// （zod v3 对未知字段的 issue path 为空，直接 flatten 会丢字段定位，表单无法回显）。
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
    if (issue.code === 'unrecognized_keys' && 'keys' in issue) {
      for (const key of issue.keys) {
        (fieldErrors[key] ??= []).push(`未注册字段：${key}`);
      }
    }
  }
  return { formErrors: flat.formErrors, fieldErrors };
}

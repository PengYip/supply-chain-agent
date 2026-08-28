// VLM 表单分类器(spec 2026-08-28 §4): 渲染页 -> {formType, confidence}。
// 只输出表单类型; route/业务类型由 formTypeRegistry 派生。调用模式与
// vlmAdapter 相同(原生 fetch + response_format json_object, 失败回灌重试 1 次)。
import { env } from '../env.js';

export interface ClassifyPage {
  mime: string;
  buffer: Buffer;
}

export type VlmCall = (prompt: string, page: ClassifyPage) => Promise<string>;

export async function vlmCall(prompt: string, page: ClassifyPage): Promise<string> {
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) throw new Error('VLM 未配置，无法分类');
  const url = `${env.VLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.VLM_API_KEY}` },
    body: JSON.stringify({
      model: env.VLM_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${page.mime};base64,${page.buffer.toString('base64')}` } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(env.VLM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`VLM /chat/completions 失败 (${res.status} ${res.statusText})`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('VLM 返回空内容');
  return content;
}

export function buildFormClassifyPrompt(formTypes: string[]): string {
  const list = formTypes.length > 0 ? formTypes : ['其他'];
  return [
    '你是供应链单据表单类型识别器。只依据图片判断这份文件的表单类型(它长什么样, 与业务系统无关)。',
    `表单类型只允许输出以下${list.length}个值之一: ${list.join(' / ')}。`,
    '判别特征:',
    '- 汽车过磅单票据: 针打票据/小票, 抬头为电厂或公司名, 含 毛重/皮重/净重/车号 字段。',
    '- 轨道衡称重记录: 表格多行, 每行一节车厢(车型/车号/毛重/皮重/净重), 常带红色印章。',
    '- 水尺计重单: 英文表单(DRAFT SURVEY REPORT), 含 DISPLACEMENT/WEIGHT OF CARGO。',
    '- 合同扫描件: 条款文本为主, 多为 A4 多页, 常有骑缝章; 含 甲乙方/标的/金额条款。',
    '- 化验报告: 质检指标表格(全水/灰分/挥发分/发热量等)。',
    '- 银行回单: 付款人/收款人/金额/入账日期。',
    '- 货权转移证明/结算单/发票/派船通知单/火运大票: 按各自标题与版面判断。',
    '- 完全无法判断时, 从清单中选择最接近的一个, 并给低 confidence。',
    'confidence 是自评置信度 0.0-1.0; 不确定就给较低值。',
    '严格以 JSON 输出, 不要包含任何注释或解释文字。',
    '输出结构: {"formType": "<清单中的一个>", "confidence": 0.9}',
  ].join('\n');
}

export interface FormClassifyResult {
  formType: string;
  confidence: number;
}

export async function classifyForm(
  input: { page: ClassifyPage; formTypes: string[] },
  deps: { call?: VlmCall } = {},
): Promise<FormClassifyResult> {
  const call = deps.call ?? vlmCall;
  const prompt = buildFormClassifyPrompt(input.formTypes);
  const once = async (p: string): Promise<FormClassifyResult> => {
    const content = await call(p, input.page);
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('VLM 分类输出不是 JSON 对象');
    }
    const src = parsed as Record<string, unknown>;
    if (typeof src.formType !== 'string' || !src.formType) throw new Error('VLM 分类输出缺 formType');
    const confidence = typeof src.confidence === 'number' ? src.confidence : 0;
    return { formType: src.formType, confidence };
  };
  try {
    return await once(prompt);
  } catch (first) {
    const hint = first instanceof Error ? first.message : String(first);
    return once(`${prompt}\n\n上次输出无法使用(${hint})。必须严格输出规定 JSON。`);
  }
}

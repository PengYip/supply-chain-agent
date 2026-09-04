// VLM 表单分类器(spec 2026-08-28 §4): 渲染页 -> {formType, confidence}。
// 只输出表单类型; route/业务类型由 formTypeRegistry 派生。调用模式与
// vlmAdapter 相同(原生 fetch + response_format json_object, 失败回灌重试 1 次)。
import { env } from '../env.js';
import { recordLlmCall } from '../harness/usageAudit.js';
import { emitVlmUsageSpan, vlmModelFor } from './vlmTelemetry.js';

export interface ClassifyPage {
  mime: string;
  buffer: Buffer;
}

export type VlmCall = (prompt: string, page: ClassifyPage) => Promise<string>;

/**
 * 非 2xx 响应 -> 抛错(行为与原 `new Error(...)` 一致: 同一消息文本、同一抛错
 * 时机), 但把 statusCode 与 responseBody 挂到错误对象上。responseBody 是百炼
 * OpenAI 兼容错误({"error":{code,message}})的唯一载体 —— 上层
 * classifyProviderError 依赖它做欠费/限流/内容安全等分类告警。
 */
export async function throwVlmHttpError(res: Response): Promise<never> {
  let responseBody: string | undefined;
  try {
    responseBody = await res.text();
  } catch {
    // body 不可读时保持 undefined, 分类退化为仅状态码匹配。
  }
  const err = new Error(`VLM /chat/completions 失败 (${res.status} ${res.statusText})`);
  Object.assign(err, { statusCode: res.status, responseBody });
  throw err;
}

export async function vlmCall(
  prompt: string,
  page: ClassifyPage,
  kind: 'vlm_classify' | 'vlm_batch_split' = 'vlm_classify',
): Promise<string> {
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) throw new Error('VLM 未配置，无法分类');
  const url = `${env.VLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.VLM_API_KEY}` },
      body: JSON.stringify({
        model: vlmModelFor(kind),
        // 2026-09-02: 关闭 thinking(推理 token 按输出计费, 确定性分类无需思考)。
        enable_thinking: false,
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
    if (!res.ok) await throwVlmHttpError(res);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('VLM 返回空内容');
    // Usage audit (2026-09-02): record the VLM call (form classification or
    // batch-split page detection). inputText is the prompt text only -- never
    // the base64 image payload. Fire-and-forget (recordLlmCall never throws).
    recordLlmCall({
      kind,
      model: vlmModelFor(kind),
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
      inputText: prompt,
      outputText: content,
      durationMs: Math.round(performance.now() - t0),
      status: 'ok',
    });
    // 2026-09-02: VLM 是裸 fetch, OTel 自动埋点盖不住, 手工 GenAI span 让
    // Langfuse 统一展示; prompt 仅文本不含 base64。fire-and-forget, 永不抛错。
    emitVlmUsageSpan({ kind, usage: data.usage, prompt, content });
    return content;
  } catch (e) {
    recordLlmCall({
      kind,
      model: vlmModelFor(kind),
      inputText: prompt,
      durationMs: Math.round(performance.now() - t0),
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    });
    emitVlmUsageSpan({ kind, prompt, err: e });
    throw e;
  }
}

export function buildFormClassifyPrompt(formTypes: string[]): string {
  const list = formTypes.length > 0 ? formTypes : ['其他'];
  return [
    '你是供应链单据表单类型识别器。只依据图片判断这份文件的表单类型(它长什么样, 与业务系统无关)。',
    `表单类型只允许输出以下${list.length}个值之一: ${list.join(' / ')}。`,
    '判别特征:',
    '- 汽车过磅单票据: 汽车/汽运过磅, 单车一张(针打小票或照片, 照片形态也算), 抬头为电厂或公司名, 标题常为"计量单/过磅单/汽车衡计量单", 最强判据是"车牌号"字段及省份汉字车牌(如 冀EB6666、云Q27006), 含车牌号的单车票据必为汽运磅单; 含 汽车衡/地磅/车牌号/毛重/皮重/净重 字段。',
    '- 轨道衡称重记录: 铁路火车计量, 表格多行每行一节车厢/车皮(车型/车号/毛重/皮重/净重), 关键字: 轨道衡/火车/车皮/车厢, 常带红色印章。',
    '- 水尺计重单: 英文表单(DRAFT SURVEY REPORT), 含 DISPLACEMENT/WEIGHT OF CARGO。',
    '- 合同扫描件: 条款文本为主, 多为 A4 多页, 常有骑缝章; 含 甲乙方/标的/金额条款。',
    '- 化验报告: 检验机构出具的单批次检验结果, 一个批次一份报告, 有检验机构名称/检验专用章/报告编号, 质检指标表格(全水/灰分/挥发分/发热量等), 指标按基准(ar/ad/daf)多行。',
    // B 方案判别规则(2026-09-03, 51 份样本内容验证): 与纯重量表的单一分界。
    '- 收货质检汇总表(下游收货数据): 收货方编制的二次汇总, 表格逐行同时有重量列(净重或毛重/皮重/净重)和质量列(水分/灰分/硫分/发热量等), 每一行是一个批次(或一车)的指标, 常带合计行; 只有重量列没有质量列的是过磅单/轨道衡。',
    '- 标题含"化验分析报表/化验报表/煤质化验"但版面为多行批次数据+合计行的, 是收货质检汇总表(收货方汇总), 严禁仅凭标题"化验"二字判成化验报告; 化验报告的判定依据是检验机构署名/检验专用章/报告编号/样品编号/CMA 标志, 不是标题。',
    '- 含"汽车/车牌号"且单车结构的必为汽车过磅单票据, 严禁标轨道衡称重记录。',
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

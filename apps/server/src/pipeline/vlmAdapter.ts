// VLM (vision-language model) 图片凭证解析适配器 (Phase A)。
//
// 业务凭证(银行回单/货权转移单/化验报告, jpg/png 照片)无法走文本解析路径
// (digitalAdapter 按 utf-8 读图片是乱码, OCR 回退仅限 .pdf)。本适配器用
// OpenAI 兼容 /chat/completions + image_url base64 + response_format json_object
// 做端到端提取(对旋转/印章/合并单元格凭证实测零错误, 延迟 18-131s/张)。
//
// 刻意不用 AI SDK: response_format json_object 的传法在 AI SDK 6 无封装,
// 原生 fetch 实测稳定。VLM_BASE_URL/API_KEY 未配置时抛明确错误(不静默降级);
// 图片仅限 jpg/jpeg/png 且单图 <=10MB。

import { env } from '../env.js';
import type { VoucherType } from './schemas/vouchers.js';
import { VOUCHER_PAGE_PROMPTS, VOUCHER_DOC_PROMPTS } from './schemas/vouchers.js';
import { throwVlmHttpError } from './vlmClassifier.js';

export interface VlmResult {
  voucherType: VoucherType;
  fields: Record<string, unknown>;
  字段置信度: Record<string, number>;
}

/** 允许的图片 MIME 类型(与扩展名 .jpg/.jpeg/.png 对应)。 */
export const ALLOWED_VOUCHER_MIME = new Set(['image/jpeg', 'image/png']);
/** 单图大小上限(字节)。 */
export const MAX_VOUCHER_IMAGE_BYTES = 10 * 1024 * 1024;

/** 扩展名 -> MIME 映射(ingestFile 分流用)。 */
export function mimeForExtension(ext: string): string | undefined {
  const e = ext.toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  return undefined;
}

const VLM_PROMPT = [
  '你是供应链业务凭证识别模型。请识别图片中的凭证类型并提取结构化字段。',
  '',
  '凭证类型与对应字段 schema:',
  '',
  '1. 货转单(货权转移单):',
  '   编号(字符串或null), 合同号(字符串,必填), 买方(字符串,必填), 卖方(字符串,必填),',
  '   交货日期(字符串,必填), 交货地点(字符串,必填), 交货总量_吨(数字,必填),',
  '   明细行(数组,必填,每项含: 煤种(字符串或null), 运输方式(字符串或null), 数量_吨(数字),',
  '   低位发热量_千卡(数字或null), 全硫(字符串或null), 暂估价_元每吨(数字或null),',
  '   含税总价_元(数字), 货款75_元(数字或null)),',
  '   合计含税总价_元(数字,必填), 日期(字符串或null)。',
  '',
  '2. 付款凭证(银行回单):',
  '   付款人名称(字符串,必填), 收款人名称(字符串,必填), 金额(数字,必填,单位元),',
  '   金额大写(字符串或null), 入账日期(字符串,必填), 回单编号(字符串或null),',
  '   附言(字符串或null), 付款人账号(字符串或null), 收款人账号(字符串或null)。',
  '',
  '3. 化验报告(入库化验与到港化验共用):',
  '   出具机构(字符串,必填), 报告编号(字符串或null), 送检单位(字符串或null),',
  '   委托方(字符串或null), 品名(字符串或null), 重量_吨(数字或null),',
  '   采样地点(字符串或null), 装卸地点(字符串或null), 检测日期(字符串,必填),',
  '   指标(数组或null,每项含: 基准(枚举 ar/ad/d/daf), 全水_百分比(数字或null),',
  '   灰分_百分比(数字或null), 挥发分_百分比(数字或null), 全硫_百分比(数字或null),',
  '   水分_百分比(数字或null), 低位发热量_MJ每kg(数字或null), 低位发热量_千卡每kg(数字或null))。',
  '',
  '规则:',
  '- 先判断凭证类型(货转单/化验报告/付款凭证), 再按对应 schema 输出; 无法归入三类时输出"其他"。',
  '- 图片中无法辨认的字段填 null, 严禁编造。',
  '- 金额/数量等数字字段输出为数字(去掉千分位逗号与货币符号)。',
  '- 字段置信度: 每个字段的识别置信度 0..1。',
  '',
  '严格以 JSON 输出, 结构:',
  '{"voucherType": "货转单|化验报告|付款凭证|其他", "fields": {按对应 schema}, "字段置信度": {字段名: 0.0-1.0}}',
].join('\n');

function normalizeVoucherType(v: unknown): VoucherType {
  if (v === '货转单' || v === '化验报告' || v === '付款凭证') return v;
  return '其他';
}

/** 容忍 VLM 输出形状差异(顶层 voucherType/fields/字段置信度 或嵌套)。 */
function normalizeVlmResult(parsed: unknown): VlmResult {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VLM 输出不是 JSON 对象');
  }
  const src = parsed as Record<string, unknown>;
  const fields = src.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('VLM 输出缺少 fields 对象');
  }
  const conf = src['字段置信度'] ?? src.fieldConfidence;
  if (conf === null || typeof conf !== 'object' || Array.isArray(conf)) {
    throw new Error('VLM 输出缺少 字段置信度 对象');
  }
  return {
    voucherType: normalizeVoucherType(src.voucherType ?? src['凭证类型']),
    fields: fields as Record<string, unknown>,
    字段置信度: conf as Record<string, number>,
  };
}

export interface VlmExtractOptions {
  /**
   * 解析后的后置校验(如 zod schema parse)。抛错时错误信息会追加到 prompt 并
   * 重试一次 -- 使 JSON.parse 失败与 schema 校验失败共享同一条重试路径。
   */
  validate?: (result: VlmResult) => void;
}

/**
 * 调用 VLM 提取图片凭证。失败策略: JSON.parse / validate 失败 -> 追加错误信息
 * 重试 1 次; 两次失败抛错。VLM 未配置时抛明确错误 'VLM 未配置，无法解析图片凭证'。
 */
export async function extractVoucher(
  buffer: Buffer,
  mime: string,
  opts: VlmExtractOptions = {},
): Promise<VlmResult> {
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) {
    throw new Error('VLM 未配置，无法解析图片凭证');
  }
  if (!ALLOWED_VOUCHER_MIME.has(mime)) {
    throw new Error(`不支持的图片类型 ${mime}，仅支持 jpg/jpeg/png`);
  }
  if (buffer.length > MAX_VOUCHER_IMAGE_BYTES) {
    throw new Error(`图片超过 10MB 上限(${buffer.length} 字节)，无法解析`);
  }

  const b64 = buffer.toString('base64');
  const url = `${env.VLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;

  const call = async (prompt: string): Promise<VlmResult> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.VLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.VLM_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(env.VLM_TIMEOUT_MS),
    });
    if (!res.ok) await throwVlmHttpError(res);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('VLM 返回空内容');
    const parsed: unknown = JSON.parse(content);
    const result = normalizeVlmResult(parsed);
    opts.validate?.(result);
    return result;
  };

  try {
    return await call(VLM_PROMPT);
  } catch (first) {
    const hint = first instanceof Error ? first.message : String(first);
    try {
      return await call(`${VLM_PROMPT}\n\n上次解析失败，请修正输出：${hint}`);
    } catch (second) {
      throw second instanceof Error ? second : new Error(String(second));
    }
  }
}

// ---- v2.1: 按已知类型的多图提取(spec 2026-08-28 §5) --------------------------
// 类型由路由确定(formTypeRegistry), prompt 按 VOUCHER_*_PROMPTS 注册表选取;
// 重量行类型(汽运磅单/轨道衡)用页级 prompt(逐页聚合), 其余用文档级 prompt。

export interface TypedImage {
  mime: string;
  buffer: Buffer;
}

export interface TypedVlmResult {
  fields: Record<string, unknown>;
  字段置信度: Record<string, number>;
}

export type TypedVlmCall = (prompt: string, images: TypedImage[]) => Promise<string>;

async function typedVlmFetch(prompt: string, images: TypedImage[]): Promise<string> {
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) {
    throw new Error('VLM 未配置，无法解析图片凭证');
  }
  for (const img of images) {
    if (!ALLOWED_VOUCHER_MIME.has(img.mime)) {
      throw new Error(`不支持的图片类型 ${img.mime}，仅支持 jpg/jpeg/png`);
    }
    if (img.buffer.length > MAX_VOUCHER_IMAGE_BYTES) {
      throw new Error(`图片超过 10MB 上限(${img.buffer.length} 字节)，无法解析`);
    }
  }
  const url = `${env.VLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.VLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.VLM_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mime};base64,${img.buffer.toString('base64')}` },
            })),
          ],
        },
      ],
      response_format: { type: 'json_object' },
    }),
      signal: AbortSignal.timeout(env.VLM_TIMEOUT_MS),
    });
    if (!res.ok) await throwVlmHttpError(res);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('VLM 返回空内容');
    return content;
  }

/** 容忍输出形状差异: 取 fields 对象与 字段置信度(缺省空对象, 不硬失败)。 */
function normalizeTypedResult(parsed: unknown): TypedVlmResult {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VLM 输出不是 JSON 对象');
  }
  const src = parsed as Record<string, unknown>;
  const fields = (src.fields ?? src) as Record<string, unknown>;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('VLM 输出缺少 fields 对象');
  }
  const conf = src['字段置信度'] ?? src.fieldConfidence ?? {};
  if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
    throw new Error('VLM 输出缺少 字段置信度 对象');
  }
  return { fields, 字段置信度: conf as Record<string, number> };
}

/**
 * 按已知凭证类型提取(prompt 注册表)。页级类型(汽运磅单/轨道衡称重单)输出单页行,
 * 由 pageRecords 聚合; 其余类型输出整单 schema。失败回灌重试 1 次, 两次失败抛错。
 */
export async function extractVoucherTyped(
  images: TypedImage[],
  docType: Exclude<VoucherType, '其他'>,
  opts: { call?: TypedVlmCall; validate?: (fields: Record<string, unknown>) => void } = {},
): Promise<TypedVlmResult> {
  if (images.length === 0) throw new Error('extractVoucherTyped 需要至少一张图片');
  const prompt =
    VOUCHER_PAGE_PROMPTS[docType] ?? VOUCHER_DOC_PROMPTS[docType];
  if (!prompt) throw new Error(`凭证类型 ${docType} 无注册 prompt`);
  const call = opts.call ?? typedVlmFetch;

  const once = async (p: string): Promise<TypedVlmResult> => {
    const content = await call(p, images);
    const parsed: unknown = JSON.parse(content);
    const result = normalizeTypedResult(parsed);
    opts.validate?.(result.fields);
    return result;
  };
  try {
    return await once(prompt);
  } catch (first) {
    const hint = first instanceof Error ? first.message : String(first);
    return once(`${prompt}\n\n上次解析失败，请修正输出(${hint})。必须严格输出规定 JSON。`);
  }
}

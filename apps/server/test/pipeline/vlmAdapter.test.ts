// vlmAdapter 单元测试: mock 全局 fetch 验证成功路径 / 重试 / 失败 / 未配置。
// env 是模块加载时解析的 zod 快照(可变对象), 测试内保存/恢复其值。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from '../../src/env.js';
import { extractVoucher, mimeForExtension } from '../../src/pipeline/vlmAdapter.js';

const saved = {
  base: env.VLM_BASE_URL,
  key: env.VLM_API_KEY,
  model: env.VLM_MODEL,
  timeout: env.VLM_TIMEOUT_MS,
};

function jsonResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

const okVlmContent = JSON.stringify({
  voucherType: '付款凭证',
  fields: {
    付款人名称: '山西焦煤集团有限责任公司',
    收款人名称: '内蒙古伊泰煤炭股份有限公司',
    金额: 2841620.27,
    金额大写: '贰佰捌拾肆万壹仟陆佰贰拾元零贰角柒分',
    入账日期: '2024-07-16',
  },
  字段置信度: { 付款人名称: 0.98, 收款人名称: 0.97, 金额: 0.99, 入账日期: 0.95 },
});

beforeEach(() => {
  env.VLM_BASE_URL = 'https://vlm.test';
  env.VLM_API_KEY = 'test-key';
  env.VLM_MODEL = 'test-model';
  env.VLM_TIMEOUT_MS = 5000;
});

afterEach(() => {
  env.VLM_BASE_URL = saved.base;
  env.VLM_API_KEY = saved.key;
  env.VLM_MODEL = saved.model;
  env.VLM_TIMEOUT_MS = saved.timeout;
  vi.unstubAllGlobals();
});

describe('extractVoucher', () => {
  it('成功路径: 返回归一化 VlmResult, 请求带 Bearer + image_url base64 + json_object', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(okVlmContent));
    vi.stubGlobal('fetch', fetchMock);

    const buf = Buffer.from('fake-image-bytes');
    const result = await extractVoucher(buf, 'image/jpeg');

    expect(result.voucherType).toBe('付款凭证');
    expect(result.fields['金额']).toBe(2841620.27);
    expect(result.字段置信度['金额']).toBe(0.99);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://vlm.test/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.response_format).toEqual({ type: 'json_object' });
    const content = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content[0]!.type).toBe('text');
    expect(content[1]!.type).toBe('image_url');
    expect(content[1]!.image_url!.url).toContain('data:image/jpeg;base64,');
  });

  it('JSON 解析失败 -> 追加错误信息重试 1 次 -> 成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('not-json{{'))
      .mockResolvedValueOnce(jsonResponse(okVlmContent));
    vi.stubGlobal('fetch', fetchMock);

    const result = await extractVoucher(Buffer.from('x'), 'image/png');
    expect(result.voucherType).toBe('付款凭证');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 第二次请求的 prompt 应包含上次失败信息。
    const [, init2] = fetchMock.mock.calls[1]!;
    const body2 = JSON.parse(init2.body as string);
    expect(body2.messages[0].content[0].text).toContain('上次解析失败');
  });

  it('两次失败 -> 抛错', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse('bad{{'))
      .mockResolvedValueOnce(jsonResponse('still-bad{{'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractVoucher(Buffer.from('x'), 'image/jpeg')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTTP 非 2xx -> 重试一次后抛错', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractVoucher(Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('VLM 未配置 -> 抛明确错误, 不发起请求', async () => {
    env.VLM_BASE_URL = undefined;
    env.VLM_API_KEY = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(extractVoucher(Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      'VLM 未配置，无法解析图片凭证',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('不支持的 MIME -> 抛错', async () => {
    await expect(extractVoucher(Buffer.from('x'), 'image/gif')).rejects.toThrow(/仅支持 jpg\/jpeg\/png/);
  });

  it('超过 10MB -> 抛错', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(extractVoucher(big, 'image/jpeg')).rejects.toThrow(/10MB/);
  });

  it('validate 回调抛错 -> 重试一次后抛错', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(okVlmContent))
      .mockResolvedValueOnce(jsonResponse(okVlmContent));
    vi.stubGlobal('fetch', fetchMock);

    const validate = vi.fn().mockImplementation(() => {
      throw new Error('schema 校验失败: 金额缺失');
    });
    await expect(
      extractVoucher(Buffer.from('x'), 'image/jpeg', { validate }),
    ).rejects.toThrow(/schema 校验失败/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('mimeForExtension', () => {
  it('映射 jpg/jpeg/png, 其他返回 undefined', () => {
    expect(mimeForExtension('jpg')).toBe('image/jpeg');
    expect(mimeForExtension('jpeg')).toBe('image/jpeg');
    expect(mimeForExtension('JPG')).toBe('image/jpeg');
    expect(mimeForExtension('png')).toBe('image/png');
    expect(mimeForExtension('pdf')).toBeUndefined();
  });
});
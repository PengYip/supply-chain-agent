// 方向分类探针单测(2026-09-04): 纯函数解析 + fetch 封装。全部 hermetic 无网络。
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseOrientationResponse,
  classifyOrientation,
  ORIENTATION_TIMEOUT_MS,
} from '../../src/pipeline/orientationClassifier.js';
import { env } from '../../src/env.js';

describe('parseOrientationResponse', () => {
  it('合法响应: ok=true + score + rotation_deg 透传', () => {
    expect(parseOrientationResponse({ ok: true, label: '90', score: 0.98, rotation_deg: 270 }))
      .toEqual({ rotationDeg: 270, score: 0.98 });
    expect(parseOrientationResponse({ ok: true, score: 0.9, rotation_deg: 0 }))
      .toEqual({ rotationDeg: 0, score: 0.9 });
  });

  it('ok=false -> null', () => {
    expect(parseOrientationResponse({ ok: false, score: 0.9, rotation_deg: 90 })).toBeNull();
  });

  it('缺字段(score/rotation_deg) -> null', () => {
    expect(parseOrientationResponse({ ok: true, score: 0.9 })).toBeNull();
    expect(parseOrientationResponse({ ok: true, rotation_deg: 90 })).toBeNull();
  });

  it('rotation_deg 非法(45) -> null', () => {
    expect(parseOrientationResponse({ ok: true, score: 0.9, rotation_deg: 45 })).toBeNull();
  });

  it('非 JSON 对象 -> null', () => {
    expect(parseOrientationResponse(null)).toBeNull();
    expect(parseOrientationResponse('x')).toBeNull();
    expect(parseOrientationResponse([1])).toBeNull();
    expect(parseOrientationResponse(undefined)).toBeNull();
  });
});

describe('classifyOrientation', () => {
  const SAVED_URL = env.ORIENTATION_API_URL;

  afterEach(() => {
    (env as { ORIENTATION_API_URL?: string }).ORIENTATION_API_URL = SAVED_URL;
  });

  it('未配置 ORIENTATION_API_URL -> null(不发起请求)', async () => {
    (env as { ORIENTATION_API_URL?: string }).ORIENTATION_API_URL = '';
    const fetchSpy = vi.fn();
    const r = await classifyOrientation({ base64: 'x', mime: 'image/png' }, { fetch: fetchSpy });
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('200 合法响应 -> 解析结果, 请求形状正确(POST {base}/orientation)', async () => {
    (env as { ORIENTATION_API_URL?: string }).ORIENTATION_API_URL = 'http://sidecar:8760';
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, label: '90', score: 0.98, rotation_deg: 270 }),
    });
    const r = await classifyOrientation({ base64: 'abc', mime: 'image/png' }, { fetch: fakeFetch });
    expect(r).toEqual({ rotationDeg: 270, score: 0.98 });
    const [url, init] = fakeFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://sidecar:8760/orientation');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ image_base64: 'abc', mime: 'image/png' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('非 200 -> null', async () => {
    (env as { ORIENTATION_API_URL?: string }).ORIENTATION_API_URL = 'http://sidecar:8760';
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const r = await classifyOrientation({ base64: 'abc', mime: 'image/png' }, { fetch: fakeFetch });
    expect(r).toBeNull();
  });

  it('JSON 解析失败 -> null', async () => {
    (env as { ORIENTATION_API_URL?: string }).ORIENTATION_API_URL = 'http://sidecar:8760';
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('bad json');
      },
    });
    const r = await classifyOrientation({ base64: 'abc', mime: 'image/png' }, { fetch: fakeFetch });
    expect(r).toBeNull();
  });

  it('fetch 抛错(超时/网络) -> null', async () => {
    (env as { ORIENTATION_API_URL?: string }).ORIENTATION_API_URL = 'http://sidecar:8760';
    const fakeFetch = vi.fn().mockRejectedValue(new Error('timeout'));
    const r = await classifyOrientation({ base64: 'abc', mime: 'image/png' }, { fetch: fakeFetch });
    expect(r).toBeNull();
  });

  it('超时常量 = 5000ms(契约锁定)', () => {
    expect(ORIENTATION_TIMEOUT_MS).toBe(5000);
  });
});
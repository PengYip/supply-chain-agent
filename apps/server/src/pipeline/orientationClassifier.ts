// 方向分类探针(2026-09-04): 本地 PaddleOCR 文档方向分类 sidecar。
//
// POST {ORIENTATION_API_URL}/orientation, JSON body {image_base64, mime}
// -> 200 {"ok":true,"label":"90","score":0.98,"rotation_deg":270}
// rotation_deg = 该图需顺时针旋转多少度才能正立(= 仓库 rotationDeg 语义,
// sidecar 已完成 PaddleOCR label->纠正角校准, 直接透传, 勿再换算)。
// 非 200 / 超时 / JSON 缺字段 / ok!==true / rotation_deg 非法 -> null,
// 调用方回落现状路径(双候选 + 检测方向先验择优), 永不劣化。

import { env } from '../env.js';

export interface OrientationImage {
  base64: string;
  mime: string;
}

export interface OrientationResult {
  rotationDeg: number;
  score: number;
}

/** 合法纠正角(与仓库 rotationDeg 同语义)。 */
const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

/** 探针超时(ms)。 */
export const ORIENTATION_TIMEOUT_MS = 5000;

/** 解析 sidecar 响应(纯函数, 供单测)。任何非法输入返回 null。 */
export function parseOrientationResponse(json: unknown): OrientationResult | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const src = json as Record<string, unknown>;
  if (src.ok !== true) return null;
  const score = src.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const rot = src.rotation_deg;
  if (typeof rot !== 'number' || !Number.isFinite(rot) || !VALID_ROTATIONS.has(rot)) return null;
  return { rotationDeg: rot, score };
}

/**
 * 调用方向分类 sidecar。任何失败(未配置/网络/超时/解析/非法角)返回 null。
 * deps.fetch 可注入(fake 供测试); 缺省用全局 fetch。
 */
export async function classifyOrientation(
  image: OrientationImage,
  deps: { fetch?: typeof fetch } = {},
): Promise<OrientationResult | null> {
  if (!env.ORIENTATION_API_URL) return null;
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${env.ORIENTATION_API_URL.replace(/\/+$/, '')}/orientation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_base64: image.base64, mime: image.mime }),
      signal: AbortSignal.timeout(ORIENTATION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseOrientationResponse(data);
  } catch {
    return null;
  }
}
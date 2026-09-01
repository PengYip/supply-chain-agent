// 手工构造最小 PNG(8-bit / 非隔行)供批量拆分器单元测试使用: 不依赖
// @napi-rs/canvas / pngjs 等第三方依赖, 行过滤可指定(None/Sub/Up/Avg/Paeth),
// 用于覆盖 batchSplit.pngNonWhiteRatio 的解码分支。
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c = CRC_TABLE[(c ^ b)!]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

export type Rgba = [number, number, number, number];

export interface BuildPngOptions {
  /** 行过滤类型(整页统一): 0=None 1=Sub 2=Up 3=Average 4=Paeth。 */
  filter?: number;
  /** 颜色类型: 6=RGBA(默认) 2=RGB 0=灰度 4=灰度+alpha。 */
  colorType?: 0 | 2 | 4 | 6;
}

/** 按像素函数生成 PNG。像素函数返回 RGBA; 非 RGBA 颜色类型自动取通道。 */
export function buildPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgba,
  opts: BuildPngOptions = {},
): Buffer {
  const filter = opts.filter ?? 0;
  const colorType = opts.colorType ?? 6;
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;

  function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  // 先生成未过滤的行数据, 再按 filter 类型做编码侧变换(解码端 unfilter 的
  // 逆运算), 否则 filter 字节形同虚设、测试只是巧合通过。
  const unfiltered = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = y * stride + x * channels;
      if (colorType === 6) {
        unfiltered[i] = r; unfiltered[i + 1] = g; unfiltered[i + 2] = b; unfiltered[i + 3] = a;
      } else if (colorType === 2) {
        unfiltered[i] = r; unfiltered[i + 1] = g; unfiltered[i + 2] = b;
      } else if (colorType === 4) {
        unfiltered[i] = r; unfiltered[i + 1] = a;
      } else {
        unfiltered[i] = r;
      }
    }
  }
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const idx = y * (stride + 1) + 1 + i;
      const cur = y * stride + i;
      const left = i >= channels ? unfiltered[cur - channels]! : 0;
      const up = y > 0 ? unfiltered[cur - stride]! : 0;
      const upLeft = y > 0 && i >= channels ? unfiltered[cur - stride - channels]! : 0;
      const v = unfiltered[cur]!;
      if (filter === 1) raw[idx] = (v - left) & 0xff;
      else if (filter === 2) raw[idx] = (v - up) & 0xff;
      else if (filter === 3) raw[idx] = (v - ((left + up) >> 1)) & 0xff;
      else if (filter === 4) raw[idx] = (v - paeth(left, up, upLeft)) & 0xff;
      else raw[idx] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

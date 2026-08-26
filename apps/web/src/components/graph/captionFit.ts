// 节点圆内文字截断(Neo4j Browser fitCaptionIntoCircle 思路的确定性重实现):
// 每行宽度上限 = 该行垂直偏移处的弦宽 - 水平内边距; 装不下断行,
// 达到行数上限仍有剩余则末行截断加省略号(U+2026)。
// 字宽用 em 近似(CJK=1.0/其余=0.62)而非 canvas measureText: 确定性、可单测。

const ELLIPSIS = '…';
/** 浮点容差: 抵消 0.62*11 这类乘法的表示误差(如 13.640000000000014)。 */
const EPSILON = 1e-6;

/** 单字符显示宽度(em 倍数): CJK 统一表意/标点/全角形式 = 1.0, 其余(ASCII/半角) = 0.62。 */
export function charEmWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const cjk =
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首~统一表意(含 0x3000 段标点)
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xff00 && code <= 0xffef); // 全角形式
  return cjk ? 1 : 0.62;
}

export interface FitCaptionOptions {
  /** 节点直径(px)。 */
  diameter: number;
  /** 字号(px)。 */
  fontSize: number;
  /** 行数上限, 默认 3。 */
  maxLines?: number;
  /** 行高倍数, 默认 1.1(与 G6 labelLineHeight 保持一致)。 */
  lineHeight?: number;
}

/** 距圆心垂直偏移 offset 处的内接弦长; 圆外返回 0。 */
function chordWidth(radius: number, offset: number): number {
  const sq = radius * radius - offset * offset;
  return sq <= 0 ? 0 : 2 * Math.sqrt(sq);
}

/**
 * 按每行宽度上限把文本贪心分批成行。
 * @param reserveEllipsis 末行为省略号预留 1em 宽度(截断模式); false 用于试探能否完整容纳。
 */
function greedyWrap(
  chars: string[],
  widths: number[],
  fontSize: number,
  reserveEllipsis: boolean,
): string[] {
  const lines: string[] = [];
  let rest = chars;
  for (let i = 0; i < widths.length; i += 1) {
    const isLast = i === widths.length - 1;
    const cap = isLast && reserveEllipsis ? widths[i]! - fontSize : widths[i]!;
    let w = 0;
    let count = 0;
    while (count < rest.length) {
      const next = charEmWidth(rest[count]!) * fontSize;
      if (w + next > cap + EPSILON) break;
      w += next;
      count += 1;
    }
    lines.push(rest.slice(0, count).join(''));
    rest = rest.slice(count);
    if (rest.length === 0) break;
  }
  if (rest.length > 0 && reserveEllipsis) {
    // 仍有剩余: 末行截断加省略号(cap<=0 时末行退化为单独的省略号)
    const last = lines.length - 1;
    lines[last] = `${lines[last]}${ELLIPSIS}`;
  }
  return lines;
}

/** 把名字裁进圆内: 完整装下时返回最小行数的断行结果; 否则取容量最大的行数截断加省略号。 */
export function fitCaption(name: string, options: FitCaptionOptions): string {
  const { diameter, fontSize, maxLines = 3, lineHeight = 1.1 } = options;
  if (!name) return '';
  const radius = diameter / 2;
  const chars = Array.from(name); // 按码点切分, 避免拆散代理对

  const widthsFor = (lineCount: number): number[] => {
    const widths: number[] = [];
    for (let i = 0; i < lineCount; i += 1) {
      const offset = Math.abs(i - (lineCount - 1) / 2) * fontSize * lineHeight;
      widths.push(Math.max(chordWidth(radius, offset) - fontSize, 0));
    }
    return widths;
  };

  // 1) 最小行数完整容纳
  for (let lc = 1; lc <= maxLines; lc += 1) {
    const lines = greedyWrap(chars, widthsFor(lc), fontSize, false);
    if (lines.join('').length === chars.length) return lines.join('\n');
  }
  // 2) 装不下: 取放置字符最多的行数, 末行截断加省略号
  let best = 1;
  let bestPlaced = -1;
  for (let lc = 1; lc <= maxLines; lc += 1) {
    const placed = greedyWrap(chars, widthsFor(lc), fontSize, false).join('').length;
    if (placed > bestPlaced) {
      bestPlaced = placed;
      best = lc;
    }
  }
  return greedyWrap(chars, widthsFor(best), fontSize, true).join('\n');
}
// captionFit 弦宽截断纯函数单测。数值断言基于:
// padding = fontSize*0.5, CJK 字宽 = 1.0*fontSize, ASCII = 0.62*fontSize。
import { describe, expect, it } from 'vitest';
import { charEmWidth, fitCaption } from '../src/components/graph/captionFit';

describe('charEmWidth', () => {
  it('CJK 与全角为 1.0, ASCII 为 0.62', () => {
    expect(charEmWidth('甲')).toBe(1);
    expect(charEmWidth('。')).toBe(1); // 0x3002 CJK 标点
    expect(charEmWidth('Ａ')).toBe(1); // 0xFF21 全角
    expect(charEmWidth('A')).toBe(0.62);
    expect(charEmWidth('5')).toBe(0.62);
  });
});

describe('fitCaption', () => {
  it('空输入返回空串', () => {
    expect(fitCaption('', { diameter: 30, fontSize: 11 })).toBe('');
  });

  it('短名单行原样返回', () => {
    // 直径30/字号11: 中心行宽 = 30 - 11 = 19px; 单个 CJK 11px、两个 ASCII 13.64px 均可容纳
    expect(fitCaption('甲', { diameter: 30, fontSize: 11 })).toBe('甲');
    expect(fitCaption('AB', { diameter: 30, fontSize: 11 })).toBe('AB');
    // 直径44: 中心行宽 33px, 恰好 3 个 CJK
    expect(fitCaption('一二三', { diameter: 44, fontSize: 11 })).toBe('一二三');
  });

  it('超长文本断行为多行并截断', () => {
    // 直径44 三行布局: 行偏移 ±12.1/0/±12.1 → cap = 25.75/33/25.75 → 容量 2+3+2=7 字 < 9 字
    // → 截断模式, 末行 cap=14.75 只装 1 字 + 省略号
    const out = fitCaption('一二三四五六七八九', { diameter: 44, fontSize: 11 });
    const lines = out.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('一二');
    expect(lines[1]).toBe('三四五');
    expect(lines[2]).toBe('六…');
  });

  it('装不下时行数不超过上限且末行以省略号结尾', () => {
    // 直径30: L=2 每行 1 个 CJK(共2字)为最大容量, 8 字输入必然截断
    const out = fitCaption('一二三四五六七八', { diameter: 30, fontSize: 11 });
    const lines = out.split('\n');
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('ASCII 单行容纳数多于 CJK', () => {
    const cjk = fitCaption('一二三四五六七八九十一二三', { diameter: 30, fontSize: 11 });
    const ascii = fitCaption('abcdefgh', { diameter: 30, fontSize: 11 });
    expect(ascii.split('\n')[0]!.length).toBeGreaterThan(cjk.split('\n')[0]!.length);
  });

  it('极小节点不产生 NaN 且不崩溃', () => {
    const out = fitCaption('测试', { diameter: 8, fontSize: 11 });
    expect(typeof out).toBe('string');
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('undefined');
  });

  it('maxLines 可收紧为单行截断', () => {
    const out = fitCaption('一二三四五', { diameter: 44, fontSize: 11, maxLines: 1 });
    expect(out).not.toContain('\n');
    expect(out.endsWith('…')).toBe(true);
  });
});

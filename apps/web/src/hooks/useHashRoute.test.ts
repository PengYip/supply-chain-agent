import { describe, it, expect } from 'vitest';
import { parseHash, formatHash } from './useHashRoute';

describe('parseHash 默认视图（roadmap Item 7）', () => {
  it('空 hash / 未知路径兜底 overview', () => {
    expect(parseHash('').view).toBe('overview');
    expect(parseHash('#').view).toBe('overview');
    expect(parseHash('#/no-such-view').view).toBe('overview');
  });
  it('既有直链 hash 不受默认切换影响', () => {
    expect(parseHash('#/chat?session=s1').view).toBe('chat');
    expect(parseHash('#/chat?session=s1').params).toEqual({ session: 's1' });
    expect(parseHash('#/approvals').view).toBe('approvals');
    expect(parseHash('#/governance').view).toBe('governance');
    expect(parseHash('#/entities').view).toBe('entities');
  });
  it('parseHash 与 formatHash 互逆', () => {
    expect(parseHash(formatHash('overview')).view).toBe('overview');
    expect(parseHash(formatHash('chat', { session: 'x' })).params).toEqual({ session: 'x' });
  });
});

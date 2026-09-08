import { describe, it, expect } from 'vitest';
import { parseHash, formatHash, canonicalHash } from './useHashRoute';
import { isRoutableView } from '../components/shell/navigation';

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
  });
  it('parseHash 与 formatHash 互逆', () => {
    expect(parseHash(formatHash('overview')).view).toBe('overview');
    expect(parseHash(formatHash('chat', { session: 'x' })).params).toEqual({ session: 'x' });
  });
});

describe('旧路由重定向（导航整合 2026-09-08）', () => {
  it('#/entities 与 #/graph 重定向到本体视图对应 tab', () => {
    expect(parseHash('#/entities')).toEqual({ view: 'ontology', params: { tab: 'ledger' } });
    expect(parseHash('#/graph')).toEqual({ view: 'ontology', params: { tab: 'graph' } });
  });
  it('旧路由查询参数透传且优先级高于注入参数', () => {
    expect(parseHash('#/entities?type=Contract')).toEqual({
      view: 'ontology',
      params: { tab: 'ledger', type: 'Contract' },
    });
  });
  it('旧路由的规范 hash 可被 parseHash 恒等还原（canonicalHash 幂等）', () => {
    const canonical = canonicalHash('#/entities?type=Contract');
    expect(canonical).toBe('#/ontology?tab=ledger&type=Contract');
    expect(parseHash(canonical!)).toEqual(parseHash('#/entities?type=Contract'));
    expect(canonicalHash('#/chat?session=s1')).toBeNull();
  });
  it('本体视图路由可达，旧路径不再作为一级视图注册', () => {
    expect(isRoutableView('ontology')).toBe(true);
    expect(isRoutableView('entities')).toBe(false);
    expect(isRoutableView('graph')).toBe(false);
  });
});

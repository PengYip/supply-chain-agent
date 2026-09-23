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

describe('旧路由重定向（导航整合 2026-09-08 / 菜单重构 2026-09-23 二期）', () => {
  it('#/entities 与 #/graph 重定向到本体视图对应 tab', () => {
    expect(parseHash('#/entities')).toEqual({ view: 'ontology', params: { tab: 'ledger' } });
    expect(parseHash('#/graph')).toEqual({ view: 'ontology', params: { tab: 'graph' } });
  });
  it('#/ledger 重定向到项目视图台账 tab', () => {
    expect(parseHash('#/ledger')).toEqual({ view: 'projects', params: { tab: 'ledger' } });
  });
  it('#/parties 重定向到本体台账的己方主体管理入口', () => {
    expect(parseHash('#/parties')).toEqual({
      view: 'ontology',
      params: { tab: 'ledger', type: 'OrgUnit', parties: '1' },
    });
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
  it('本体/项目视图路由可达，旧路径不再作为一级视图注册', () => {
    expect(isRoutableView('ontology')).toBe(true);
    expect(isRoutableView('projects')).toBe(true);
    expect(isRoutableView('entities')).toBe(false);
    expect(isRoutableView('graph')).toBe(false);
    expect(isRoutableView('ledger')).toBe(false);
    expect(isRoutableView('parties')).toBe(false);
  });
});

describe('tab 深链统一（菜单重构 2026-09-23）', () => {
  it('approvals / governance / eval 的 tab 查询参数原样透传', () => {
    expect(parseHash('#/approvals?tab=approved')).toEqual({ view: 'approvals', params: { tab: 'approved' } });
    expect(parseHash('#/governance?tab=permissions')).toEqual({ view: 'governance', params: { tab: 'permissions' } });
    expect(parseHash('#/eval?tab=datasets')).toEqual({ view: 'eval', params: { tab: 'datasets' } });
  });
});

describe('菜单重构二期平移（2026-09-23）', () => {
  it('#/ontology?tab=gaps 参数级平移到勾稽视图（tab 丢弃，其余透传）', () => {
    expect(parseHash('#/ontology?tab=gaps')).toEqual({ view: 'gaps', params: {} });
    expect(parseHash('#/ontology?tab=gaps&type=Contract')).toEqual({ view: 'gaps', params: { type: 'Contract' } });
    expect(canonicalHash('#/ontology?tab=gaps')).toBe('#/gaps');
    // 本体视图自身不受影响：其他 tab 值照常解析
    expect(parseHash('#/ontology?tab=graph')).toEqual({ view: 'ontology', params: { tab: 'graph' } });
  });
  it('#/audit 重定向到治理后台用量 tab，audit 不再是一级视图', () => {
    expect(parseHash('#/audit')).toEqual({ view: 'governance', params: { tab: 'usage' } });
    expect(canonicalHash('#/audit')).toBe('#/governance?tab=usage');
    expect(isRoutableView('audit')).toBe(false);
    expect(isRoutableView('gaps')).toBe(true);
  });
  it('canonicalHash 对规范 hash 返回 null（幂等不重写）', () => {
    expect(canonicalHash('#/chat?session=s1')).toBeNull();
    expect(canonicalHash('#/gaps')).toBeNull();
  });
});

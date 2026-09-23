import { describe, it, expect } from 'vitest';
import { NAV_GROUPS, NAV_ITEMS, NAV_ITEM_MAP, isRoutableView } from './navigation';

/** 导航注册表结构断言（菜单重构 2026-09-23）：结构演进时保住三条底线 ——
 *  分组声明完整（无空组 / 无未声明组）、视图 id 与图标唯一（折叠态纯图标
 *  可区分，防 ClipboardCheck 重复回归）、NAV_ITEM_MAP 全覆盖。 */
describe('导航注册表结构（菜单重构 2026-09-23）', () => {
  it('每个菜单项的分组都在 NAV_GROUPS 声明，且没有空分组', () => {
    const groupIds = new Set(NAV_GROUPS.map((g) => g.id));
    for (const item of NAV_ITEMS) {
      expect(groupIds.has(item.group)).toBe(true);
    }
    const usedGroups = new Set(NAV_ITEMS.map((i) => i.group));
    for (const group of NAV_GROUPS) {
      expect(usedGroups.has(group.id)).toBe(true);
    }
  });

  it('视图 id 唯一', () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('已开放项的图标唯一（折叠态纯图标可区分）', () => {
    const icons = NAV_ITEMS.filter((i) => i.enabled).map((i) => i.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('NAV_ITEM_MAP 覆盖全部注册项', () => {
    for (const item of NAV_ITEMS) {
      expect(NAV_ITEM_MAP[item.id]?.label).toBe(item.label);
    }
  });

  it('isRoutableView 以注册表为准（总览默认门户可达）', () => {
    expect(isRoutableView('overview')).toBe(true);
    expect(isRoutableView('entities')).toBe(false);
  });
});

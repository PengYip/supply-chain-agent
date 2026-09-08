import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildToolInventoryView } from '../../src/harness/toolInventoryView.js';

const inventoryPath = fileURLToPath(new URL('../../../../docs/tool-inventory.json', import.meta.url));
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf-8')) as {
  version: string;
  tools: Array<{ name: string; status: string }>;
  removed: Array<{ name: string }>;
};

// 与 toolInventory.test.ts / toolInventoryView.ts 同口径（2026-09-08 起）：
// 只有 status 'active' 是 live 条目；deprecated=已移除入黑名单。
const liveTools = (): Array<{ name: string; status: string }> =>
  inventory.tools.filter((t) => t.status === 'active');

describe('toolInventoryView', () => {
  it('显式挂载清单：每条 inventory 工具带 registry 对比，diff 为空', () => {
    const live = liveTools();
    const mounted = live.map((t) => ({ name: t.name, needsApproval: t.name === 'bind_document' }));
    const view = buildToolInventoryView(mounted);
    expect(view.source).toBe('docs/tool-inventory.json');
    expect(view.version).toBe(inventory.version);
    expect(view.tools.map((t) => t.name)).toEqual(live.map((t) => t.name));
    expect(view.diff).toEqual({ mountedNotInInventory: [], inventoryNotMounted: [] });
    const bind = view.tools.find((t) => t.name === 'bind_document')!;
    expect(bind.registry).toEqual({ mounted: true, needsApproval: true });
    const load = view.tools.find((t) => t.name === 'load_skill')!;
    expect(load.registry).toEqual({ mounted: true, needsApproval: false });
    expect(view.mountedCount).toBe(live.length);
  });

  it('挂载侧多出的工具进 diff.mountedNotInInventory（不掩饰漂移）', () => {
    const view = buildToolInventoryView([
      { name: 'load_skill', needsApproval: false },
      { name: 'ghost_tool', needsApproval: false },
    ]);
    expect(view.diff.mountedNotInInventory).toEqual(['ghost_tool']);
    expect(view.diff.inventoryNotMounted).toEqual(
      liveTools()
        .filter((t) => t.name !== 'load_skill')
        .map((t) => t.name),
    );
  });

  it('阶段1 移除的四工具只出现在 removed[]，tools[] 无 deprecated 过渡态', () => {
    const removedNames = new Set(inventory.removed.map((r) => r.name));
    const view = buildToolInventoryView([]);
    for (const name of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      expect(removedNames.has(name), `${name} must be blacklisted in removed[]`).toBe(true);
      expect(view.tools.find((x) => x.name === name), `${name} must leave tools[]`).toBeUndefined();
    }
    expect(
      inventory.tools.some((t) => t.status === 'deprecated'),
      'deprecated=已移除入黑名单: tools[] must not carry deprecated entries',
    ).toBe(false);
  });

  it('removed 黑名单原样带出', () => {
    const view = buildToolInventoryView([]);
    expect(Array.isArray(view.removed)).toBe(true);
    expect((view.removed as Array<{ name: string }>).some((r) => r.name === 'tag_document')).toBe(true);
  });
});

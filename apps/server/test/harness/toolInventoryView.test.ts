import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildToolInventoryView } from '../../src/harness/toolInventoryView.js';

const inventoryPath = fileURLToPath(new URL('../../../../docs/tool-inventory.json', import.meta.url));
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf-8')) as {
  version: string;
  tools: Array<{ name: string; status: string }>;
};

describe('toolInventoryView', () => {
  it('显式挂载清单：每条 inventory 工具带 registry 对比，diff 为空', () => {
    const live = inventory.tools.filter((t) => t.status === 'active' || t.status === 'deprecated');
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
      inventory.tools
        .filter((t) => (t.status === 'active' || t.status === 'deprecated') && t.name !== 'load_skill')
        .map((t) => t.name),
    );
  });

  it('deprecated+mounted 如实呈现（Item 6 硬要求：不掩饰）', () => {
    const liveNames = inventory.tools
      .filter((t) => t.status === 'active' || t.status === 'deprecated')
      .map((t) => t.name);
    const view = buildToolInventoryView(liveNames.map((n) => ({ name: n, needsApproval: false })));
    for (const name of ['query_orders', 'cross_check', 'verify_document_fields', 'extract_fields']) {
      const t = view.tools.find((x) => x.name === name)!;
      expect(t.status).toBe('deprecated');
      expect(t.registry.mounted).toBe(true);
      expect(t.removalPlan).toBeTruthy();
    }
  });

  it('removed 黑名单原样带出', () => {
    const view = buildToolInventoryView([]);
    expect(Array.isArray(view.removed)).toBe(true);
    expect((view.removed as Array<{ name: string }>).some((r) => r.name === 'tag_document')).toBe(true);
  });
});

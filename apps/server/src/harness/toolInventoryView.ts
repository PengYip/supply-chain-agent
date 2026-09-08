// apps/server/src/harness/toolInventoryView.ts
// 治理后台 Tab 2 数据源（roadmap Item 6, 2026-09-08）：docs/tool-inventory.json
// （工具面 SSOT）× 注册表实测挂载（getToolsForRole，env 门控如实反映）。
// 只读投影：绝不写 inventory 文件；漂移不掩盖——多出/缺失都进 diff 由前端展示。
// 本模块是 HTTP 视图层，不是 agent 工具：不进 tool-inventory.json（先例 /api/ontology）。
import { readFileSync } from 'node:fs';
import { getToolsForRole, type GatedTool } from './roleToolRegistry.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';

interface InventoryFile {
  version: string;
  policy: unknown;
  tools: Array<{
    name: string;
    layer: string;
    level: string;
    group?: string;
    status: string;
    mount: string;
    requiresEnv?: string;
    whenToUse: string;
    boundary: string;
    rationale: string;
    removalPlan?: string;
    mergeInto?: string;
  }>;
  removed: unknown[];
  merges: unknown;
}

// src/harness 与 dist/harness 目录深度一致：向上四级均为仓库根。
const INVENTORY_URL = new URL('../../../../docs/tool-inventory.json', import.meta.url);

function readInventory(): InventoryFile {
  return JSON.parse(readFileSync(INVENTORY_URL, 'utf-8')) as InventoryFile;
}

function toRegistryState(t: GatedTool): { name: string; needsApproval: boolean } {
  return { name: t.name, needsApproval: t.needsApproval === true };
}

export interface InventoryRegistryState {
  mounted: boolean;
  needsApproval: boolean;
}

export interface InventoryToolView {
  name: string;
  layer: string;
  level: string;
  /** 能力域分组（CI 门禁：active 工具必有非空 group 且 ∈ policy.groups）。 */
  group: string;
  status: string;
  mount: string;
  requiresEnv?: string;
  whenToUse: string;
  boundary: string;
  rationale: string;
  removalPlan?: string;
  mergeInto?: string;
  registry: InventoryRegistryState;
}

export interface ToolInventoryView {
  source: 'docs/tool-inventory.json';
  version: string;
  policy: unknown;
  tools: InventoryToolView[];
  removed: unknown[];
  merges: unknown;
  mountedCount: number;
  diff: { mountedNotInInventory: string[]; inventoryNotMounted: string[] };
}

/** mounted 缺省 = trader 实测挂载（含 env 门控语义，与 CI 门禁同口径）。 */
export function buildToolInventoryView(
  mounted?: Array<{ name: string; needsApproval: boolean }>,
): ToolInventoryView {
  const inv = readInventory();
  const states =
    mounted ??
    getToolsForRole('trader', { ctx: getDbContext() }).map(toRegistryState);
  const stateByName = new Map(states.map((s) => [s.name, s]));
  // 与 toolInventory.test.ts 同口径：只有 status 'active' 是 live 条目
  // (2026-09-08 起 deprecated=已移除入黑名单，只能出现在 removed[])。
  const live = inv.tools.filter((t) => t.status === 'active');
  const liveNames = live.map((t) => t.name);
  const liveSet = new Set(liveNames);
  const mountedNames = states.map((s) => s.name);
  const tools: InventoryToolView[] = live.map((t) => {
    const state = stateByName.get(t.name);
    // 与 CI 门禁同口径的运行时防御：active 条目缺 group 视为 inventory 漂移，直接失败。
    if (!t.group?.trim()) {
      throw new Error(`inventory active tool "${t.name}" has no group; declare one from policy.groups in docs/tool-inventory.json`);
    }
    return {
      ...t,
      group: t.group,
      registry: { mounted: state !== undefined, needsApproval: state?.needsApproval ?? false },
    };
  });
  return {
    source: 'docs/tool-inventory.json',
    version: inv.version,
    policy: inv.policy,
    tools,
    removed: inv.removed,
    merges: inv.merges,
    mountedCount: mountedNames.filter((n) => liveSet.has(n)).length,
    diff: {
      mountedNotInInventory: mountedNames.filter((n) => !liveSet.has(n)),
      inventoryNotMounted: liveNames.filter((n) => !stateByName.has(n)),
    },
  };
}

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listToolNames, getToolsForRole, isCubeSandboxEnabled } from '../../src/harness/roleToolRegistry.js';
import { SCENARIO_TOOLS, SCENARIO_CORE, detectScenario, scenarioActiveTools } from '../../src/harness/scenarios.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { toolOntologyMap, toolFieldsViolations } from '../../src/ontology/toolOntologyMap.js';

// Tool-inventory methodology gate (docs/tool-design-methodology.md, 2026-08-28).
// The inventory JSON is the SSOT for the tool surface; these assertions turn the
// methodology into CI-enforced facts:
//   1. bijection  -- registry mounted names === inventory live entries
//   2. blacklist  -- removed tools never come back
//   3. metadata   -- every tool documents whenToUse/boundary/rationale
//   4. gating     -- env-gated tools mount iff their env flag is set
// Adding a tool without an inventory entry (or deleting one from the inventory)
// fails here, which is the point: the tool surface can no longer grow silently.

interface InventoryTool {
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
}
interface Inventory {
  policy: { maxToolsMountedPerScenario: number; groups?: string[] };
  tools: InventoryTool[];
  removed: Array<{ name: string; reason: string }>;
  merges: { plans: Array<{ target: string; absorbs: string[] }> };
}

const inventoryPath = fileURLToPath(new URL('../../../../docs/tool-inventory.json', import.meta.url));
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf-8')) as Inventory;

const LAYERS = ['感知', '执行', '协作'];
const LEVELS = ['L1', 'L2'];
const STATUSES = ['active', 'deprecated'];
const MOUNTS = ['always', 'env'];

function mountedInventoryNames(): string[] {
  // 2026-09-08 起 status 词汇语义: deprecated=已移除入黑名单（只能出现在
  // removed[]），只有 active 是 live 条目、参与双射断言。
  return inventory.tools.filter((t) => t.status === 'active').map((t) => t.name);
}

describe('tool inventory gate', () => {
  it('inventory live entries and the registry are a bijection', () => {
    const registered = listToolNames('trader');
    const declared = mountedInventoryNames();
    const missingFromInventory = registered.filter((n) => !declared.includes(n));
    const missingFromRegistry = declared.filter((n) => !registered.includes(n));
    expect(
      missingFromInventory,
      `tools mounted in the registry but absent from docs/tool-inventory.json: ${missingFromInventory.join(', ')}`,
    ).toEqual([]);
    expect(
      missingFromRegistry,
      `inventory entries that no longer exist in the registry (move them to "removed"): ${missingFromRegistry.join(', ')}`,
    ).toEqual([]);
  });

  it('removed blacklist never comes back', () => {
    const registered = listToolNames('trader');
    for (const r of inventory.removed) {
      expect(registered, `removed tool "${r.name}" reappeared in the registry`).not.toContain(r.name);
    }
  });

  it('every inventory entry documents layer/level/mount + whenToUse/boundary/rationale', () => {
    const names = inventory.tools.map((t) => t.name);
    expect(new Set(names).size, 'duplicate tool names in inventory').toBe(names.length);
    // 能力域分组词汇（治理后台 ToolsTab 分组展示 + 展示顺序的 SSOT）。
    const GROUPS = inventory.policy.groups ?? [];
    const deprecatedInTools: string[] = [];
    for (const t of inventory.tools) {
      expect(LAYERS, `${t.name}: bad layer`).toContain(t.layer);
      expect(LEVELS, `${t.name}: bad level`).toContain(t.level);
      expect(STATUSES, `${t.name}: bad status`).toContain(t.status);
      expect(MOUNTS, `${t.name}: bad mount`).toContain(t.mount);
      expect(t.whenToUse?.trim(), `${t.name}: missing whenToUse`).toBeTruthy();
      expect(t.boundary?.trim(), `${t.name}: missing boundary (边界比能力描述更重要)`).toBeTruthy();
      expect(t.rationale?.trim(), `${t.name}: missing rationale`).toBeTruthy();
      if (t.status === 'active') {
        expect(t.group?.trim(), `${t.name}: active tools must declare a non-empty group (policy.groups 能力域)`).toBeTruthy();
        expect(GROUPS, `${t.name}: group "${t.group}" not in policy.groups vocabulary`).toContain(t.group);
      }
      if (t.status === 'deprecated') {
        // statusVocabulary semantics (2026-09-08): deprecated=已移除入黑名单.
        // A deprecated entry must live in removed[], never in tools[].
        deprecatedInTools.push(
          `${t.name}: status "deprecated" means removed-into-blacklist -- move this entry to "removed"`,
        );
      }
    }
    expect(
      deprecatedInTools,
      'deprecated inventory entries found in tools[] (deprecated=已移除入黑名单, see policy.statusVocabularyMeaning)',
    ).toEqual([]);
  });

  it('mergeInto targets are declared merge plans', () => {
    const planTargets = inventory.merges.plans.map((p) => p.target);
    for (const t of inventory.tools) {
      if (t.mergeInto) {
        const base = t.mergeInto.split('(')[0]!;
        expect(planTargets, `${t.name}: mergeInto "${base}" has no matching merges.plans entry`).toContain(base);
      }
    }
    // every absorbed name must be an inventory entry (so the merge cannot
    // silently drop tools that were never registered).
    for (const plan of inventory.merges.plans) {
      for (const absorbed of plan.absorbs) {
        expect(
          inventory.tools.some((t) => t.name === absorbed),
          `merge plan "${plan.target}" absorbs unknown tool "${absorbed}"`,
        ).toBe(true);
      }
    }
  });

  it('env-gated tools mount iff their flag is set; only execute_code is gated', () => {
    const gated = inventory.tools.filter((t) => t.mount === 'env');
    expect(gated.map((t) => t.name)).toEqual(['execute_code']);
    expect(gated[0]!.requiresEnv, 'execute_code must document its env flag').toBeTruthy();

    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const names = getToolsForRole('trader', { ctx }).map((t) => t.name);
    if (isCubeSandboxEnabled()) {
      expect(names).toContain('execute_code');
    } else {
      expect(names, 'execute_code must stay unmounted unless CUBE_SANDBOX_ENABLED=true').not.toContain('execute_code');
    }
  });

  it('scenario mounting (阶段3): every scenario subset of mounted, within the cap, CORE always visible', () => {
    const mounted = new Set(listToolNames('trader'));
    const cap = inventory.policy.maxToolsMountedPerScenario;
    for (const [scenario, tools] of Object.entries(SCENARIO_TOOLS)) {
      for (const core of SCENARIO_CORE) {
        expect(tools, `${scenario} must include CORE tool ${core}`).toContain(core);
      }
      const visible = scenarioActiveTools(scenario as keyof typeof SCENARIO_TOOLS, [...mounted])!;
      expect(visible.length, `${scenario} exceeds the per-scenario cap of ${cap}`).toBeLessThanOrEqual(cap);
      for (const t of visible) {
        expect(mounted.has(t), `${scenario} exposes unmounted tool ${t}`).toBe(true);
      }
    }
    // conservative router: unknown/template text -> 'all' (no narrowing)
    expect(detectScenario('帮我维护一下模板词表')).toBe('all');
    expect(detectScenario('')).toBe('all');
    expect(detectScenario('这个项目结算扣款怎么算')).toBe('settlement');
    // 货值暂估/结算与结算同域(2026-08-28 settlement-valuation 技能)
    expect(detectScenario('这批货值多少？先暂估一下')).toBe('settlement');
    expect(detectScenario('请录入这份合同并解析')).toBe('entry');
    expect(detectScenario('这两份合同是什么关系')).toBe('qa');
  });

  it('toolOntologyMap: mapped tools stay inside the ontology vocabulary', () => {
    const ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    const tools = getToolsForRole('trader', { ctx });
    expect(Object.keys(toolOntologyMap).length, 'demo mapping: exactly 6 tools').toBe(6);
    for (const name of Object.keys(toolOntologyMap)) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} is mapped in toolOntologyMap but not mounted for trader`).toBeDefined();
      const fields = Object.keys((t!.inputSchema as { shape: Record<string, unknown> }).shape ?? {});
      const violations = toolFieldsViolations(name, fields);
      expect(violations,
        `${name} inputSchema fields outside the ontology registry vocabulary: ${violations.join(', ')} ` +
        '(add them to the entity schema or SHARED_TOOL_FIELD_NAMES in src/ontology/index.ts first)').toEqual([]);
    }
  });
});

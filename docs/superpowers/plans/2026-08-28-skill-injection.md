# Skill 注入机制（load_skill + settlement-valuation）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent 增加"发现 → 索引 → 按需加载"的 Skill 注入机制，并以 settlement-valuation（货值暂估/结算）为首个技能落地。

**Architecture:** 技能为 `apps/server/skills/<名>/SKILL.md`（frontmatter: name/description/whenToUse）。启动时同步扫描一次并把技能清单拼进 SYSTEM_PROMPT 静态尾部；新 L1 工具 `load_skill(name)` 按登记名返回全文作为工具结果（持久进入对话）。挂 SCENARIO_CORE，清单/场景/双射过既有 CI 门禁。

**Tech Stack:** AI SDK 6（`inputSchema`）、zod、yaml ^2.9.0（已是 apps/server 直接依赖）、vitest。

**Spec:** docs/superpowers/specs/2026-08-28-skill-injection-design.md

## Global Constraints

- 不用 emoji（仓库约定）。
- AI SDK 6 工具字段是 `inputSchema`（不是 `parameters`）。
- 改工具面必须先改 `docs/tool-inventory.json` 再改 registry（`toolInventory.test.ts` 双射门禁）。
- `maxToolsMountedPerScenario` 10 → 11（有意识的政策修订）。
- 描述写作五条：何时用优先、写边界、参数给例子、返回结构、不出 emoji。
- 每个 Task 结束跑单测；最终 build → lint → test 全绿后提交。

## File Structure

- Create: `apps/server/skills/settlement-valuation/SKILL.md` — 首个技能文档
- Create: `apps/server/src/harness/skillDiscovery.ts` — 扫描/frontmatter/缓存/索引段
- Create: `apps/server/src/tools/skillTool.ts` — load_skill 工具
- Create: `apps/server/test/harness/skillDiscovery.test.ts`
- Create: `apps/server/test/harness/skillTool.test.ts`
- Modify: `apps/server/src/harness/agent.ts` — SYSTEM_PROMPT 拼接技能索引段
- Modify: `apps/server/src/harness/roleToolRegistry.ts` — BASE 挂 load_skill
- Modify: `apps/server/src/harness/scenarios.ts` — CORE 加 load_skill；SETTLEMENT_RE 加 暂估|货值
- Modify: `docs/tool-inventory.json` — load_skill 条目 + cap 11
- Modify: `apps/server/test/harness/toolInventory.test.ts` — 路由断言补暂估/货值
- Modify: `apps/server/eval/datasets/tool-use.json` — 新增 2 用例

---

### Task 1: skillDiscovery 模块（TDD）

**Files:**
- Create: `apps/server/src/harness/skillDiscovery.ts`
- Test: `apps/server/test/harness/skillDiscovery.test.ts`

**Interfaces:**
- Produces: `skillsRoot(): string`; `discoverSkillsFrom(root): SkillMeta[]`（sync）; `discoverSkills(): SkillMeta[]`（sync+缓存）; `loadSkillFrom(name, root): SkillDefinition | null`（sync）; `loadSkillByName(name): Promise<SkillDefinition | null>`（异步读、缓存条目）; `resetSkillCache(): void`; `buildSkillIndexSection(skills): string`。
- `SkillMeta = { name, description, whenToUse, path }`; `SkillDefinition = SkillMeta & { content }`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/skillDiscovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkillsFrom, loadSkillFrom, loadSkillByName, resetSkillCache, buildSkillIndexSection,
} from '../../src/harness/skillDiscovery.js';

const GOOD = `---
name: demo-skill
description: 演示技能。
whenToUse: 测试时加载。
---
正文第一行
`;

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'sca-skills-'));
}

let root: string;
beforeEach(() => { root = makeRoot(); resetSkillCache(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); resetSkillCache(); });

describe('skillDiscovery', () => {
  it('解析 frontmatter 三要素', () => {
    mkdirSync(join(root, 'demo-skill'));
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), GOOD, 'utf-8');
    const skills = discoverSkillsFrom(root);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'demo-skill', description: '演示技能。', whenToUse: '测试时加载。', path: 'skills/demo-skill/SKILL.md' });
  });

  it('缺 frontmatter / 缺字段 / 目录名不一致 -> 跳过; 目录不存在 -> 空', () => {
    mkdirSync(join(root, 'bad1'));
    writeFileSync(join(root, 'bad1', 'SKILL.md'), '没有 frontmatter', 'utf-8');
    mkdirSync(join(root, 'bad2'));
    writeFileSync(join(root, 'bad2', 'SKILL.md'), '---\nname: bad2\n---\n正文', 'utf-8');
    mkdirSync(join(root, 'wrong-dir'));
    writeFileSync(join(root, 'wrong-dir', 'SKILL.md'), GOOD.replace('demo-skill', 'other'), 'utf-8');
    expect(discoverSkillsFrom(root)).toEqual([]);
    expect(discoverSkillsFrom(join(root, 'not-exist'))).toEqual([]);
  });

  it('loadSkillFrom 返回剥离 frontmatter 的正文; 未知名 -> null', () => {
    mkdirSync(join(root, 'demo-skill'));
    writeFileSync(join(root, 'demo-skill', 'SKILL.md'), GOOD, 'utf-8');
    const def = loadSkillFrom('demo-skill', root);
    expect(def?.content).toBe('正文第一行');
    expect(def?.name).toBe('demo-skill');
    expect(loadSkillFrom('nope', root)).toBeNull();
  });

  it('loadSkillByName 走默认目录缓存', async () => {
    resetSkillCache();
    const skills = discoverSkills();
    if (skills.some((s) => s.name === 'settlement-valuation')) {
      const def = await loadSkillByName('settlement-valuation');
      expect(def?.content).toContain('暂估');
    } else {
      expect(await loadSkillByName('settlement-valuation')).toBeNull();
    }
  });

  it('buildSkillIndexSection: 无技能空串; 有技能含名字与规则', () => {
    expect(buildSkillIndexSection([])).toBe('');
    const section = buildSkillIndexSection([
      { name: 'demo-skill', description: '演示技能。', whenToUse: '测试时加载。', path: 'skills/demo-skill/SKILL.md' },
    ]);
    expect(section).toContain('可用技能');
    expect(section).toContain('demo-skill');
    expect(section).toContain('load_skill');
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `npm test --workspace apps/server -- test/harness/skillDiscovery.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// apps/server/src/harness/skillDiscovery.ts
// Skill 发现层(tool-inventory 方法论第4步 Skill 化, 2026-08-28)。
// skills 是部署内置的 apps/server/skills/<名>/SKILL.md(YAML frontmatter:
// name/description/whenToUse 单行值, 不支持多行 YAML -- 边界如实声明)。
// 启动时同步扫描一次并缓存; 索引段拼进 SYSTEM_PROMPT 静态尾部(KV cache 稳定);
// 全文经 load_skill 工具按需加载(工具结果持久进入对话)。参考 fastchain-agent-demo
// 的 discovery/load 两段式, 按本仓库准则适配: name 参数(不暴露任意路径)。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const SkillMetadata = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  whenToUse: z.string().min(1),
});
export type SkillMetadataShape = z.infer<typeof SkillMetadata>;

export interface SkillMeta extends SkillMetadataShape { path: string }
export interface SkillDefinition extends SkillMeta { content: string }

export function skillsRoot(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

interface Entry extends SkillMetadataShape { absDir: string }

let cache: Entry[] | null = null;

export function resetSkillCache(): void {
  cache = null;
}

/** 解析 `---\\n...yaml...\\n---\\n` 头; 缺失/损坏返回 null。 */
function parseFrontmatter(raw: string): { meta: unknown; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  try {
    return { meta: parse(m[1]!), body: (m[2] ?? '').trim() };
  } catch {
    return null;
  }
}

/** 同步扫描 root(测试注入临时目录用); 目录不存在返回空数组, 不抛错。 */
export function discoverSkillsFrom(root: string): SkillMeta[] {
  return scanSync(root).map(({ absDir, ...meta }) => meta);
}

/** 默认目录扫描(带缓存); 启动时由 agent.ts 调用一次。 */
export function discoverSkills(): SkillMeta[] {
  if (!cache) cache = scanSync(skillsRoot());
  return cache.map(({ absDir, ...meta }) => meta);
}

export function loadSkillFrom(name: string, root: string): SkillDefinition | null {
  const entry = scanSync(root).find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(entry);
}

/** 按登记名加载全文(未登记 -> null)。工具 execute 走这里。 */
export async function loadSkillByName(name: string): Promise<SkillDefinition | null> {
  if (!cache) cache = scanSync(skillsRoot());
  const entry = cache.find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(entry);
}

function scanSync(root: string): Entry[] {
  let names: string[];
  try {
    if (!existsSync(root)) return [];
    names = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  } catch {
    return [];
  }
  const found: Entry[] = [];
  for (const dirName of names) {
    const absDir = join(root, dirName);
    let raw: string;
    try {
      raw = readFileSync(join(absDir, 'SKILL.md'), 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      console.warn(`[skillDiscovery] SKILL.md frontmatter 缺失或损坏, 跳过: ${absDir}`);
      continue;
    }
    const result = SkillMetadata.safeParse(parsed.meta);
    if (!result.success) {
      console.warn(`[skillDiscovery] SKILL.md frontmatter 缺 name/description/whenToUse, 跳过: ${absDir}`);
      continue;
    }
    if (result.data.name !== dirName) {
      console.warn(`[skillDiscovery] frontmatter name(${result.data.name}) 与目录名(${dirName})不一致, 跳过: ${absDir}`);
      continue;
    }
    found.push({ ...result.data, absDir });
  }
  return found;
}

function readEntry(entry: Entry): SkillDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(join(entry.absDir, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  return {
    name: entry.name,
    description: entry.description,
    whenToUse: entry.whenToUse,
    path: `skills/${entry.name}/SKILL.md`,
    content: parsed.body,
  };
}

/** 生成 SYSTEM_PROMPT 尾部的技能索引段; 无技能返回空串。 */
export function buildSkillIndexSection(skills: SkillMeta[]): string {
  if (skills.length === 0) return '';
  const list = skills
    .map((s) => `- ${s.name}: ${s.description}（何时用: ${s.whenToUse}）`)
    .join('\n');
  return [
    '',
    '## 可用技能（Skills, 业务流程知识按需加载）',
    '系统为以下业务流程内置了标准作业技能, 命中适用场景时必须先加载技能全文再执行:',
    list,
    '技能使用规则:',
    '1. 用户问题命中某个技能的"何时用"时, 必须先调用 load_skill 加载技能全文, 严格按技能流程执行, 不得凭记忆跳步。',
    '2. 用户询问"你有什么技能/有哪些标准流程"时, 如实列举上述技能名单与用途。',
    '3. 技能内容是操作指导, 不替代业务工具: 一切数字仍须来自 query_business/recall_documents/gather_settlement_evidence 等工具返回的数据, 技能不改变数字零幻觉硬约束。',
    '4. 技能内容随对话持久有效; 若历史被压缩后看不到内容, 重新调用 load_skill 即可。',
  ].join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过** — 同 Step 2 命令 → PASS（5 用例）。
- [ ] **Step 5: Commit** — `git add apps/server/src/harness/skillDiscovery.ts apps/server/test/harness/skillDiscovery.test.ts && git commit -m "feat(server): skillDiscovery - SKILL.md 扫描/frontmatter/索引段"`。

### Task 2: load_skill 工具

**Files:**
- Create: `apps/server/src/tools/skillTool.ts`
- Test: `apps/server/test/harness/skillTool.test.ts`

**Interfaces:**
- Consumes: `loadSkillByName` / `discoverSkills`（Task 1）。
- Produces: `buildLoadSkillTool(): Tool`（AI SDK 6 tool, inputSchema `{ name: string }`, execute 返回 `{ success: true, name, description, content } | { success: false, error }`）。工具名 `load_skill` 由 registry 挂载时赋予。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/harness/skillTool.test.ts
import { describe, it, expect } from 'vitest';
import { buildLoadSkillTool } from '../../src/tools/skillTool.js';
import { discoverSkills } from '../../src/harness/skillDiscovery.js';

function execute(input: unknown) {
  const t = buildLoadSkillTool();
  return t.execute!.call({ toolCallId: 't', messages: [] }, input as never, {} as never) as Promise<Record<string, unknown>>;
}

describe('load_skill tool', () => {
  it('命中登记技能返回全文', async () => {
    const names = discoverSkills().map((s) => s.name);
    if (!names.includes('settlement-valuation')) return; // Task 3 落地后生效
    const result = await execute({ name: 'settlement-valuation' });
    expect(result.success).toBe(true);
    expect(String(result.content)).toContain('暂估');
  });

  it('未登记名返回 success:false 与可用名单', async () => {
    const result = await execute({ name: 'not-a-skill' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('未登记的技能名');
  });
});
```

- [ ] **Step 2: 确认失败** — 模块不存在 → FAIL。
- [ ] **Step 3: 实现**

```ts
// apps/server/src/tools/skillTool.ts
// load_skill(L1 只读, 2026-08-28 Skill 化): 按登记名返回技能文档全文。
// 全文作为工具结果持久进入对话(同会话后续轮次可见, 被压缩后可重新加载)。
// 边界: 只接受系统提示词"可用技能"清单中的名字; 返回的是操作指导文本,
// 本身不执行任何计算或写操作, 数字必须另行来自业务工具返回的数据。
import { tool } from 'ai';
import { z } from 'zod';
import { loadSkillByName, discoverSkills } from '../harness/skillDiscovery.js';

export function buildLoadSkillTool() {
  return tool({
    description:
      '按技能名加载业务流程技能的完整文档。什么时候用: 系统提示词"可用技能"清单中列出的场景出现时' +
      '(如货值暂估/结算计算), 必须先调用本工具加载技能全文、严格按技能流程执行; ' +
      '用户询问"你有什么技能"时也用它取全文转述。' +
      '边界: name 只接受技能清单中登记的名字(如 settlement-valuation), 未登记返回 success:false 与可用名单; ' +
      '返回内容是操作指导文本, 不执行任何计算或写操作; 计算依据必须另行来自业务工具返回的数据。' +
      '返回: { success, name, description, content } 或 { success: false, error }。',
    inputSchema: z.object({
      name: z.string().min(1).describe('技能名, 与系统提示词"可用技能"清单一致, 如 settlement-valuation'),
    }),
    execute: async ({ name }) => {
      const skill = await loadSkillByName(name);
      if (!skill) {
        const known = discoverSkills().map((s) => s.name).join(', ');
        return { success: false as const, error: `未登记的技能名: ${name}（可用: ${known || '无'}）` };
      }
      return { success: true as const, name: skill.name, description: skill.description, content: skill.content };
    },
  });
}
```

- [ ] **Step 4: 测试通过**（命中用例在 Task 4 落地 SKILL.md 前以 `return` 跳过）。
- [ ] **Step 5: Commit** — `git add apps/server/src/tools/skillTool.ts apps/server/test/harness/skillTool.test.ts && git commit -m "feat(server): load_skill 工具 - 按登记名加载技能全文"`。

### Task 3: settlement-valuation 技能文档

**Files:**
- Create: `apps/server/skills/settlement-valuation/SKILL.md`

**Interfaces:**
- Produces: 技能名 `settlement-valuation`（Task 1/2 的默认目录扫描与测试断言依赖该名字与"暂估"关键词）。

- [ ] **Step 1: 写 SKILL.md**（内容：暂估流程、结算四步、计算书规范、缺口处理；正文含"暂估"关键词）
- [ ] **Step 2: 跑两个测试文件**（Task 1/2 全部用例生效）→ PASS。
- [ ] **Step 3: Commit** — `git add apps/server/skills && git commit -m "feat(skills): settlement-valuation 货值计算技能(暂估+结算四步+计算书规范)"`。

### Task 4: 接线（registry / scenarios / SYSTEM_PROMPT / 清单）

**Files:**
- Modify: `apps/server/src/harness/roleToolRegistry.ts`（BASE_TOOLS_FOR_ROLE.trader 首部加 `{ ...buildLoadSkillTool(), name: 'load_skill' }`, import skillTool）
- Modify: `apps/server/src/harness/scenarios.ts`（SCENARIO_CORE 加 `'load_skill'`; SETTLEMENT_RE 加 `|暂估|货值`, 注释说明）
- Modify: `apps/server/src/harness/agent.ts`（import skillDiscovery; `const SKILL_SECTION = buildSkillIndexSection(discoverSkills());` 置于 SYSTEM_PROMPT 定义前; `export const SYSTEM_PROMPT = [...].join('\n') + SKILL_SECTION;`）
- Modify: `docs/tool-inventory.json`（policy.maxToolsMountedPerScenario → 11; tools 增加 load_skill 条目: layer=感知/level=L1/status=active/mount=always/三要素; description 字段补一句 skill 机制说明）

- [ ] **Step 1: 依次修改四个文件**（清单先行, 再 registry）。
- [ ] **Step 2: 跑门禁** — `npm test --workspace apps/server -- test/harness/toolInventory.test.ts test/eval/toolUse.dataset.test.ts` → PASS（双射/新 cap=11/CORE ⊆ 各场景）。
- [ ] **Step 3: 跑全量** — `npm test --workspace apps/server` → PASS。
- [ ] **Step 4: Commit** — `git add -A apps/server docs/tool-inventory.json && git commit -m "feat(server): 接线 load_skill 进 registry/场景/系统提示词; 清单 cap 11"`。

### Task 5: 评估集用例 + 路由断言

**Files:**
- Modify: `apps/server/eval/datasets/tool-use.json`（新增 2 用例: `provisional-valuation` query="CJXC-2025-001 这批货先按暂估估个货值" expectedScenario=settlement expectedTools=["load_skill"]; `settlement-calc` query="把 CJXC-2025-001 的货值结算一下" expectedScenario=settlement expectedTools=["load_skill"]）
- Modify: `apps/server/test/harness/toolInventory.test.ts`（scenario 断言追加 `expect(detectScenario('这批货值多少？先暂估一下')).toBe('settlement')`）

- [ ] **Step 1: 改两个文件**。
- [ ] **Step 2: 跑** — `npm test --workspace apps/server -- test/eval/toolUse.dataset.test.ts test/harness/toolInventory.test.ts` → PASS。
- [ ] **Step 3: Commit** — `git add apps/server/eval/datasets/tool-use.json apps/server/test/harness/toolInventory.test.ts && git commit -m "test(server): 工具选择评估集补货值暂估/结算 load_skill 用例"`。

### Task 6: 全量验证 + 提交合并

- [ ] **Step 1:** `npm run build`（web+server）→ 0 error。
- [ ] **Step 2:** `npm run lint` → 0 error。
- [ ] **Step 3:** `npm test` → 全绿。
- [ ] **Step 4:** 按 AGENTS.md 约定 push 分支并合并 main（`git fetch origin main && git merge origin/main` → 复验 → `git push origin HEAD:<branch>` + `git push origin HEAD:main`）。

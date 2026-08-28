import { describe, it, expect, beforeEach } from 'vitest';
import { buildLoadSkillTool } from '../../src/tools/skillTool.js';
import { discoverSkills, resetSkillCache } from '../../src/harness/skillDiscovery.js';

// load_skill 工具单测(2026-08-28): 命中返回全文, 未登记名返回 success:false。
// execute 经 call 绑定 AI SDK ToolExecutionOptions 形参(工具内部未使用, 传空壳)。

beforeEach(() => { resetSkillCache(); });

function execute(input: unknown): Promise<Record<string, unknown>> {
  const t = buildLoadSkillTool();
  return t.execute!.call({ toolCallId: 't', messages: [] }, input as never, {} as never) as Promise<Record<string, unknown>>;
}

describe('load_skill tool', () => {
  it('未登记名返回 success:false 与可用名单', async () => {
    const result = await execute({ name: 'not-a-skill' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('未登记的技能名');
  });

  it('真实技能目录就绪时可加载 settlement-valuation', async () => {
    const names = discoverSkills().map((s) => s.name);
    if (!names.includes('settlement-valuation')) return;
    const result = await execute({ name: 'settlement-valuation' });
    expect(result.success).toBe(true);
    expect(String(result.content)).toContain('暂估');
  });

  it('返回形状含 name/description/content', async () => {
    const names = discoverSkills().map((s) => s.name);
    if (names.length === 0) return;
    const first = names[0]!;
    const result = await execute({ name: first });
    expect(result.success).toBe(true);
    expect(result.name).toBe(first);
    expect(typeof result.description).toBe('string');
    expect(typeof result.content).toBe('string');
  });
});

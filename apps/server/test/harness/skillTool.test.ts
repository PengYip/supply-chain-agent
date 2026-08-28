import { describe, it, expect, beforeEach } from 'vitest';
import { buildLoadSkillTool } from '../../src/tools/skillTool.js';
import { discoverSkills, resetSkillCache } from '../../src/harness/skillDiscovery.js';

// load_skill 工具单测(2026-08-28): 命中返回全文+附属文件清单; file 模式读参考
// 文件; 未登记名/逃逸路径返回 success:false。
// execute 经 call 绑定 AI SDK ToolExecutionOptions 形参(工具内部未使用, 传空壳)。

beforeEach(() => { resetSkillCache(); });

function execute(input: unknown): Promise<Record<string, unknown>> {
  const t = buildLoadSkillTool();
  return t.execute!.call({ toolCallId: 't', messages: [] }, input as never, {} as never) as unknown as Promise<Record<string, unknown>>;
}

describe('load_skill tool', () => {
  it('未登记名返回 success:false 与可用名单', async () => {
    const result = await execute({ name: 'not-a-skill' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('未登记的技能名');
  });

  it('真实技能目录就绪时可加载 settlement-valuation, 结果含附属文件清单', async () => {
    const names = discoverSkills().map((s) => s.name);
    if (!names.includes('settlement-valuation')) return;
    const result = await execute({ name: 'settlement-valuation' });
    expect(result.success).toBe(true);
    expect(String(result.content)).toContain('暂估');
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files as string[]).toContain('references/settlement-report-template.md');
  });

  it('file 模式: 读取清单内参考文件', async () => {
    const names = discoverSkills().map((s) => s.name);
    if (!names.includes('settlement-valuation')) return;
    const result = await execute({ name: 'settlement-valuation', file: 'references/settlement-report-template.md' });
    expect(result.success).toBe(true);
    expect(String(result.content)).toContain('结算计算书');
  });

  it('file 模式: 逃逸路径/未登记文件返回 success:false 与可用清单', async () => {
    const names = discoverSkills().map((s) => s.name);
    if (!names.includes('settlement-valuation')) return;
    for (const bad of ['../escape.md', '/etc/passwd', 'C:/x.md', 'references/none.md']) {
      const result = await execute({ name: 'settlement-valuation', file: bad });
      expect(result.success, bad).toBe(false);
      expect(String(result.error), bad).toContain('可用文件');
    }
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

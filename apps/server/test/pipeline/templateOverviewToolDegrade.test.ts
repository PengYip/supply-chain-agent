import { describe, it, expect, vi } from 'vitest';

// 降级路径测试: 模板表读取抛错时 execute 返回可读错误对象而非抛异常。
// 单独文件避免 mock repositories.js 影响 templateOverviewTool.test.ts 的正常用例。
vi.mock('../../src/pipeline/db/repositories.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/pipeline/db/repositories.js')>();
  return {
    ...mod,
    listTemplateTypes: async () => { throw new Error('template table unavailable'); },
    listActiveEdgeRules: async () => { throw new Error('template table unavailable'); },
  };
});
const { buildTemplateOverviewTool } = await import('../../src/pipeline/tools/templateOverviewTool.js');

describe('template_overview tool degrade path', () => {
  it('模板表读取抛错时 execute 返回错误对象而不抛异常', async () => {
    const tool = buildTemplateOverviewTool({ ctx: {} as never, userId: 'u1' });
    const res = await tool.execute({});
    expect(res.status).toBe('error');
    expect(res.error).toContain('模板数据读取失败');
  });
});
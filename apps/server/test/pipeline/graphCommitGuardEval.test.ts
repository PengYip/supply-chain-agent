import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../src/pipeline/templateSeed.js';
import { listActiveEdgeRules } from '../../src/pipeline/db/repositories.js';
import { validateEdge } from '../../src/pipeline/templateGuard.js';

const ctx = createDb();
beforeEach(async () => { migrate(ctx.sqlite); await ensureTemplateSeed(ctx); });

describe('graphCommit guard evaluation (Phase 2: 登记不激活)', () => {
  it('party/commodity/references/executes 不在守卫范围(现状放行)', async () => {
    const r = await validateEdge(ctx, { docType: '发票', edgeType: 'party' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ruleId).toBe('unguarded');
  });

  it('executes 规则已登记但未激活', async () => {
    const rules = await listActiveEdgeRules(ctx);
    expect(rules.some((r) => r.id === 'er-exec-fapiao')).toBe(false);
    const all = ctx.sqlite.prepare("SELECT id, is_active FROM template_edge_rules WHERE edge_type = 'executes'").all() as Array<{ id: string; is_active: number }>;
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((r) => r.is_active === 0)).toBe(true);
  });

  it('party/commodity/references 规则已登记但未激活(登记留痕)', async () => {
    const all = ctx.sqlite.prepare(
      "SELECT id, is_active FROM template_edge_rules WHERE edge_type IN ('party','commodity','references')",
    ).all() as Array<{ id: string; is_active: number }>;
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.every((r) => r.is_active === 0)).toBe(true);
    const ids = all.map((r) => r.id);
    expect(ids).toContain('er-party-fapiao');
    expect(ids).toContain('er-commodity-fapiao');
    expect(ids).toContain('er-references-hetong');
  });
});
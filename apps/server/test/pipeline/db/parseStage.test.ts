import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  updateDocumentParseStage,
} from '../../../src/pipeline/db/repositories.js';

// 阶段级解析进度(2026-09-01): documents.parse_stage + stage_started_at。
// 仓储层往返: 置阶段 -> 两列有值(started_at 为 ISO); 清 -> 两列 NULL。

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

function stageRow(docId: string): { parse_stage: string | null; stage_started_at: string | null } {
  return ctx.sqlite
    .prepare('SELECT parse_stage, stage_started_at FROM documents WHERE id = ?')
    .get(docId) as { parse_stage: string | null; stage_started_at: string | null };
}

describe('updateDocumentParseStage', () => {
  it('置阶段写 parse_stage + ISO stage_started_at, 切阶段刷新, 清空两列归 NULL', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///a.pdf', userId: 'u1' });
    expect(stageRow(docId).parse_stage).toBeNull();
    expect(stageRow(docId).stage_started_at).toBeNull();

    await updateDocumentParseStage(ctx, docId, 'ocr');
    const set = stageRow(docId);
    expect(set.parse_stage).toBe('ocr');
    expect(typeof set.stage_started_at).toBe('string');
    expect(Number.isNaN(Date.parse(set.stage_started_at!))).toBe(false);

    // 阶段切换: 值覆盖, started_at 不早于前值。
    await updateDocumentParseStage(ctx, docId, 'indexing');
    const switched = stageRow(docId);
    expect(switched.parse_stage).toBe('indexing');
    expect(Date.parse(switched.stage_started_at!)).toBeGreaterThanOrEqual(
      Date.parse(set.stage_started_at!),
    );

    // 清(解析终态): 两列全 NULL。
    await updateDocumentParseStage(ctx, docId, null);
    const cleared = stageRow(docId);
    expect(cleared.parse_stage).toBeNull();
    expect(cleared.stage_started_at).toBeNull();
  });

  it('clear 对未置阶段的行是无害 no-op(幂等)', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///b.pdf', userId: 'u1' });
    await expect(updateDocumentParseStage(ctx, docId, null)).resolves.toBeUndefined();
    expect(stageRow(docId).parse_stage).toBeNull();
    expect(stageRow(docId).stage_started_at).toBeNull();
  });
});

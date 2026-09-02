import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createDocumentStub,
  updateDocumentParseStage,
  setDocumentParseStatus,
  failStaleParsingDocuments,
  failStuckUnitsUnderTerminalDocuments,
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

// ---- 启动清扫(刷新丢失解析状态修复): 残留 parsing -> failed ----------------

describe('failStaleParsingDocuments (boot sweep)', () => {
  it('仅 parsing 翻转为 failed, 其余状态不动; 返回翻转数; 幂等', async () => {
    const statuses = ['parsing', 'parsing', 'uploaded', 'parsed', 'needs_ocr', 'failed'] as const;
    const ids: string[] = [];
    for (const [i, st] of statuses.entries()) {
      const { docId } = await createDocumentStub(ctx, { sourceUri: `file:///s${i}.pdf`, userId: 'u1' });
      if (st !== 'uploaded') await setDocumentParseStatus(ctx, docId, st, 'u1');
      ids.push(docId);
    }

    await expect(failStaleParsingDocuments(ctx)).resolves.toBe(2);

    for (const [i, st] of statuses.entries()) {
      const row = ctx.sqlite
        .prepare('SELECT parse_status FROM documents WHERE id = ?')
        .get(ids[i]) as { parse_status: string };
      expect(row.parse_status).toBe(st === 'parsing' ? 'failed' : st);
    }

    // 幂等: 第二次清扫无残留。
    await expect(failStaleParsingDocuments(ctx)).resolves.toBe(0);
  });

  it('空库 -> 返回 0(无害)', async () => {
    await expect(failStaleParsingDocuments(ctx)).resolves.toBe(0);
  });

  it('终态行(parsed/failed)残留 parse_stage -> 清空阶段列, 状态不动', async () => {
    const { docId: parsedId } = await createDocumentStub(ctx, { sourceUri: 'file:///t1.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, parsedId, 'parsed', 'u1');
    await updateDocumentParseStage(ctx, parsedId, 'extracting');
    const { docId: failedId } = await createDocumentStub(ctx, { sourceUri: 'file:///t2.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, failedId, 'failed', 'u1');
    await updateDocumentParseStage(ctx, failedId, 'detecting');

    await failStaleParsingDocuments(ctx);

    // 阶段列清空, 终态状态权威不动。
    expect(stageRow(parsedId).parse_stage).toBeNull();
    expect(stageRow(parsedId).stage_started_at).toBeNull();
    expect(
      (ctx.sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get(parsedId) as { parse_status: string }).parse_status,
    ).toBe('parsed');
    expect(stageRow(failedId).parse_stage).toBeNull();
    expect(stageRow(failedId).stage_started_at).toBeNull();
    expect(
      (ctx.sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get(failedId) as { parse_status: string }).parse_status,
    ).toBe('failed');
  });

  it('parsing 行: 翻 failed 且阶段列一并清空', async () => {
    const { docId } = await createDocumentStub(ctx, { sourceUri: 'file:///t3.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, docId, 'parsing', 'u1');
    await updateDocumentParseStage(ctx, docId, 'ocr');

    await failStaleParsingDocuments(ctx);

    expect(
      (ctx.sqlite.prepare('SELECT parse_status FROM documents WHERE id = ?').get(docId) as { parse_status: string }).parse_status,
    ).toBe('failed');
    expect(stageRow(docId).parse_stage).toBeNull();
    expect(stageRow(docId).stage_started_at).toBeNull();
  });
});

// ---- 启动清扫(2026-09-02 扩展): 终态文档下残留非终态 unit -> failed ---------

describe('failStuckUnitsUnderTerminalDocuments (boot sweep)', () => {
  /** 种一个 unit 行(匹配 document_units 真实 schema)。 */
  function seedUnit(
    parentDocId: string,
    childDocId: string,
    status: string,
    unitIndex = 1,
  ): void {
    ctx.sqlite
      .prepare(
        `INSERT INTO document_units
           (id, parent_document_id, child_document_id, unit_index, doc_type,
            page_start, page_end, bbox_json, rotation_deg, detector_confidence,
            manifest_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `DU-${parentDocId}-${unitIndex}`,
        parentDocId,
        childDocId,
        unitIndex,
        '汽运磅单',
        1,
        1,
        '{}',
        0,
        0,
        '{}',
        status,
      );
  }

  function unitStatus(childDocId: string): string {
    return (
      ctx.sqlite
        .prepare('SELECT status FROM document_units WHERE child_document_id = ?')
        .get(childDocId) as { status: string }
    ).status;
  }

  it('终态文档(parsed, 含 parse_stage 残留)下 pending/processing -> failed, processed 不动; 返回 2', async () => {
    const { docId: parentId } = await createDocumentStub(ctx, { sourceUri: 'file:///u1.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, parentId, 'parsed', 'u1');
    await updateDocumentParseStage(ctx, parentId, 'extracting'); // 崩溃残留阶段列

    const { docId: c1 } = await createDocumentStub(ctx, { sourceUri: 'file:///u1.pdf', userId: 'u1' });
    const { docId: c2 } = await createDocumentStub(ctx, { sourceUri: 'file:///u1.pdf', userId: 'u1' });
    const { docId: c3 } = await createDocumentStub(ctx, { sourceUri: 'file:///u1.pdf', userId: 'u1' });
    seedUnit(parentId, c1, 'pending', 1);
    seedUnit(parentId, c2, 'processing', 2);
    seedUnit(parentId, c3, 'processed', 3);

    await expect(failStuckUnitsUnderTerminalDocuments(ctx)).resolves.toBe(2);

    expect(unitStatus(c1)).toBe('failed');
    expect(unitStatus(c2)).toBe('failed');
    expect(unitStatus(c3)).toBe('processed');
  });

  it('文档仍 parsing + pending unit -> 不动, 返回 0', async () => {
    const { docId: parentId } = await createDocumentStub(ctx, { sourceUri: 'file:///u2.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, parentId, 'parsing', 'u1');
    const { docId: c1 } = await createDocumentStub(ctx, { sourceUri: 'file:///u2.pdf', userId: 'u1' });
    seedUnit(parentId, c1, 'pending', 1);

    await expect(failStuckUnitsUnderTerminalDocuments(ctx)).resolves.toBe(0);
    expect(unitStatus(c1)).toBe('pending');
  });

  it('空库/终态文档无 unit -> 返回 0(无害)', async () => {
    await expect(failStuckUnitsUnderTerminalDocuments(ctx)).resolves.toBe(0);

    const { docId: parentId } = await createDocumentStub(ctx, { sourceUri: 'file:///u3.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, parentId, 'failed', 'u1');
    await expect(failStuckUnitsUnderTerminalDocuments(ctx)).resolves.toBe(0);
  });

  it('幂等: 第二次调用返回 0', async () => {
    const { docId: parentId } = await createDocumentStub(ctx, { sourceUri: 'file:///u4.pdf', userId: 'u1' });
    await setDocumentParseStatus(ctx, parentId, 'parsed', 'u1');
    const { docId: c1 } = await createDocumentStub(ctx, { sourceUri: 'file:///u4.pdf', userId: 'u1' });
    seedUnit(parentId, c1, 'processing', 1);

    await expect(failStuckUnitsUnderTerminalDocuments(ctx)).resolves.toBe(1);
    await expect(failStuckUnitsUnderTerminalDocuments(ctx)).resolves.toBe(0);
  });
});

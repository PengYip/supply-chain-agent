import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, migrate, type SqliteDbContext } from '../../../src/pipeline/db/client.js';
import { saveChunks } from '../../../src/pipeline/db/repositories.js';
import { buildRecallDocumentsTool } from '../../../src/pipeline/tools/recall.js';

// recall_documents fullText mode (spec docs/superpowers/specs/2026-08-28-
// recall-fulltext-design.md): short hit documents come back as whole-document
// text (mode:'fullText' + documents[]), over-budget docs degrade to the plain
// snippet shape and are listed in degradedDocIds. fts strategy only -- no
// embedder needed; the budgets and degradation logic are strategy-agnostic
// (shared withFullText post-processor on every return path).

const USER = 'u-fulltext';

let ctx: SqliteDbContext;

async function addDoc(id: string, chunks: Array<{ text: string; index: number }>): Promise<void> {
  ctx.sqlite.prepare(
    'INSERT INTO documents (id, doc_type, modality, source_uri, block_model, user_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, '合同', 'digital', `/tmp/${id}.pdf`, '{}', USER);
  await saveChunks(ctx, id, chunks);
}

/** char-exact filler: keeps token + unique prefix so bm25 stays selective. */
function filler(token: string, n: number, seq: number): string {
  return `${token}-${seq} ${'字'.repeat(Math.max(0, n))}`;
}

function makeTool() {
  return buildRecallDocumentsTool({ ctx, userId: USER });
}

describe('recall_documents fullText mode', () => {
  beforeAll(async () => {
    ctx = createDb(':memory:');
    migrate(ctx.sqlite);
    // SMALL: 3 tiny chunks (~120 chars total) -> qualifies for fullText.
    await addDoc('DOC-small', [
      { text: filler('质量奖罚锚点', 20, 1), index: 0 },
      { text: filler('质量奖罚锚点', 20, 2), index: 1 },
      { text: filler('质量奖罚锚点', 20, 3), index: 2 },
    ]);
    // BIG: single 9000-char chunk -> exceeds FULLTEXT_PER_DOC_CHARS (8000).
    await addDoc('DOC-big', [{ text: filler('质量奖罚锚点', 8980, 4), index: 0 }]);
    // MID: two 6000-char chunks (12K+ total) -> per-doc budget exceeded.
    await addDoc('DOC-mid', [
      { text: filler('质量奖罚锚点', 5980, 5), index: 0 },
      { text: filler('质量奖罚锚点', 5980, 6), index: 1 },
    ]);
  });

  it('short hit documents return as whole-document text with budgets enforced', async () => {
    const res = (await makeTool().execute!(
      { query: '质量奖罚锚点', limit: 5, strategy: 'fts', tagMode: 'any' },
      { toolCallId: 't1', messages: [] },
    )) as Record<string, unknown>;
    expect(res.mode).toBe('fullText');
    const docs = res.documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(1);
    expect(docs[0]!.document_id).toBe('DOC-small');
    expect(docs[0]!.chunk_count).toBe(3);
    expect(String(docs[0]!.text)).toContain('质量奖罚锚点-1');
    expect(String(docs[0]!.text)).toContain('质量奖罚锚点-3');
    // untrusted full text stays injection-wrapped, like snippets.
    expect(String(docs[0]!.text)).toContain('<external_content source="document">');
    const degraded = res.degradedDocIds as string[];
    expect(degraded).toContain('DOC-big');
    expect(degraded).toContain('DOC-mid');
    // snippets still ride along for the degraded docs.
    const matches = res.matches as Array<Record<string, unknown>>;
    expect(matches.length).toBeGreaterThan(0);
  });

  it('fullText:false keeps the legacy snippet-only shape', async () => {
    const res = (await makeTool().execute!(
      { query: '质量奖罚锚点', limit: 5, strategy: 'fts', tagMode: 'any', fullText: false },
      { toolCallId: 't2', messages: [] },
    )) as Record<string, unknown>;
    expect(res.mode).toBeUndefined();
    expect(res.documents).toBeUndefined();
    expect((res.matches as unknown[]).length).toBeGreaterThan(0);
  });

  it('cumulative budget stops inclusion across documents', async () => {
    // three ~7K docs: first two fit 16000 cumulative, third must degrade.
    await addDoc('DOC-c1', [{ text: filler('累计预算锚点', 6980, 7), index: 0 }]);
    await addDoc('DOC-c2', [{ text: filler('累计预算锚点', 6980, 8), index: 0 }]);
    await addDoc('DOC-c3', [{ text: filler('累计预算锚点', 6980, 9), index: 0 }]);
    const res = (await makeTool().execute!(
      { query: '累计预算锚点', limit: 10, strategy: 'fts', tagMode: 'any' },
      { toolCallId: 't3', messages: [] },
    )) as Record<string, unknown>;
    expect(res.mode).toBe('fullText');
    const docs = res.documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(2);
    const degraded = res.degradedDocIds as string[];
    expect(degraded).toContain('DOC-c3');
    // every included doc respects the per-doc bound as well.
    for (const d of docs) expect(Number(d.chars)).toBeLessThanOrEqual(8000);
  });

  it('no hits -> plain empty output, no fullText fields', async () => {
    const res = (await makeTool().execute!(
      { query: '完全无关词xyzq', limit: 5, strategy: 'fts', tagMode: 'any' },
      { toolCallId: 't4', messages: [] },
    )) as Record<string, unknown>;
    expect(res.matchCount).toBe(0);
    expect(res.mode).toBeUndefined();
    expect(res.documents).toBeUndefined();
  });
});

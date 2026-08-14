import { describe, it, expect, vi } from 'vitest';
import {
  runAutoExtraction,
  DEFAULT_AUTO_EXTRACTION_TIMEOUT_MS,
  type AutoExtractionDeps,
  type AutoExtractionResult,
} from '../../src/pipeline/autoExtraction.js';
import type { DbContext } from '../../src/pipeline/db/client.js';
import type { BlockModel } from '../../src/pipeline/types.js';

// Minimal opaque DB context -- deps are mocked so ctx is only forwarded,
// never actually queried. Cast keeps the test free of better-sqlite3 setup.
const ctx = { backend: 'sqlite' } as unknown as DbContext;

const blockModel: BlockModel = {
  docId: 'DOC-1',
  docType: '合同',
  modality: 'digital',
  blocks: [
    { id: 'b0', type: 'kv', text: '合同号: HT-2024-001', page: 1, bbox: null, ocrConfidence: 1 },
  ],
  sourceUri: 'u',
  createdAt: '2026-08-14T00:00:00.000Z',
};

// Canonical "happy path" extract result. fields is a record (save shape),
// not the ExtractedField[] array -- mirroring documentEntry.ts conversion.
const extracted: AutoExtractionResult = {
  fields: {
    合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 5, end: 16 }] },
    甲方: { value: 'ACME', sourceSpans: [{ blockId: 'b0', start: 0, end: 4 }] },
  },
  fieldMeta: {
    合同号: { strength: 'exact', confidence: 0.98 },
    甲方: { strength: 'exact', confidence: 0.9 },
  },
  proposedRelationships: [
    { kind: 'Contract', name: 'HT-2024-001', confidence: 0.98 },
    { kind: 'Party', role: '买方', name: 'ACME', confidence: 0.9 },
  ],
};

function depsFactory(overrides: Partial<AutoExtractionDeps> = {}): AutoExtractionDeps {
  return {
    extract: vi.fn(async () => extracted),
    save: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('runAutoExtraction', () => {
  it('success: saves extracted fields and returns ok + counts', async () => {
    const deps = depsFactory();

    const out = await runAutoExtraction({
      ctx,
      docId: 'DOC-1',
      blockModel,
      userId: 'u1',
      deps,
    });

    expect(out).toEqual({ status: 'ok', fieldCount: 2, relationshipCount: 2 });

    // extract received the blockModel.
    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(deps.extract).toHaveBeenCalledWith(blockModel);

    // save received the extracted records + forwarded ctx/docId/userId.
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.save).toHaveBeenCalledWith({
      ctx,
      docId: 'DOC-1',
      fields: extracted.fields,
      fieldMeta: extracted.fieldMeta,
      proposedRelationships: extracted.proposedRelationships,
      userId: 'u1',
    });

    // setStatus stamped 'ok'.
    expect(deps.setStatus).toHaveBeenCalledWith({ ctx, docId: 'DOC-1', status: 'ok', userId: 'u1' });
  });

  it("success: setStatus is optional (unset -> not called, still 'ok')", async () => {
    const { setStatus, ...rest } = depsFactory();
    void setStatus; // intentionally dropped
    const deps = rest as AutoExtractionDeps;

    const out = await runAutoExtraction({ ctx, docId: 'DOC-1', blockModel, deps });
    expect(out.status).toBe('ok');
    expect(out.fieldCount).toBe(2);
  });

  it('extract throws -> returns failed, save NOT called, status stamped failed', async () => {
    const deps = depsFactory({
      extract: vi.fn(async () => {
        throw new Error('model 500');
      }),
    });

    const out = await runAutoExtraction({ ctx, docId: 'DOC-1', blockModel, deps });

    expect(out.status).toBe('failed');
    expect(out.reason).toBe('model 500');
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith({ ctx, docId: 'DOC-1', status: 'failed' });
  });

  it('save throws -> returns failed with save reason (extract did run)', async () => {
    const deps = depsFactory({
      save: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });

    const out = await runAutoExtraction({ ctx, docId: 'DOC-1', blockModel, deps });

    expect(out.status).toBe('failed');
    expect(out.reason).toBe('db locked');
    expect(deps.extract).toHaveBeenCalledTimes(1);
    expect(deps.setStatus).toHaveBeenCalledWith({ ctx, docId: 'DOC-1', status: 'failed' });
  });

  it('timeout -> returns skipped(reason:"timeout"), save NOT called', async () => {
    // extract never resolves; tiny timeout so the race trips immediately.
    const deps = depsFactory({
      extract: vi.fn(() => new Promise<AutoExtractionResult>(() => {})),
    });

    const out = await runAutoExtraction({
      ctx,
      docId: 'DOC-1',
      blockModel,
      deps,
      timeoutMs: 15,
    });

    expect(out).toEqual({ status: 'skipped', reason: 'timeout' });
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith({ ctx, docId: 'DOC-1', status: 'skipped' });
  });

  it('does not rethrow: an unexpected thrown value is stringified into reason', async () => {
    const deps = depsFactory({
      extract: vi.fn(async () => {
        throw 'weird non-error'; // eslint-disable-line no-throw-literal
      }),
    });
    const out = await runAutoExtraction({ ctx, docId: 'DOC-1', blockModel, deps });
    expect(out.status).toBe('failed');
    expect(out.reason).toBe('weird non-error');
  });

  it('default timeout is 60s', () => {
    expect(DEFAULT_AUTO_EXTRACTION_TIMEOUT_MS).toBe(60_000);
  });
});

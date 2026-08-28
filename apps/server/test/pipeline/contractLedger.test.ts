import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeContractNo,
  buildLedgerEntryFromExtraction,
} from '../../src/pipeline/contractLedger.js';
import { createDb, migrate } from '../../src/pipeline/db/client.js';
import {
  upsertContractLedgerEntry,
  findContractLedgerByNo,
} from '../../src/pipeline/db/repositories.js';

const span = { blockId: 'b1', start: 0, end: 4 };

describe('normalizeContractNo', () => {
  it('maps full-width ASCII back to half-width and uppercases', () => {
    expect(normalizeContractNo(' ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01 ')).toBe(
      'CJXC-CTCL-JY-2024-131-01',
    );
    expect(normalizeContractNo('ht-2024-001')).toBe('HT-2024-001');
  });

  it('drops whitespace (incl. full-width U+3000 and zero-width U+200B) and illegal chars', () => {
    expect(normalizeContractNo('HT\u3000\u200B2024 / ABC_1')).toBe('HT2024ABC1');
    expect(normalizeContractNo('合同号：无')).toBe('');
  });

  it('keeps parentheses as part of the contract identity', () => {
    expect(normalizeContractNo('2021-znfxcg(t1)-010')).toBe('2021-ZNFXCG(T1)-010');
    expect(normalizeContractNo('２０２１－ＺＮＦＸＣＧ（Ｔ１）－０１０')).toBe(
      '2021-ZNFXCG(T1)-010',
    );
  });

  it('returns empty string for empty / whitespace-only input', () => {
    expect(normalizeContractNo('')).toBe('');
    expect(normalizeContractNo('   ')).toBe('');
  });
});

describe('buildLedgerEntryFromExtraction', () => {
  it('returns null when no contract-number field exists', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: { 金额: { value: 100, sourceSpans: [] } },
      fieldMeta: { 金额: { strength: 'exact', confidence: 0.9 } },
    });
    expect(entry).toBeNull();
  });

  it('合同名称为空串(模板保底空值)时标题回退 标的物, 不被空串遮蔽', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-1', sourceSpans: [] },
        合同名称: { value: '', sourceSpans: [] },
        标的物: { value: '动力煤', sourceSpans: [] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.95 },
        合同名称: { strength: 'none', confidence: 0 },
        标的物: { strength: 'exact', confidence: 0.9 },
      },
    });
    expect(entry!.title).toBe('动力煤');
  });

  it('returns null when the contract number normalizes to empty', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: { 合同号: { value: '   ', sourceSpans: [] } },
      fieldMeta: { 合同号: { strength: 'none', confidence: 0.5 } },
    });
    expect(entry).toBeNull();
  });

  it('空值保底字段: 合同号在 -> 台账行含空字段且 needsReview; 合同号空 -> 无台账行', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-1', sourceSpans: [] },
        质量标准: { value: '', sourceSpans: [] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.95 },
        质量标准: { strength: 'none', confidence: 0 },
      },
    });
    expect(entry).not.toBeNull();
    expect(entry!.fields['质量标准']!.value).toBe('');
    expect(entry!.needsReview).toBe(true);

    const noEntry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: { 质量标准: { value: '', sourceSpans: [] } },
      fieldMeta: { 质量标准: { strength: 'none', confidence: 0 } },
    });
    expect(noEntry).toBeNull();
  });

  it('builds an entry with normalized key, 标的物 title fallback and mean confidence', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: {
        合同号: { value: ' ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01 ', sourceSpans: [span] },
        标的物: { value: '动力煤', sourceSpans: [span] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.95 },
        标的物: { strength: 'exact', confidence: 0.85 },
      },
    });
    expect(entry?.contractNo).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(entry?.displayContractNo).toBe(' ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01 ');
    expect(entry?.title).toBe('动力煤'); // no 合同名称 -> falls back to 标的物
    expect(entry?.overallConfidence).toBeCloseTo(0.9); // (0.95 + 0.85) / 2
    expect(entry?.needsReview).toBe(false);
    expect(entry?.userId).toBe('');
    expect(entry?.docType).toBe('合同');
    expect(entry?.documentId).toBe('DOC-1');
  });

  it('takes 合同名称 as title and flags needsReview when any confidence < 0.7', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-2',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-2024-001', sourceSpans: [span] },
        合同名称: { value: '焦炭采购合同', sourceSpans: [span] },
        备注: { value: 'x', sourceSpans: [] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.9 },
        合同名称: { strength: 'fuzzy', confidence: 0.6 },
        备注: { strength: 'none', confidence: 0.5 },
      },
    });
    expect(entry?.title).toBe('焦炭采购合同');
    expect(entry?.needsReview).toBe(true);
    expect(entry?.overallConfidence).toBeCloseTo((0.9 + 0.6 + 0.5) / 3);
  });

  it('prefers the higher-confidence field when both 合同号 and 合同编号 exist', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-3',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-A-001', sourceSpans: [span] },
        合同编号: { value: 'HT-B-002', sourceSpans: [span] },
      },
      fieldMeta: {
        合同号: { strength: 'fuzzy', confidence: 0.55 },
        合同编号: { strength: 'exact', confidence: 0.95 },
      },
    });
    expect(entry?.contractNo).toBe('HT-B-002');
    expect(entry?.displayContractNo).toBe('HT-B-002');
  });

  it('contractType 未传 -> null', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-4',
      docType: '合同',
      fields: { 合同号: { value: 'HT-2024-004', sourceSpans: [span] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.9 } },
    });
    expect(entry?.contractType).toBeNull();
  });

  it('contractType 传销售 -> 透传', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-5',
      docType: '合同',
      fields: { 合同号: { value: 'HT-2024-005', sourceSpans: [span] } },
      fieldMeta: { 合同号: { strength: 'exact', confidence: 0.9 } },
      contractType: '销售',
    });
    expect(entry?.contractType).toBe('销售');
  });
});

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

/** Build a valid entry (never null) for DB tests. */
function build(documentId: string, rawNo: string, userId?: string) {
  return buildLedgerEntryFromExtraction({
    documentId,
    docType: '合同',
    fields: {
      合同号: { value: rawNo, sourceSpans: [span] },
      合同名称: { value: '合同A', sourceSpans: [span] },
    },
    fieldMeta: {
      合同号: { strength: 'exact', confidence: 0.95 },
      合同名称: { strength: 'exact', confidence: 0.9 },
    },
    userId,
  })!;
}

describe('upsertContractLedgerEntry', () => {
  it('is idempotent per (contract_no, user_id): second write updates, no duplicate row', async () => {
    const first = build('DOC-1', 'HT-2024-001');
    const second = build('DOC-2', 'HT-2024-001'); // same key, different source doc
    await upsertContractLedgerEntry(ctx, first);
    await upsertContractLedgerEntry(ctx, second);

    const count = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM contract_ledger').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
    const row = ctx.sqlite
      .prepare('SELECT document_id, title FROM contract_ledger')
      .get() as { document_id: string; title: string };
    expect(row.document_id).toBe('DOC-2'); // second write won
    expect(row.title).toBe('合同A');
  });

  it('contract_type 落库并在再 upsert 时更新(ON CONFLICT SET 生效)', async () => {
    const first = { ...build('DOC-1', 'HT-2024-100'), contractType: '采购' as const };
    await upsertContractLedgerEntry(ctx, first);
    expect((await findContractLedgerByNo(ctx, 'HT-2024-100'))?.contractType).toBe('采购');

    const second = { ...build('DOC-2', 'HT-2024-100'), contractType: '销售' as const };
    await upsertContractLedgerEntry(ctx, second);
    const after = await findContractLedgerByNo(ctx, 'HT-2024-100');
    expect(after?.contractType).toBe('销售');
    expect(after?.documentId).toBe('DOC-2'); // same update path as other columns
  });
});

describe('findContractLedgerByNo', () => {
  it('matches a stored row via an un-normalized query key (full-width + spaces + lowercase)', async () => {
    const entry = build('DOC-1', 'CJXC-CTCL-JY-2024-131-01');
    await upsertContractLedgerEntry(ctx, entry);

    const found = await findContractLedgerByNo(ctx, ' ｃｊｘｃ－ｃｔｃｌ－ｊｙ－2024-131-01 ');
    expect(found).not.toBeNull();
    expect(found?.contractNo).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(found?.displayContractNo).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(found?.documentId).toBe('DOC-1');
    expect(found?.title).toBe('合同A');
    expect(found?.fields['合同号']?.value).toBe('CJXC-CTCL-JY-2024-131-01');
    expect(found?.fieldMeta['合同号']?.confidence).toBe(0.95);
    expect(found?.overallConfidence).toBeCloseTo(0.925); // (0.95 + 0.9) / 2
    expect(found?.needsReview).toBe(false);
  });

  it('returns null for a missing contract number or an unusable key', async () => {
    expect(await findContractLedgerByNo(ctx, 'NOPE-1')).toBeNull();
    expect(await findContractLedgerByNo(ctx, '   ')).toBeNull();
  });
});

describe('user isolation (legacy uid filter)', () => {
  it('keeps scoped rows private: user B cannot see user A row, user A can', async () => {
    await upsertContractLedgerEntry(ctx, build('DOC-1', 'HT-2024-001', 'u-a'));

    expect(await findContractLedgerByNo(ctx, 'HT-2024-001', 'u-b')).toBeNull();
    const own = await findContractLedgerByNo(ctx, 'HT-2024-001', 'u-a');
    expect(own?.userId).toBe('u-a');
    // Unscoped caller skips the user filter entirely -> sees the row.
    expect(await findContractLedgerByNo(ctx, 'HT-2024-001')).not.toBeNull();
  });

  it('exposes legacy rows (user_id = "") to any scoped caller (3-way OR)', async () => {
    await upsertContractLedgerEntry(ctx, build('DOC-2', 'HT-2024-002')); // unscoped -> user_id ''

    const byB = await findContractLedgerByNo(ctx, 'HT-2024-002', 'u-b');
    expect(byB?.userId).toBe('');
  });
});

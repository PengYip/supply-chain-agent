import { describe, it, expect } from 'vitest';
import {
  bucketContractDoc,
  collectContractDocTypeNames,
  summarizeBuckets,
  type RepairCandidateRow,
} from '../../src/pipeline/repairCandidates.js';

// P3 存量合同台账修复脚本(reprocessContracts)的纯函数部分:
// 候选分桶 + 合同子树类型名收集 + 桶统计。不触 DB; DB 查询与管道执行在脚本薄壳内。

const row = (over: Partial<RepairCandidateRow>): RepairCandidateRow => ({
  id: 'DOC-x',
  docType: '合同',
  parseStatus: null,
  extractionStatus: null,
  hasExtractionRow: false,
  hasLedgerRow: false,
  ...over,
});

describe('bucketContractDoc 分桶', () => {
  it('uploaded -> full-pipeline(完整 解析->抽取->台账 管道)', () => {
    expect(bucketContractDoc(row({ parseStatus: 'uploaded' }))).toBe('full-pipeline');
  });

  it('parsed 且 extraction ok 且无台账 -> ledger-only(用现有 fields 补写, 不重跑 LLM)', () => {
    expect(
      bucketContractDoc(
        row({ parseStatus: 'parsed', extractionStatus: 'ok', hasExtractionRow: true }),
      ),
    ).toBe('ledger-only');
  });

  it('parse failed 且有 extraction 行 -> ledger-only(fields 可用, 如 DOC-mt8gk545 类)', () => {
    expect(
      bucketContractDoc(row({ parseStatus: 'failed', extractionStatus: 'ok', hasExtractionRow: true })),
    ).toBe('ledger-only');
    expect(
      bucketContractDoc(row({ parseStatus: 'failed', extractionStatus: null, hasExtractionRow: true })),
    ).toBe('ledger-only');
  });

  it('已有台账行(document_id 命中) -> skip(一律跳过)', () => {
    expect(bucketContractDoc(row({ parseStatus: 'uploaded', hasLedgerRow: true }))).toBe('skip');
    expect(
      bucketContractDoc(
        row({ parseStatus: 'parsed', extractionStatus: 'ok', hasExtractionRow: true, hasLedgerRow: true }),
      ),
    ).toBe('skip');
  });

  it('不可判定组合 -> skip(parsed 但无 ok 抽取 -> 属启动回填/extractionBackfill 职责)', () => {
    // parsed + 抽取非 ok: 启动回填 findBackfillCandidates 已覆盖, 不在脚本范围。
    expect(
      bucketContractDoc(row({ parseStatus: 'parsed', extractionStatus: 'skipped', hasExtractionRow: false })),
    ).toBe('skip');
    expect(bucketContractDoc(row({ parseStatus: 'needs_ocr' }))).toBe('skip');
    expect(bucketContractDoc(row({ parseStatus: null }))).toBe('skip');
  });
});

describe('collectContractDocTypeNames 合同子树(含别名层)', () => {
  const types = [
    { kind: 'doc_type', name: '合同', parentId: null },
    { kind: 'doc_type', name: '补充合同', parentId: 'dt-合同' },
    { kind: 'doc_type', name: '采购合同', parentId: 'dt-合同' },
    { kind: 'doc_type', name: '补充协议', parentId: 'dt-补充合同' },
    { kind: 'doc_type', name: '发票', parentId: 'dt-履约凭证' },
    { kind: 'contract_type', name: '采购', parentId: null },
  ] as Array<{ kind: string; name: string; parentId: string | null }>;

  it('收集 合同 自身 + 全部后代(多层), 不含其它粗类与 contract_type', () => {
    const names = collectContractDocTypeNames(types);
    expect(names).toContain('合同');
    expect(names).toContain('补充合同');
    expect(names).toContain('采购合同');
    expect(names).toContain('补充协议');
    expect(names).not.toContain('发票');
    expect(names).not.toContain('采购');
  });
});

describe('summarizeBuckets 统计', () => {
  it('按桶计数供脚本打印', () => {
    const s = summarizeBuckets([
      row({ id: 'a', parseStatus: 'uploaded' }),
      row({ id: 'b', parseStatus: 'uploaded', hasLedgerRow: true }),
      row({ id: 'c', parseStatus: 'parsed', extractionStatus: 'ok', hasExtractionRow: true }),
    ]);
    expect(s).toEqual({ 'full-pipeline': 1, 'ledger-only': 1, skip: 1 });
  });
});

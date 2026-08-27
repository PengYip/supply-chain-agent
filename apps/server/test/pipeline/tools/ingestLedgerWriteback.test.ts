import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../../../src/pipeline/templateSeed.js';
import { env } from '../../../src/env.js';
import { ingestFile, processDocument, ensureDocumentExtracted } from '../../../src/pipeline/tools/documentEntry.js';
import { findContractLedgerByNo } from '../../../src/pipeline/db/repositories.js';

// Bug B(用户验收): 上传快捷路径 ingestFile 的 auto-extraction 只挂了
// buildAutoExtractionDeps, 没有像 processDocument / extractionBackfill 那样包一层
// buildLedgerWritingDeps, 导致经此路径抽取的合同不回写 contract_ledger。
// 本文件证明: ingestFile 抽取到含合同号的字段后必须产生台账行(doc_type 跟随
// 分类后的 docType)。先红后绿的回归锚点。

let ctx: ReturnType<typeof createDb>;
let dir: string;
beforeEach(async () => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);
  // ingest_file 的 assertWithinRoot 针对 env.INGEST_ROOT 做路径白名单,
  // fixture 必须落在其内(同 documentEntry.test.ts 模式), 每用例独立子目录。
  dir = join(env.INGEST_ROOT, `ilw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
});

// Fake LanguageModelV2: doGenerate 返回接地抽取 schema 认可的 JSON
// (单字段 合同号 -> normalizeContractNo 后可建台账键)。
const stubModel = {
  specificationVersion: 'v2' as const,
  provider: 'fake',
  modelId: 'fake-model',
  supportedUrls: {} as Record<string, RegExp[]>,
  async doGenerate() {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            fields: {
              合同号: {
                value: 'HT-2024-100',
                sourceSpans: [{ blockId: 'b0', start: 4, end: 15 }],
              },
            },
            llmConsistency: 0.95,
          }),
        },
      ],
      finishReason: 'stop' as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [] as unknown[],
    };
  },
  async doStream() {
    throw new Error('doStream not used by extract_fields');
  },
} as any;

describe('ingestFile 抽取 -> 合同台账回写(Bug B)', () => {
  it('快捷路径抽取含合同号的字段后产生 contract_ledger 行, doc_type 跟随分类结果', async () => {
    const f = join(dir, 'c.txt');
    writeFileSync(f, '合同号：HT-2024-100\n', 'utf-8');

    const res = await ingestFile({
      ctx,
      sourcePath: f,
      docType: '合同',
      modality: 'digital',
      extraction: { model: stubModel },
    });

    const entry = await findContractLedgerByNo(ctx, 'HT-2024-100');
    expect(entry).not.toBeNull();
    expect(entry!.documentId).toBe(res.docId);
    expect(entry!.docType).toBe('合同');
    expect(entry!.contractNo).toBe('HT-2024-100');
  });
});

// 小修 1(P3 后端): ensureDocumentExtracted 的重抽取路径与 ingestFile 同模式
// 漏挂 buildLedgerWritingDeps —— 超时补抽成功的合同同样不回写台账。
describe('ensureDocumentExtracted 重抽取 -> 合同台账回写(小修 1)', () => {
  it('补抽含合同号的字段后产生 contract_ledger 行', async () => {
    const f = join(dir, 'ensure.txt');
    writeFileSync(f, '合同号：HT-2024-200\n', 'utf-8');

    // 先经 processDocument 无 extraction 解析到 parsed(extraction_status 保持 NULL,
    // 无抽取行 -> ensureDocumentExtracted 判定需重抽), 再以 extraction 依赖触发补抽。
    const { createDocumentStub } = await import('../../../src/pipeline/db/repositories.js');
    const { docId } = await createDocumentStub(ctx, { sourceUri: f, docType: '合同' });
    await processDocument(ctx, docId, { docType: '合同', modality: 'digital' });

    // 补抽模型的字段值改为 HT-2024-200 以匹配本用例 fixture。
    const model = {
      ...stubModel,
      async doGenerate() {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                fields: {
                  合同号: {
                    value: 'HT-2024-200',
                    sourceSpans: [{ blockId: 'b0', start: 4, end: 15 }],
                  },
                },
                llmConsistency: 0.95,
              }),
            },
          ],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [] as unknown[],
        };
      },
    } as any;

    const res = await ensureDocumentExtracted(ctx, docId, { extraction: { model } });

    expect(res.extractionStatus).toBe('ok');
    const entry = await findContractLedgerByNo(ctx, 'HT-2024-200');
    expect(entry).not.toBeNull();
    expect(entry!.documentId).toBe(docId);
    expect(entry!.docType).toBe('合同');
  });
});

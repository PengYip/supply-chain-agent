// 批量拆分器 Phase 2 端到端实查工具(不落业务库): 内存 SQLite + 模板种子,
// 对一个 PDF 跑 processDocumentWithBatch 全链路(检测 -> container OCR ->
// 逐 unit 裁剪图 VLM 抽取 -> 两遍共识), 打印逐 unit 的检测/抽取/复核结论。
//
// RUN (on the server, project root, with VLM env sourced):
//   export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
//   npx tsx apps/server/scripts/processBatch.ts /path/to/file.pdf \
//     [--concurrency 4] [--keep]
//
// 说明:
//  - 文件会被复制到 INGEST_ROOT 下的临时目录(container OCR 的 parse 走
//    assertWithinRoot), 结束后删除(--keep 保留);
//  - 内存库 + ensureTemplateSeed, 不触碰任何业务数据;
//  - 旋回双候选择优日志见 [perf-batch-split] unit ... 旋回双候选 行。

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createDb, migrate } from '../src/pipeline/db/client.js';
import { ensureTemplateSeed } from '../src/pipeline/templateSeed.js';
import {
  createDocumentStub,
  listDocumentUnitsByParent,
  loadLatestExtractionByDocId,
} from '../src/pipeline/db/repositories.js';
import { processDocumentWithBatch } from '../src/pipeline/tools/documentEntry.js';
import { env } from '../src/env.js';

function intFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number.parseInt(process.argv[i + 1]!, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface UnitManifest {
  formType?: string;
  identifier?: string | null;
  evidence?: string;
  regions?: Array<{ page: number; rotationDeg: number }>;
}

/** 打印抽取读数摘要(编号类 + 重量类首行)。 */
function pick(fields: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = fields[k];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const row = v[0] as Record<string, unknown> | undefined;
      if (row && typeof row === 'object') {
        const inner = Object.entries(row)
          .filter(([, rv]) => rv !== null && rv !== undefined)
          .map(([rk, rv]) => `${rk}=${String(rv)}`)
          .join(' ');
        if (inner) return `${k}[0]{${inner}}`;
      }
      continue;
    }
    if (typeof v === 'object') continue;
    return `${k}=${String(v)}`;
  }
  return '';
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const sourcePath = positional[0];
  if (!sourcePath) {
    console.error('用法: npx tsx apps/server/scripts/processBatch.ts <pdf> [--concurrency N] [--keep]');
    process.exit(2);
  }
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) {
    console.error('VLM_BASE_URL / VLM_API_KEY 未配置, 无法做拆分与凭证抽取');
    process.exit(2);
  }
  env.BATCH_SPLIT_ENABLED = true;
  env.BATCH_SPLIT_CONCURRENCY = intFlag('--concurrency', env.BATCH_SPLIT_CONCURRENCY);

  const ctx = createDb(':memory:');
  migrate(ctx.sqlite);
  await ensureTemplateSeed(ctx);

  const dir = join(env.INGEST_ROOT, `batch-check-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(sourcePath).replace(/[^\w.-]+/g, '_'));
  copyFileSync(sourcePath, target);

  try {
    const { docId } = await createDocumentStub(ctx, { sourceUri: target, userId: 'batch-check' });
    const t0 = performance.now();
    const res = await processDocumentWithBatch(ctx, docId, { modality: 'scanned', userId: 'batch-check' });
    console.log(
      `[processBatch] container ${Math.round(performance.now() - t0)}ms parseStatus=${res.parseStatus}` +
      ` blockCount=${res.blockCount} units=${res.batchSplit?.unitCount ?? 0}`,
    );

    const units = await listDocumentUnitsByParent(ctx, docId);
    for (const u of units) {
      const m = (u.manifest ?? {}) as UnitManifest;
      const regions = (m.regions ?? []).map((r) => `p${r.page}@${r.rotationDeg}`).join(',');
      console.log(
        `[unit ${u.unitIndex}] ${m.formType ?? u.docType} pages=${u.pageStart}-${u.pageEnd} regions=${regions}` +
        ` detectId=${m.identifier ?? '-'} conf=${u.detectorConfidence.toFixed(2)} status=${u.status}`,
      );
      console.log(`  evidence: ${m.evidence ?? ''}`);
      if (!u.childDocumentId) continue;
      const chunks = (ctx.sqlite
        .prepare('SELECT COUNT(*) n FROM doc_chunk WHERE document_id = ?')
        .get(u.childDocumentId) as { n: number }).n;
      const ext = await loadLatestExtractionByDocId(ctx, u.childDocumentId, 'batch-check');
      if (!ext) {
        console.log(`  extraction: none (child=${u.childDocumentId} chunks=${chunks})`);
        continue;
      }
      const readings = pick(ext.fields, ['报告编号', '编号', '回单编号', '明细行', '总净重_吨', '重量_吨']);
      const warnings = (ext.fieldMeta as Record<string, { warnings?: string[] }>)['_warnings']?.warnings ?? [];
      console.log(
        `  extraction: docType=${ext.docType} needsReview=${ext.needsReview}` +
        ` overall=${ext.overallConfidence.toFixed(2)} chunks=${chunks} ${readings}`,
      );
      for (const w of warnings) console.log(`  warning: ${w}`);
    }
  } finally {
    if (!process.argv.includes('--keep')) {
      rmSync(dir, { recursive: true, force: true });
    } else {
      console.log(`[processBatch] --keep: 保留 ${dir}`);
    }
  }
}

main().catch((e) => {
  console.error('[processBatch] fatal:', e);
  process.exit(1);
});

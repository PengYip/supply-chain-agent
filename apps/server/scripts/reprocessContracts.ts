// P3 存量合同台账修复脚本(一次性维护工具)。
//
// 背景(dev 库实测): 31 份 doc_type=合同 文档缺 contract_ledger 行:
//   - ~24 份 parse_status='uploaded'(storage-only 老上传, 从未跑处理管道);
//   - 2-3 份 parsed + extraction ok 但无台账(启动回填只认 extraction 非 ok, 盖不到);
//   - 1 份 parse failed 但 fields 可用。
//
// 用法(在部署目录, 读根目录 .env):
//   npx tsx apps/server/scripts/reprocessContracts.ts [--dry-run] [--limit N] [--doc-id DOC-xxx ...]
//
// 两条路径(候选分桶见 src/pipeline/repairCandidates.ts):
//   full-pipeline: 与 POST /api/documents/:docId/process 完全同一装配 --
//     ensureDocumentExtracted(ctx, docId, { docType/modality hint + buildIngestDeps() })。
//     路由本身没有内联逻辑可直接复用, 无需提取(该端点只是把这两个导出函数拼在一起,
//     脚本同样拼法, 路由行为零改动)。含台账回写(documentEntry 内部已挂
//     buildLedgerWritingDeps, P3 hotfix/小修1 已补齐三条路径)。
//   ledger-only: 不重跑 LLM。loadLatestExtractionByDocId -> deriveContractType ->
//     buildLedgerEntryFromExtraction -> upsertContractLedgerEntry(幂等 ON CONFLICT),
//     台账行归属沿用 documents.user_id(与正常录入写回同 key 语义)。
//
// 护栏: 每份文档 try/catch 单条隔离; 执行前二次核对台账不存在(防并发窗口);
// 非合同文档不在候选集(doc_type 按模板树 合同 子树收集); 结束打印统计。

// 副作用导入: env.ts 负责加载根目录 .env 并 zod 校验(失败即抛, 快速失败)。
import '../src/env.js';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import type { DbContext } from '../src/pipeline/db/client.js';
import {
  listTemplateTypes,
  loadLatestExtractionByDocId,
  upsertContractLedgerEntry,
  effectiveSelfPartyNamesForDerivation,
} from '../src/pipeline/db/repositories.js';
import { ensureDocumentExtracted } from '../src/pipeline/tools/documentEntry.js';
import { buildIngestDeps } from '../src/pipeline/ingestModel.js';
import {
  bucketContractDoc,
  collectContractDocTypeNames,
  summarizeBuckets,
  type RepairCandidateRow,
} from '../src/pipeline/repairCandidates.js';
import { buildLedgerEntryFromExtraction } from '../src/pipeline/contractLedger.js';
import { deriveContractType } from '../src/domain/contractType.js';
import type { DocType } from '../src/pipeline/types.js';

// ---- CLI -------------------------------------------------------------------

interface CliOptions {
  dryRun: boolean;
  limit: number;
  docIds: string[];
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, limit: Number.POSITIVE_INFINITY, docIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit 需要正整数');
      opts.limit = n;
    } else if (a === '--doc-id') {
      const v = argv[++i];
      if (!v) throw new Error('--doc-id 需要 docId 值');
      opts.docIds.push(v);
    } else {
      throw new Error(`未知参数: ${a}(支持 --dry-run / --limit N / --doc-id X)`);
    }
  }
  return opts;
}

// ---- DB 杂项(双后端小助手) --------------------------------------------------

interface DocCandidateRow extends RepairCandidateRow {
  modality: string | null;
  userId: string | null;
}

async function loadCandidates(ctx: DbContext, typeNames: string[]): Promise<DocCandidateRow[]> {
  const placeholders = typeNames.map(() => '?').join(', ');
  if (ctx.backend === 'postgres') {
    const nums = typeNames.map((_, i) => `$${i + 2}`).join(', ');
    const res = await ctx.pool.query(
      `SELECT d.id, d.doc_type AS "docType", d.parse_status AS "parseStatus",
              d.extraction_status AS "extractionStatus", d.modality, d.user_id AS "userId",
              EXISTS(SELECT 1 FROM extractions e WHERE e.document_id = d.id) AS "hasExtractionRow",
              EXISTS(SELECT 1 FROM contract_ledger l WHERE l.document_id = d.id) AS "hasLedgerRow"
       FROM documents d
       WHERE d.doc_type IN (${nums})
       ORDER BY d.created_at ASC`,
      typeNames,
    );
    return res.rows as unknown as DocCandidateRow[];
  }
  return ctx.sqlite
    .prepare(
      `SELECT d.id, d.doc_type AS docType, d.parse_status AS parseStatus,
              d.extraction_status AS extractionStatus, d.modality, d.user_id AS userId,
              EXISTS(SELECT 1 FROM extractions e WHERE e.document_id = d.id) AS hasExtractionRow,
              EXISTS(SELECT 1 FROM contract_ledger l WHERE l.document_id = d.id) AS hasLedgerRow
       FROM documents d
       WHERE d.doc_type IN (${placeholders})
       ORDER BY d.rowid ASC`,
    )
    .all(...typeNames) as unknown as DocCandidateRow[];
}

async function ledgerRowExists(ctx: DbContext, docId: string): Promise<boolean> {
  if (ctx.backend === 'postgres') {
    const res = await ctx.pool.query('SELECT 1 FROM contract_ledger WHERE document_id = $1 LIMIT 1', [docId]);
    return res.rowCount != null && res.rowCount > 0;
  }
  const row = ctx.sqlite.prepare('SELECT 1 FROM contract_ledger WHERE document_id = ? LIMIT 1').get(docId);
  return row !== undefined;
}

// ---- 两条处理路径 ------------------------------------------------------------

type Outcome =
  | { kind: 'ok'; detail: string }
  | { kind: 'skip'; detail: string }
  | { kind: 'failed'; detail: string };

/** full-pipeline: 与路由 POST /:docId/process 同一装配(ensureDocumentExtracted + buildIngestDeps)。 */
async function runFullPipeline(ctx: DbContext, doc: DocCandidateRow): Promise<Outcome> {
  const ingest = buildIngestDeps();
  const result = await ensureDocumentExtracted(
    ctx,
    doc.id,
    {
      // 上传时的存储类型是最可信的 hint; 分类器在线时仍会按内容确认/纠正。
      docType: (doc.docType || '其他') as DocType,
      modality: doc.modality === 'scanned' ? 'scanned' : 'digital',
      ...ingest,
    },
    // Critical 修复: 必须透传文档归属用户 -- effectiveUserId(undefined)='' 只能
    // 读 user_id=''/NULL 的 legacy 行, dev 库文档归属真实用户, 不传会
    // document_not_found。(4th param userId)
    doc.userId ?? undefined,
  );
  if (result.parseStatus === 'needs_ocr' || result.parseStatus === 'failed') {
    return { kind: 'failed', detail: `parseStatus=${result.parseStatus}` };
  }
  // 管道成功后再核台账是否真的落了行(抽取可能 skipped/failed 或字段缺合同号)。
  return (await ledgerRowExists(ctx, doc.id))
    ? { kind: 'ok', detail: `parse=${result.parseStatus}, extraction=${result.extractionStatus ?? '?'}, ledger=written` }
    : { kind: 'failed', detail: `pipe ok(extraction=${result.extractionStatus ?? '?'}) 但未见台账行(可能缺合同号)` };
}

/** ledger-only: 用现有 extractions.fields 幂等补写台账, 不重跑 LLM。 */
async function runLedgerOnly(ctx: DbContext, doc: DocCandidateRow): Promise<Outcome> {
  // 并发防护窗: 开跑前再核一次台账。
  if (await ledgerRowExists(ctx, doc.id)) return { kind: 'skip', detail: 'has-ledger(raced)' };

  const ex = await loadLatestExtractionByDocId(
    ctx,
    doc.id,
    // Critical 修复: 同上, extraction 行按 owner(或 legacy ''/NULL)过滤, 不传
    // 真实用户的文档会取不到行 -> 假报 no-extraction-row。
    doc.userId ?? undefined,
  );
  if (!ex) return { kind: 'failed', detail: 'no-extraction-row' };

  // 合同类型派生(与录入写回同规则、同名单纯函数)。
  let selfNames: string[] = [];
  try { selfNames = await effectiveSelfPartyNamesForDerivation(ctx); } catch { selfNames = []; }
  const derivation = deriveContractType({
    docType: ex.docType,
    fields: Object.entries(ex.fields).map(([name, f]) => ({ name, value: f.value })),
    selfPartyNames: selfNames,
  });

  // upsert 契约(contractLedger.ts): 合同号缺失/不可归一化 -> 返回 null(如实报失败)。
  const entry = buildLedgerEntryFromExtraction({
    documentId: doc.id,
    docType: doc.docType || ex.docType,
    fields: ex.fields,
    fieldMeta: ex.fieldMeta,
    userId: doc.userId ?? '',
    contractType: derivation.contractType,
  });
  if (!entry) return { kind: 'failed', detail: 'no-usable-contract-no-in-fields' };

  await upsertContractLedgerEntry(ctx, entry);
  return { kind: 'ok', detail: `ledger upserted no=${entry.contractNo} type=${derivation.contractType ?? '-'}` };
}

// ---- 主流程 ------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  console.log(`[reprocessContracts] backend=${process.env.DB_BACKEND ?? 'sqlite(默认)'} dryRun=${cli.dryRun}`);

  const ctx = getDbContext();
  // 幂等: 裸环境(模板表空)会漏候选子树, 先确保种子在位(boot 同款)。
  const { ensureTemplateSeed } = await import('../src/pipeline/templateSeed.js');
  await ensureTemplateSeed(ctx);
  const types = await listTemplateTypes(ctx);
  const contractNames = collectContractDocTypeNames(types.map((t) => ({
    kind: t.kind, name: t.name, parentId: t.parentId,
  })));
  console.log(`[reprocessContracts] 合同子树类型(${contractNames.length}): ${contractNames.join(', ')}`);

  const all = await loadCandidates(ctx, contractNames);
  const buckets = summarizeBuckets(all);
  console.log(`[reprocessContracts] 候选总数=${all.length}, 分桶:`, buckets);

  let actionable = all.filter((r) => bucketContractDoc(r) !== 'skip');
  if (cli.docIds.length > 0) {
    const allow = new Set(cli.docIds);
    actionable = actionable.filter((r) => allow.has(r.id));
  }
  if (Number.isFinite(cli.limit)) actionable = actionable.slice(0, cli.limit);

  if (cli.dryRun) {
    console.log('[reprocessContracts] DRY-RUN 清单:');
    for (const r of actionable) {
      console.log(
        `  ${bucketContractDoc(r).padEnd(14)} ${r.id}  doc_type=${r.docType} parse=${r.parseStatus} extraction=${r.extractionStatus}`,
      );
    }
    console.log(`[reprocessContracts] 共 ${actionable.length} 份将被处理(--dry-run 未执行)。`);
    return;
  }

  let ok = 0, failed = 0, skipped = 0;
  const failures: Array<{ id: string; detail: string }> = [];
  for (const doc of actionable) {
    const bucket = bucketContractDoc(doc);
    try {
      const outcome =
        bucket === 'full-pipeline'
          ? await runFullPipeline(ctx, doc)
          : await runLedgerOnly(ctx, doc);
      if (outcome.kind === 'ok') {
        ok += 1;
        console.log(`[ok]   ${doc.id}: ${outcome.detail}`);
      } else if (outcome.kind === 'skip') {
        skipped += 1;
        console.log(`[skip] ${doc.id}: ${outcome.detail}`);
      } else {
        failed += 1;
        failures.push({ id: doc.id, detail: outcome.detail });
        console.error(`[fail] ${doc.id}: ${outcome.detail}`);
      }
    } catch (e) {
      failed += 1;
      const detail = e instanceof Error ? e.message : String(e);
      failures.push({ id: doc.id, detail });
      console.error(`[fail] ${doc.id}: 异常 ${detail}`);
    }
  }

  console.log('\n==== 统计 ====');
  console.log(`attempted: ${actionable.length}`);
  console.log(`ok: ${ok}`);
  console.log(`skipped-has-ledger/raced: ${skipped}`);
  console.log(`failed: ${failed}`);
  if (failures.length > 0) {
    console.log('失败明细(可 --doc-id 单独重试):');
    for (const f of failures) console.log(`  ${f.id}: ${f.detail}`);
  }
}

main().catch((e) => {
  console.error('[reprocessContracts] 致命错误:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});

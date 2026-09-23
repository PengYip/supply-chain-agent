// One-off repair (2026-09-23 数据治理): 修复被凭证 clobber 的合同台账行。
//
// WHY: upsert 守卫(contractLedgerUpsertWhere)上线前, 后录入的凭证(货转单/磅单...)
// 带 合同号 会整体覆盖台账行的 doc_type/document_id/title/fields——真合同的口径
// 被运单口径 clobber(dev 实测 5 行)。守卫只防新增污染, 存量需一次性回写。
//
// HOW: 找 doc_type 非合同族的台账行, 且存在绑定到同一合同号的 合同/补充合同
// 单据(bindings confirmed 优先)——用该合同单据的最新抽取重走
// buildLedgerEntryFromExtraction + deriveContractType + upsert(守卫放行合同来稿,
// 凭证行就地转化为合同口径)。凭证-only 行(无合同单据)不动: 它们是合法锚点,
// 由本体投影的合同族过滤负责不进「贸易合同」视图。
//
// RUN (on the server, project root):
//   npm run repair:contract-ledger --workspace apps/server -- --dry-run   # preview
//   npm run repair:contract-ledger --workspace apps/server               # apply
//
// 只复用既有写入路径, 不在脚本内重写映射逻辑; 幂等可重跑(修复后行是合同族,
// 二趟扫描自然 no-op)。
import 'dotenv/config';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { numberPlaceholders } from '../src/ontology/asof.js';
import type { DbContext, PostgresDbContext } from '../src/pipeline/db/client.js';
import {
  CONTRACT_FAMILY_DOC_TYPES, buildLedgerEntryFromExtraction,
} from '../src/pipeline/contractLedger.js';
import {
  loadLatestExtractionByDocId, upsertContractLedgerEntry,
} from '../src/pipeline/db/repositories.js';
import { deriveContractType } from '../src/domain/contractType.js';
import type { ContractType } from '../src/domain/tradeSemantics.js';
import { getEffectiveSelfPartyNames } from '../src/pipeline/executionFlow.js';

const USER_SCOPE = "(user_id = ? OR user_id = '' OR user_id IS NULL)";

interface PollutedRow {
  id: string;
  contract_no: string;
  doc_type: string;
  user_id: string | null;
}

interface BoundContractDoc {
  docId: string;
  docType: string;
  status: string;
}

async function query(
  ctx: DbContext, sql: string, params: unknown[],
): Promise<Array<Record<string, unknown>>> {
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), params);
    return res.rows as Array<Record<string, unknown>>;
  }
  return ctx.sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

async function listPolluted(ctx: DbContext): Promise<PollutedRow[]> {
  const family = CONTRACT_FAMILY_DOC_TYPES.map(() => '?').join(',');
  const sql = `SELECT id, contract_no, doc_type, user_id FROM contract_ledger
                WHERE doc_type NOT IN (${family})`;
  const params = [...CONTRACT_FAMILY_DOC_TYPES];
  const rows = await query(ctx, sql, params);
  return rows.map((r) => ({
    id: String(r['id']),
    contract_no: String(r['contract_no']),
    doc_type: String(r['doc_type']),
    user_id: r['user_id'] == null ? null : String(r['user_id']),
  }));
}

/** 绑定到该合同号的合同族单据(confirmed 优先, 录入新者优先)。 */
async function findBoundContractDoc(
  ctx: DbContext, contractNo: string, uid: string,
): Promise<BoundContractDoc | null> {
  const family = CONTRACT_FAMILY_DOC_TYPES.map(() => '?').join(',');
  const sql = `SELECT b.document_id AS doc_id, d.doc_type, b.status, d.created_at
                 FROM bindings b JOIN documents d ON d.id = b.document_id
                WHERE b.contract_no = ? AND b.target_kind = 'Contract'
                  AND d.doc_type IN (${family})
                  AND (b.user_id = ? OR b.user_id = '' OR b.user_id IS NULL)
                  AND (d.user_id = ? OR d.user_id = '' OR d.user_id IS NULL)
                ORDER BY CASE b.status WHEN 'confirmed' THEN 0 ELSE 1 END,
                         d.created_at DESC
                LIMIT 1`;
  const rows = await query(ctx, sql, [contractNo, uid, uid, ...CONTRACT_FAMILY_DOC_TYPES]);
  const r = rows[0];
  return r ? {
    docId: String(r['doc_id']),
    docType: String(r['doc_type']),
    status: String(r['status']),
  } : null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const ctx = getDbContext();
  const polluted = await listPolluted(ctx);
  console.log(`[repair-contract-ledger] 非合同族台账行: ${polluted.length} 行(dry-run=${dryRun})`);

  let repaired = 0;
  let skippedNoDoc = 0;
  let skippedNoExtraction = 0;
  let skippedNoEntry = 0;
  const failures: string[] = [];

  for (const row of polluted) {
    const uid = row.user_id ?? '';
    const bound = await findBoundContractDoc(ctx, row.contract_no, uid);
    if (!bound) { skippedNoDoc += 1; continue; }

    const extraction = await loadLatestExtractionByDocId(ctx, bound.docId, uid);
    if (!extraction) { skippedNoExtraction += 1; continue; }

    // 合同类型派生(与 documentEntry.deriveContractTypeForDoc 同口径)
    let contractType: ContractType | null = null;
    try {
      const selfNames = await getEffectiveSelfPartyNames(ctx);
      contractType = deriveContractType({
        docType: extraction.docType,
        fields: Object.entries(extraction.fields).map(([name, f]) => ({
          name, value: (f as { value: string | number }).value,
        })),
        selfPartyNames: selfNames,
      }).contractType;
    } catch { contractType = null; }

    const entry = buildLedgerEntryFromExtraction({
      documentId: bound.docId,
      docType: extraction.docType,
      fields: extraction.fields as never,
      fieldMeta: extraction.fieldMeta as never,
      userId: uid,
      contractType,
    });
    if (!entry || entry.contractNo !== row.contract_no) {
      // 合同单据抽取的合同号归一后与台账行不同(数据异常): 不动, 报告出来。
      skippedNoEntry += 1;
      console.log(`  [skip] ${row.contract_no}: 合同单据 ${bound.docId} 抽取合同号归一为 ${entry?.contractNo ?? '(空)'}`);
      continue;
    }

    console.log(`  [fix] ${row.contract_no}: ${row.doc_type} -> ${extraction.docType}` +
      ` (doc ${bound.docId.slice(0, 18)}…, bind=${bound.status}${dryRun ? ', DRY-RUN' : ''})`);
    if (dryRun) { repaired += 1; continue; }

    try {
      await upsertContractLedgerEntry(ctx, entry, uid);
      repaired += 1;
    } catch (e) {
      failures.push(`${row.contract_no}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`[repair-contract-ledger] 完成: 修复 ${repaired}(dry-run=${dryRun}), ` +
    `无合同单据 ${skippedNoDoc}, 无抽取 ${skippedNoExtraction}, 合同号不匹配 ${skippedNoEntry}, 失败 ${failures.length}`);
  for (const f of failures) console.log(`  [fail] ${f}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

void main().catch((e) => {
  console.error('[repair-contract-ledger] fatal:', e);
  process.exitCode = 1;
});

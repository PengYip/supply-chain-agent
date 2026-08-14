// 接线闭环: 启动抽取回填。
//
// 重新跑历史上抽取 pending/skipped/failed/NULL 的已解析文档(它们的 block_model
// 已持久化 -- 例如曾因超时 skipped 的 DOC-msslpnju-vhm9), 让合同台账回填齐、
// 抽取状态自愈。不 await(不阻塞启动), 失败只记日志。
//
// 与 processDocument 步骤 11 完全同构: 复用 ingestModel 的懒加载模型/依赖构建
// (buildIngestDeps), 并通过 documentEntry 的 buildLedgerWritingDeps 挂台账回写
// (同一份 wrapper, 不复制粘贴)。

import type { BlockModel } from './types.js';
import type { DbContext } from './db/client.js';
import { runAutoExtraction, buildAutoExtractionDeps } from './autoExtraction.js';
import { buildLedgerWritingDeps } from './tools/documentEntry.js';
import { buildIngestDeps } from './ingestModel.js';

export interface ExtractionBackfillResult {
  attempted: number;
  ok: number;
  failed: number;
}

interface BackfillCandidate {
  id: string;
  blockModelRaw: unknown;
}

/** 候选文档: parse_status='parsed' 且 extraction_status 为 NULL/pending/skipped/failed。 */
async function findBackfillCandidates(
  ctx: DbContext,
  limit: number,
): Promise<BackfillCandidate[]> {
  if (ctx.backend === 'postgres') {
    // postgres 迁移 DDL 里时间列已命名为 created_at; block_model 为 jsonb,
    // 直接返回解析后的对象。
    const res = await ctx.pool.query(
      `SELECT id, block_model AS "blockModelRaw" FROM documents
       WHERE parse_status = 'parsed'
         AND (extraction_status IS NULL OR extraction_status IN ('pending','skipped','failed'))
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return res.rows as BackfillCandidate[];
  }
  const rows = ctx.sqlite
    .prepare(
      `SELECT id, block_model AS blockModelRaw FROM documents
       WHERE parse_status = 'parsed'
         AND (extraction_status IS NULL OR extraction_status IN ('pending','skipped','failed'))
       ORDER BY rowid ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; blockModelRaw: string }>;
  return rows;
}

/** 解析 block_model (pg jsonb 已反序列化, sqlite 是 JSON 文本)。解析失败返回 null。 */
function parseBlockModel(candidate: BackfillCandidate): BlockModel | null {
  try {
    const raw = candidate.blockModelRaw;
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as BlockModel;
  } catch {
    return null;
  }
}

export async function runExtractionBackfill(args: {
  ctx: DbContext;
  limit: number;
}): Promise<ExtractionBackfillResult> {
  const { ctx, limit } = args;
  if (limit <= 0) return { attempted: 0, ok: 0, failed: 0 };

  const candidates = await findBackfillCandidates(ctx, limit);
  // 懒加载的共享 DeepSeek 模型句柄(buildIngestDeps 内部懒加载并缓存)。
  const ingest = buildIngestDeps();

  let ok = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const blockModel = parseBlockModel(candidate);
    if (!blockModel) {
      // 坏 block_model -> 无法抽取, 计 failed 并继续。
      failed += 1;
      continue;
    }
    // 与 processDocument 相同的抽取 deps + 台账回写 wrapper(默认超时即可)。
    const outcome = await runAutoExtraction({
      ctx,
      docId: candidate.id,
      blockModel,
      deps: buildLedgerWritingDeps(
        buildAutoExtractionDeps({ ctx, extraction: ingest.extraction }),
        { ctx, docType: blockModel.docType },
      ),
    });
    if (outcome.status === 'ok') {
      ok += 1;
    } else {
      failed += 1;
    }
  }
  return { attempted: candidates.length, ok, failed };
}

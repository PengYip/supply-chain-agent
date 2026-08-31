import type { BlockModel, DocType, Modality } from './types.js';
import { ingestWithDigital } from './digitalAdapter.js';
import { ingestWithMinerU } from './mineruAdapter.js';
import { ingestWithPaddleOCR } from './paddleocrAdapter.js';
import { env } from '../env.js';
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { recordOcrCall } from '../harness/usageAudit.js';
import { getSessionId } from '../harness/sessionContext.js';

// Scanned-document OCR backend, switched by PARSE_BACKEND (default 'mineru').
// Both adapters honor their `<file>.*.json` hermetic sidecars for tests.
const ingestWithScannedOCR =
  env.PARSE_BACKEND === 'qianfan' ? ingestWithPaddleOCR : ingestWithMinerU;
const ocrLabel = env.PARSE_BACKEND === 'qianfan' ? 'qianfan' : 'mineru';
const ocrSidecar = env.PARSE_BACKEND === 'qianfan' ? '.paddleocr.json' : '.mineru.json';

export interface ParseDocumentInput {
  /** Absolute path inside INGEST_ROOT (caller enforces the allowlist). */
  sourcePath: string;
  docType: DocType;
  docId: string;
  modality: Modality;
}

/** One adapter attempt inside a parse (audited as one ocr_calls row). */
interface ParseAttempt {
  backend: 'digital' | typeof ocrLabel;
  startedAt: number;
}

function auditAttempts(
  docId: string,
  docType: DocType,
  sourcePath: string,
  attempts: ParseAttempt[],
  finalModel: BlockModel | null,
  fatalError: string | null,
): void {
  let fileBytes: number | null = null;
  try {
    fileBytes = statSync(sourcePath).size;
  } catch {
    /* stat failure must never break parsing */
  }
  const pages = finalModel
    ? finalModel.blocks.reduce((max, b) => Math.max(max, b.page), 0)
    : null;
  for (const a of attempts) {
    recordOcrCall({
      sessionId: getSessionId() ?? undefined,
      docId,
      docType,
      fileName: basename(sourcePath),
      backend: a.backend,
      fileBytes,
      pages,
      blocks: finalModel?.blocks.length ?? null,
      durationMs: Math.round(performance.now() - a.startedAt),
      status: a.backend === 'digital' || finalModel ? 'ok' : 'error',
      error: fatalError,
    });
  }
}

/**
 * Pure parse primitive: file -> BlockModel. Adapter is auto-selected by
 * modality, with a digital->scanned (OCR) auto-fallback for PDFs that yield
 * zero blocks (no text layer). Does NOT persist anything; the caller is
 * responsible for saving the returned BlockModel.
 *
 * Every adapter attempt is recorded into the usage-audit `ocr_calls` table
 * (fire-and-forget, never throws).
 */
export async function parseDocument(opts: ParseDocumentInput): Promise<BlockModel> {
  const { sourcePath, docType, docId, modality } = opts;
  const attempts: ParseAttempt[] = [];

  const t0 = performance.now();
  attempts.push({ backend: modality === 'scanned' ? ocrLabel : 'digital', startedAt: t0 });
  let blockModel =
    modality === 'scanned'
      ? await ingestWithScannedOCR(sourcePath, docType, docId)
      : await ingestWithDigital(sourcePath, docType, docId);
  console.log(
    `[perf-parse] ${docId} ${modality === 'scanned' ? 'ocr' : 'digital'} `
    + `${Math.round(performance.now() - t0)}ms ${blockModel.blocks.length} blocks`,
  );

  // Digital PDFs with no text layer: retry as scanned via the configured OCR backend.
  if (
    blockModel.blocks.length === 0 &&
    modality !== 'scanned' &&
    /\.pdf$/i.test(sourcePath)
  ) {
    console.warn(`[parse] digital yielded 0 blocks for PDF; retrying as scanned via ${ocrLabel} OCR`);
    const ocrT0 = performance.now();
    attempts.push({ backend: ocrLabel, startedAt: ocrT0 });
    try {
      const ocrModel = await ingestWithScannedOCR(sourcePath, docType, docId);
      console.log(
        `[perf-parse] ${docId} ocr-fallback ${Math.round(performance.now() - ocrT0)}ms ${ocrModel.blocks.length} blocks`,
      );
      if (ocrModel.blocks.length > 0) {
        blockModel = ocrModel;
        auditAttempts(docId, docType, sourcePath, attempts, blockModel, null);
        return blockModel;
      }
    } catch (e) {
      console.warn(`[parse] ${ocrLabel} OCR fallback failed:`, (e as Error).message);
      console.log(`[perf-parse] ${docId} ocr-fallback-failed ${Math.round(performance.now() - ocrT0)}ms`);
      auditAttempts(docId, docType, sourcePath, attempts, null, (e as Error).message);
      throw e;
    }
  }

  if (blockModel.blocks.length === 0) {
    const msg =
      modality === 'scanned'
        ? `文件解析得到 0 个内容块。${ocrLabel} OCR 可能失败，请检查 ${ocrSidecar} 或 OCR 服务配置。`
        : `文件解析得到 0 个内容块。该文件可能是扫描件(无文字层)，${ocrLabel} OCR 也未能提取内容。`;
    auditAttempts(docId, docType, sourcePath, attempts, null, msg);
    throw new Error(msg);
  }
  auditAttempts(docId, docType, sourcePath, attempts, blockModel, null);
  return blockModel;
}

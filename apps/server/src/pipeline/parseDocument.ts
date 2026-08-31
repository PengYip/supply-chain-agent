import type { BlockModel, DocType, Modality } from './types.js';
import { ingestWithDigital } from './digitalAdapter.js';
import { ingestWithMinerU } from './mineruAdapter.js';
import { ingestWithPaddleOCR } from './paddleocrAdapter.js';
import { env } from '../env.js';

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

/**
 * Pure parse primitive: file -> BlockModel. Adapter is auto-selected by
 * modality, with a digital->scanned (MinerU OCR) auto-fallback for PDFs that
 * yield zero blocks (no text layer). Does NOT persist anything; the caller is
 * responsible for saving the returned BlockModel.
 *
 * Reused by ingest_file today and by read_document / external-fetch ingestion
 * in later phases.
 */
export async function parseDocument(opts: ParseDocumentInput): Promise<BlockModel> {
  const { sourcePath, docType, docId, modality } = opts;

  const t0 = performance.now();
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
    try {
      const ocrModel = await ingestWithScannedOCR(sourcePath, docType, docId);
      console.log(
        `[perf-parse] ${docId} ocr-fallback ${Math.round(performance.now() - ocrT0)}ms ${ocrModel.blocks.length} blocks`,
      );
      if (ocrModel.blocks.length > 0) blockModel = ocrModel;
    } catch (e) {
      console.warn(`[parse] ${ocrLabel} OCR fallback failed:`, (e as Error).message);
      console.log(`[perf-parse] ${docId} ocr-fallback-failed ${Math.round(performance.now() - ocrT0)}ms`);
    }
  }

  if (blockModel.blocks.length === 0) {
    throw new Error(
      modality === 'scanned'
        ? `文件解析得到 0 个内容块。${ocrLabel} OCR 可能失败，请检查 ${ocrSidecar} 或 OCR 服务配置。`
        : `文件解析得到 0 个内容块。该文件可能是扫描件(无文字层)，${ocrLabel} OCR 也未能提取内容。`,
    );
  }
  return blockModel;
}

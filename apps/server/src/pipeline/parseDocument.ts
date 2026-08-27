import type { BlockModel, DocType, Modality } from './types.js';
import { ingestWithDigital } from './digitalAdapter.js';
import { ingestWithMinerU } from './mineruAdapter.js';

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
      ? await ingestWithMinerU(sourcePath, docType, docId)
      : await ingestWithDigital(sourcePath, docType, docId);
  console.log(
    `[perf-parse] ${docId} ${modality === 'scanned' ? 'ocr' : 'digital'} `
    + `${Math.round(performance.now() - t0)}ms ${blockModel.blocks.length} blocks`,
  );

  // Digital PDFs with no text layer: retry as scanned via MinerU OCR.
  if (
    blockModel.blocks.length === 0 &&
    modality !== 'scanned' &&
    /\.pdf$/i.test(sourcePath)
  ) {
    console.warn('[parse] digital yielded 0 blocks for PDF; retrying as scanned via MinerU OCR');
    const ocrT0 = performance.now();
    try {
      const mineruModel = await ingestWithMinerU(sourcePath, docType, docId);
      console.log(
        `[perf-parse] ${docId} ocr-fallback ${Math.round(performance.now() - ocrT0)}ms ${mineruModel.blocks.length} blocks`,
      );
      if (mineruModel.blocks.length > 0) blockModel = mineruModel;
    } catch (e) {
      console.warn('[parse] MinerU OCR fallback failed:', (e as Error).message);
      console.log(`[perf-parse] ${docId} ocr-fallback-failed ${Math.round(performance.now() - ocrT0)}ms`);
    }
  }

  if (blockModel.blocks.length === 0) {
    throw new Error(
      modality === 'scanned'
        ? '文件解析得到 0 个内容块。MinerU OCR 可能失败，请检查 .mineru.json 或 MinerU 服务配置。'
        : '文件解析得到 0 个内容块。该文件可能是扫描件(无文字层)，MinerU OCR 也未能提取内容。',
    );
  }
  return blockModel;
}

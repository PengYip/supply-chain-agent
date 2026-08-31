import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { env } from '../env.js';
import type { Block, BlockModel, BBox, DocType } from './types.js';

// Qianfan PaddleOCR-VL endpoint shape (validated against the live
// `POST https://qianfan.baidubce.com/v2/ocr/paddleocr` response, captured
// 2026-08-31 from a real 1-page scanned invoice PDF):
//   {
//     id, usage: { numPages },
//     result: {
//       dataInfo: { type: 'pdf'|'image', numPages?, pages?, width?, height? },
//       layoutParsingResults: [{                 // one entry per PDF page
//         prunedResult: {
//           model_settings,
//           parsing_res_list: [{                 // reading order
//             block_label,                       // text|doc_title|paragraph_title|table|image|seal|...
//             block_content,                     // plain text, or HTML for table/image blocks
//             block_bbox: [x0, y0, x1, y1],      // CORNER coordinates
//             block_id, block_order              // order is null for non-ordered blocks
//           }],
//           layout_det_res: { boxes: [{label, score, coordinate, cls_id}] }
//         },
//         markdown: { text, images, isStart, isEnd },
//         outputImages, inputImage
//       }]
//     }
//   }
//
// Mapping notes (parity with mineruAdapter):
//   - block_bbox is corner [x0,y0,x1,y1] -> BBox {x,y,w,h} (same as MinerU).
//   - No per-block confidence in the response -> constant 0.9 fallback, exactly
//     like the MinerU page-statistics fallback.
//   - 'image' -> 'figure'; 'table' folds to 'text' with its HTML kept as the
//     block text (chunking consumes the HTML; same policy as MinerU spans).

interface QianfanBlock {
  block_label?: string;
  block_content?: string;
  block_bbox?: number[];
  block_id?: number;
  block_order?: number | null;
}
interface QianfanPage {
  prunedResult?: { parsing_res_list?: QianfanBlock[] };
}
interface QianfanOutput {
  result?: { layoutParsingResults?: QianfanPage[] };
}

export interface NormalizeInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  qianfanOutput: unknown;
}

// Qianfan block_bbox is corner coordinates [x0,y0,x1,y1]; convert to BBox.
function toBBox(n: number[] | undefined): BBox | null {
  if (!n || n.length < 4) return null;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = n;
  return { x: x0, y: y0, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

function mapType(t: string): Block['type'] {
  if (t === 'table_row') return 'table_row';
  if (t === 'image') return 'figure';
  // 'table'/'doc_title'/'paragraph_title'/'text'/'seal'/... -> 'text'.
  return 'text';
}

export function normalizeQianfanOutput(input: NormalizeInput): BlockModel {
  const out = input.qianfanOutput as QianfanOutput;
  const pages = out?.result?.layoutParsingResults;
  if (!Array.isArray(pages)) {
    throw new Error('Qianfan output missing result.layoutParsingResults array');
  }
  const blocks: Block[] = [];
  for (const [i, page] of pages.entries()) {
    // 1-indexed page number, mirroring MinerU's page_idx + 1.
    const pageNo = i + 1;
    for (const b of page.prunedResult?.parsing_res_list ?? []) {
      blocks.push({
        id: `b${blocks.length}`,
        type: mapType(b.block_label ?? 'text'),
        text: b.block_content ?? '',
        page: pageNo,
        bbox: toBBox(b.block_bbox),
        ocrConfidence: 0.9,
      });
    }
  }
  return {
    docId: input.docId,
    docType: input.docType,
    modality: 'scanned',
    blocks,
    sourceUri: input.sourceUri,
    createdAt: new Date().toISOString(),
  };
}

/** Qianfan fileType: 0 = PDF, 1 = image. */
function qianfanFileType(sourceUri: string): 0 | 1 {
  if (/\.pdf$/i.test(sourceUri)) return 0;
  if (/\.(png|jpe?g|bmp|tiff?)$/i.test(sourceUri)) return 1;
  throw new Error(
    `Qianfan OCR: unsupported file type for ${path.basename(sourceUri)} (only PDF/images are accepted).`,
  );
}

/**
 * Full ingest entry: calls Baidu Qianfan's hosted PaddleOCR-VL endpoint
 * (`/v2/ocr/paddleocr`, model `paddleocr-vl-0.9b`) with the file as base64,
 * then normalizes to a BlockModel.
 *
 * Two paths:
 *  1. Hermetic test path (FIRST): if `<sourceUri>.paddleocr.json` exists, read
 *     it and normalize. No network. Mirrors the `.mineru.json` sidecar used by
 *     ingestWithMinerU so unit tests stay hermetic.
 *  2. Production path: POST the file (PDF <= 50MB, images <= 10MB per Qianfan
 *     limits; enforced here with a clear error) and normalize the response.
 *
 * Requires QIANFAN_API_KEY; selected via PARSE_BACKEND=qianfan in parseDocument.
 */
export async function ingestWithPaddleOCR(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  const jsonPath = `${sourceUri}.paddleocr.json`;
  // Hermetic test path: pre-generated JSON wins, no network.
  if (existsSync(jsonPath)) {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    return normalizeQianfanOutput({ docId, docType, sourceUri, qianfanOutput: raw });
  }
  if (!env.QIANFAN_API_KEY) {
    throw new Error(
      'Qianfan OCR: QIANFAN_API_KEY is not set. Set it in the project root .env (PARSE_BACKEND=qianfan) or provide a <file>.paddleocr.json sidecar.',
    );
  }
  const raw = readFileSync(sourceUri);
  // Hard limits per Qianfan docs: PDF <= 50MB, image <= 10MB.
  const maxBytes = qianfanFileType(sourceUri) === 0 ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  if (raw.byteLength > maxBytes) {
    throw new Error(
      `Qianfan OCR: file exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit `
      + `(${Math.round(raw.byteLength / 1024 / 1024)}MB): ${path.basename(sourceUri)}.`,
    );
  }
  const body = JSON.stringify({
    model: 'paddleocr-vl-0.9b',
    file: raw.toString('base64'),
    fileType: qianfanFileType(sourceUri),
    useChartRecognition: false,
    visualize: false,
    temperature: 0,
  });
  const t0 = performance.now();
  console.log(`[perf-qianfan] start docId=${docId} file=${path.basename(sourceUri)} bytes=${raw.byteLength}`);
  let resp: Response;
  try {
    resp = await fetch(env.QIANFAN_OCR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.QIANFAN_API_KEY}`,
      },
      body,
      signal: AbortSignal.timeout(env.QIANFAN_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`[perf-qianfan] fetch-failed docId=${docId} ${Math.round(performance.now() - t0)}ms`);
    throw new Error(`Qianfan OCR request failed: ${(e as Error).message}`);
  }
  const text = await resp.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    console.warn(`[perf-qianfan] bad-json docId=${docId} ${Math.round(performance.now() - t0)}ms`);
    throw new Error(`Qianfan OCR returned non-JSON response (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  if (!resp.ok || (json as { error?: unknown }).error) {
    console.warn(`[perf-qianfan] api-error docId=${docId} ${Math.round(performance.now() - t0)}ms status=${resp.status}`);
    throw new Error(`Qianfan OCR API error (HTTP ${resp.status}): ${text.slice(0, 300)}`);
  }
  console.log(`[perf-qianfan] done docId=${docId} ${Math.round(performance.now() - t0)}ms`);
  return normalizeQianfanOutput({ docId, docType, sourceUri, qianfanOutput: json });
}

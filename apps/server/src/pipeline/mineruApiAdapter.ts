import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import JSZip from 'jszip';
import { env } from '../env.js';
import type { BlockModel, DocType } from './types.js';
import { normalizeMinerUOutput } from './mineruAdapter.js';

// Cloud MinerU (mineru.net) API v4 adapter. Shares the `.mineru.json` hermetic
// sidecar with the local CLI backend (ingestWithMinerU): the result zip of the
// cloud parse contains the SAME middle-JSON layout (as `layout.json`), so the
// normalizer from mineruAdapter is reused verbatim — no duplicate parse logic.
//
// Flow (from the official API docs, mineru.net/apiManage/docs):
//   1. POST {base}/file-urls/batch  -> presigned upload URL + batch_id
//   2. PUT raw file bytes to that URL (no Content-Type / no Authorization);
//      the parse task AUTO-SUBMITS once the upload finishes (no submit call)
//   3. poll GET {base}/extract-results/batch/{batch_id} until done/failed
//   4. GET the result zip (plain GET) and read layout.json out of it
//
// Limits: <= 200MB per file; daily quota errors surface as envelope code
// -60018 (covered by the generic envelope check below).

const MAX_FILE_BYTES = 200 * 1024 * 1024; // MinerU cloud hard limit per file
const JSON_TIMEOUT_MS = 30_000; // presigned-URL batch + PUT + poll calls
const ZIP_TIMEOUT_MS = 120_000; // result-zip download can be large
const POLL_INTERVAL_MS = 3_000;

interface BatchEnvelope {
  code: number;
  msg?: string;
  data?: { batch_id?: string; file_urls?: string[] };
}
interface ExtractEntry {
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
  extract_progress?: { extracted_pages?: number; total_pages?: number };
}
interface ExtractEnvelope {
  code?: number;
  msg?: string;
  data?: { extract_result?: ExtractEntry[] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// data_id charset is [A-Za-z0-9_.-] (max 128 chars); replace anything else with
// '-' and truncate so the docId survives the round-trip as a stable reference.
function sanitizeDataId(docId: string): string {
  const cleaned = docId.replace(/[^A-Za-z0-9_.-]/g, '-');
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

// The zip may nest outputs under a folder. Prefer the entry whose basename is
// `layout.json`, tie-breaking on the shortest path (root-most); fall back to
// any `*_middle.json` / `middle.json` entry (same middle-JSON shape).
function pickMiddleEntry(zip: JSZip): JSZip.JSZipObject | null {
  const layout: JSZip.JSZipObject[] = [];
  const middle: JSZip.JSZipObject[] = [];
  for (const obj of Object.values(zip.files)) {
    if (obj.dir) continue;
    const base = obj.name.split('/').pop() ?? '';
    if (base === 'layout.json') layout.push(obj);
    else if (base === 'middle.json' || base.endsWith('_middle.json')) middle.push(obj);
  }
  const pick = (c: JSZip.JSZipObject[]): JSZip.JSZipObject | null => {
    if (!c.length) return null;
    c.sort((a, b) => a.name.length - b.name.length);
    return c[0] ?? null;
  };
  return pick(layout) ?? pick(middle);
}

/**
 * Full ingest entry: uploads the file to the MinerU cloud API (mineru.net),
 * polls the async parse task, downloads the result zip, and normalizes the
 * contained layout.json (the same middle-JSON shape the local CLI produces).
 *
 * Two paths:
 *  1. Hermetic test path (FIRST): if `<sourceUri>.mineru.json` exists, read it
 *     and normalize. No network. Mirrors ingestWithMinerU so unit tests stay
 *     hermetic and both backends share one sidecar format.
 *  2. Production path: the upload -> poll -> download flow above.
 *
 * Requires MINERU_API_KEY; selected via PARSE_BACKEND=mineru-api in parseDocument.
 */
export async function ingestWithMinerUApi(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  const jsonPath = `${sourceUri}.mineru.json`;
  // Hermetic test path: pre-generated JSON wins, no network.
  if (existsSync(jsonPath)) {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    return normalizeMinerUOutput({ docId, docType, sourceUri, minerUOutput: raw });
  }
  if (!env.MINERU_API_KEY) {
    throw new Error(
      'MinerU API: MINERU_API_KEY is not set. Set it in the project root .env (PARSE_BACKEND=mineru-api) or provide a <file>.mineru.json sidecar.',
    );
  }

  const raw = readFileSync(sourceUri);
  // MinerU cloud limit: 200MB per file, enforced before any upload.
  if (raw.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `MinerU API: file exceeds the 200MB limit (${Math.round(raw.byteLength / 1024 / 1024)}MB): ${basename(sourceUri)}.`,
    );
  }

  const t0 = performance.now();
  const base = env.MINERU_API_BASE_URL.replace(/\/+$/, ''); // tolerate trailing slash
  const elapsed = () => Math.round(performance.now() - t0);
  console.log(`[perf-mineru-api] start docId=${docId} file=${basename(sourceUri)} bytes=${raw.byteLength}`);

  // Step 1: request a presigned upload URL (parse task auto-submits on PUT).
  const batchBody = JSON.stringify({
    files: [{ name: basename(sourceUri), data_id: sanitizeDataId(docId) }],
    model_version: env.MINERU_API_MODEL_VERSION,
    is_ocr: true,
    language: 'ch',
    enable_table: true,
  });
  let batchResp: Response;
  try {
    batchResp = await fetch(`${base}/file-urls/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.MINERU_API_KEY}`,
      },
      body: batchBody,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`[perf-mineru-api] failed docId=${docId} step=batch ${elapsed()}ms`);
    throw new Error(`MinerU API batch request failed: ${(e as Error).message}`);
  }
  const batchText = await batchResp.text();
  let batchJson: BatchEnvelope;
  try {
    batchJson = JSON.parse(batchText) as BatchEnvelope;
  } catch {
    console.warn(`[perf-mineru-api] failed docId=${docId} step=batch-bad-json ${elapsed()}ms`);
    throw new Error(`MinerU API batch returned non-JSON: ${batchText.slice(0, 300)}`);
  }
  if (batchJson.code !== 0) {
    console.warn(`[perf-mineru-api] failed docId=${docId} step=batch-code-${batchJson.code} ${elapsed()}ms`);
    throw new Error(`MinerU API error (code ${batchJson.code}): ${batchJson.msg ?? batchText.slice(0, 300)}`);
  }
  const batchId = batchJson.data?.batch_id;
  const uploadUrl = Array.isArray(batchJson.data?.file_urls) ? batchJson.data?.file_urls?.[0] : undefined;
  if (!batchId || !uploadUrl) {
    console.warn(`[perf-mineru-api] failed docId=${docId} step=batch-shape ${elapsed()}ms`);
    throw new Error(`MinerU API batch response missing batch_id/file_urls: ${batchText.slice(0, 300)}`);
  }

  // Step 2: PUT the raw file bytes to the presigned URL. Explicitly NO
  // Content-Type and NO Authorization — the URL is already signed and extra
  // headers would break the signature.
  let putResp: Response;
  try {
    putResp = await fetch(uploadUrl, {
      method: 'PUT',
      body: raw,
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch (e) {
    console.warn(`[perf-mineru-api] failed docId=${docId} step=upload ${elapsed()}ms`);
    throw new Error(`MinerU API file upload failed: ${(e as Error).message}`);
  }
  if (!putResp.ok) {
    const putText = await putResp.text();
    console.warn(`[perf-mineru-api] failed docId=${docId} step=upload-http-${putResp.status} ${elapsed()}ms`);
    throw new Error(`MinerU API file upload failed (HTTP ${putResp.status}): ${putText.slice(0, 300)}`);
  }
  console.log(`[perf-mineru-api] upload-done docId=${docId} batchId=${batchId} ${elapsed()}ms`);

  // Step 3: poll the extract result until done/failed or the overall deadline.
  const deadlineMs = Date.now() + env.MINERU_API_TIMEOUT_MS;
  let lastState = 'submitted';
  while (true) {
    if (Date.now() >= deadlineMs) {
      console.warn(`[perf-mineru-api] failed docId=${docId} step=timeout ${elapsed()}ms`);
      throw new Error(
        `MinerU API parse timed out after ${env.MINERU_API_TIMEOUT_MS}ms (last state: ${lastState}). `
        + `Check the file on mineru.net or raise MINERU_API_TIMEOUT_MS.`,
      );
    }
    const pollUrl = `${base}/extract-results/batch/${batchId}`;
    let pollResp: Response;
    try {
      pollResp = await fetch(pollUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${env.MINERU_API_KEY}` },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
    } catch (e) {
      console.warn(`[perf-mineru-api] failed docId=${docId} step=poll ${elapsed()}ms`);
      throw new Error(`MinerU API poll failed: ${(e as Error).message}`);
    }
    const pollText = await pollResp.text();
    if (!pollResp.ok) {
      console.warn(`[perf-mineru-api] failed docId=${docId} step=poll-http-${pollResp.status} ${elapsed()}ms`);
      throw new Error(`MinerU API poll failed (HTTP ${pollResp.status}): ${pollText.slice(0, 300)}`);
    }
    let pollJson: ExtractEnvelope;
    try {
      pollJson = JSON.parse(pollText) as ExtractEnvelope;
    } catch {
      console.warn(`[perf-mineru-api] failed docId=${docId} step=poll-bad-json ${elapsed()}ms`);
      throw new Error(`MinerU API poll returned non-JSON: ${pollText.slice(0, 300)}`);
    }
    const entries = pollJson.data?.extract_result;
    const first = Array.isArray(entries) ? (entries[0] ?? undefined) : undefined;
    const state = first?.state ?? 'waiting-file';
    lastState = state;
    const prog = first?.extract_progress;
    const hasProgress =
      prog !== undefined && prog.extracted_pages !== undefined && prog.total_pages !== undefined;
    const progText = hasProgress
      ? ` extracted_pages=${prog?.extracted_pages} total_pages=${prog?.total_pages}`
      : '';
    console.log(`[perf-mineru-api] poll docId=${docId} state=${state}${progText} ${elapsed()}ms`);

    if (state === 'done') {
      const zipUrl = first?.full_zip_url;
      if (!zipUrl) {
        console.warn(`[perf-mineru-api] failed docId=${docId} step=no-zip-url ${elapsed()}ms`);
        throw new Error('MinerU API parse finished but full_zip_url is missing');
      }
      // Step 4: download the result zip (plain GET, no auth) and read layout.json.
      let zipResp: Response;
      try {
        zipResp = await fetch(zipUrl, { signal: AbortSignal.timeout(ZIP_TIMEOUT_MS) });
      } catch (e) {
        console.warn(`[perf-mineru-api] failed docId=${docId} step=zip ${elapsed()}ms`);
        throw new Error(`MinerU API result download failed: ${(e as Error).message}`);
      }
      if (!zipResp.ok) {
        console.warn(`[perf-mineru-api] failed docId=${docId} step=zip-http-${zipResp.status} ${elapsed()}ms`);
        throw new Error(`MinerU API result download failed (HTTP ${zipResp.status})`);
      }
      const zipBuf = Buffer.from(await zipResp.arrayBuffer());
      const zip = await JSZip.loadAsync(zipBuf);
      const entry = pickMiddleEntry(zip);
      if (!entry) {
        console.warn(`[perf-mineru-api] failed docId=${docId} step=zip-no-layout ${elapsed()}ms`);
        throw new Error('MinerU API result zip contains no layout.json / *_middle.json entry');
      }
      let middleJson: unknown;
      try {
        middleJson = JSON.parse(await entry.async('string'));
      } catch {
        console.warn(`[perf-mineru-api] failed docId=${docId} step=zip-bad-json ${elapsed()}ms`);
        throw new Error(`MinerU API result zip entry ${entry.name} is not valid JSON`);
      }
      const model = normalizeMinerUOutput({ docId, docType, sourceUri, minerUOutput: middleJson });
      console.log(`[perf-mineru-api] done docId=${docId} ${elapsed()}ms blocks=${model.blocks.length}`);
      return model;
    }
    if (state === 'failed') {
      console.warn(`[perf-mineru-api] failed docId=${docId} state=failed ${elapsed()}ms`);
      throw new Error(`MinerU API parse failed: ${first?.err_msg ?? 'unknown error'}`);
    }
    // waiting-file/pending/running/converting/unknown -> keep polling.
    await sleep(POLL_INTERVAL_MS);
  }
}

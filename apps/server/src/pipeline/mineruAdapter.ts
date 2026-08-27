import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { Block, BlockModel, BBox, DocType } from './types.js';

const execFileAsync = promisify(execFile);

// MinerU real output shape (validated against MinerU 3.4.4 pipeline-backend
// `<doc>_middle.json`, captured 2026-08-07 via `uvx --from 'mineru[pipeline]' --with six
// mineru -p <pdf> -o <out> -b pipeline -m auto -l ch`):
//   {
//     pdf_info: [{
//       page_idx, page_size,
//       preproc_blocks: [{
//         type: 'title'|'text'|'table'|'image'|'table_body'|...,
//         bbox: [x0, y0, x1, y1],          // CORNER coordinates, not [x,y,w,h]
//         score: 0..1,                       // per-block OCR confidence (real output)
//         lines: [{ bbox, spans: [{
//           type: 'text'|'table', content?: string, html?: string, bbox, score
//         }] }],
//         blocks: [ ...nested MinerUBlock[] ] // e.g. table -> table_body children
//       }],
//       discarded_blocks, para_blocks
//       // NOTE: NO page-level `statistics.max_bbox_score` in real 3.4.4 output.
//     }],
//     _backend, _version_name
//   }
//
// Differences from the EARLIER ASSUMED shape (pre-H2), now corrected:
//   - text lives in line.spans[].content (NOT line.text); table spans carry html.
//   - per-block `score` is the OCR confidence (real output has no page statistics).
//   - bbox is [x0,y0,x1,y1] corners -> BBox {x,y,w=x1-x0,h=y1-y0}.
// The legacy assumed-shape (`line.text` + page `statistics`) is still tolerated:
// spans/content is tried first, then line.text; block.score is tried first, then
// page statistics, then 0.9.

interface MinerUSpan { content?: string; html?: string; type?: string; bbox?: number[]; score?: number }
interface MinerULine { text?: string; bbox?: number[]; spans?: MinerUSpan[] }
interface MinerUBlock { type: string; bbox?: number[]; score?: number; lines?: MinerULine[]; blocks?: MinerUBlock[] }
interface MinerUPage { page_idx: number; preproc_blocks?: MinerUBlock[]; statistics?: { max_bbox_score?: number } }
interface MinerUOutput { pdf_info?: MinerUPage[] }

export interface NormalizeInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  minerUOutput: unknown;
}

// MinerU bbox is corner coordinates [x0,y0,x1,y1]; convert to BBox {x,y,w,h}.
function toBBox(n: number[] | undefined): BBox | null {
  if (!n || n.length < 4) return null;
  // Length guard above guarantees indices 0..3 exist; defaults satisfy
  // noUncheckedIndexedAccess and never fire at runtime.
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = n;
  return { x: x0, y: y0, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

// Extract a block's text: prefer the real 3.4.4 form (line.spans[].content,
// falling back to a table span's html), then the legacy assumed form (line.text);
// finally fold nested children (table containers) so Block.text is non-empty.
function textOf(b: MinerUBlock): string {
  const own = (b.lines ?? [])
    .flatMap((l) => {
      if (l.spans && l.spans.length) {
        return l.spans.map((s) => s.content ?? s.html ?? '');
      }
      return [l.text ?? '']; // legacy assumed-shape fallback
    })
    .join('');
  if (own) return own;
  return (b.blocks ?? []).map((c) => textOf(c)).join('');
}

function fromBlock(b: MinerUBlock, page: number, fallbackConf: number, counter: { n: number }): Block {
  const id = `b${counter.n++}`;
  // Prefer the block's own per-block score (real 3.4.4); fall back to page-level.
  const block: Block = {
    id,
    type: mapType(b.type),
    text: textOf(b),
    page,
    bbox: toBBox(b.bbox),
    ocrConfidence: clamp01(b.score ?? fallbackConf),
  };
  if (b.blocks && b.blocks.length) {
    block.children = b.blocks.map((c) => fromBlock(c, page, fallbackConf, counter));
  }
  return block;
}

function mapType(t: string): Block['type'] {
  if (t === 'table_row') return 'table_row';
  if (t === 'image') return 'figure';
  // 'table'/'table_body'/'title'/'text' -> 'text' (containers fold children).
  return 'text';
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function normalizeMinerUOutput(input: NormalizeInput): BlockModel {
  const out = input.minerUOutput as MinerUOutput;
  if (!out || !Array.isArray(out.pdf_info)) {
    throw new Error('MinerU output missing pdf_info array');
  }
  const counter = { n: 0 };
  const blocks: Block[] = [];
  for (const page of out.pdf_info) {
    // Real 3.4.4 has no page statistics -> 0.9 fallback; per-block score wins in fromBlock.
    const fallbackConf = clamp01(page.statistics?.max_bbox_score ?? 0.9);
    for (const b of page.preproc_blocks ?? []) {
      blocks.push(fromBlock(b, page.page_idx + 1, fallbackConf, counter));
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

/**
 * Full ingest entry: shells out to MinerU (via the mineru-pdf skill CLI) to
 * produce JSON, then normalizes.
 *
 * Two paths:
 *  1. Hermetic test path (FIRST): if `<sourceUri>.mineru.json` exists, read it
 *     and normalize. No subprocess. Used by unit tests so they don't depend on
 *     the MinerU binary.
 *  2. Production path: shell out to the MinerU CLI (env-configurable via
 *     MINERU_BIN, default `mineru`) and read the produced `_middle.json`.
 */
export async function ingestWithMinerU(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  const jsonPath = `${sourceUri}.mineru.json`;
  // Hermetic test path: pre-generated JSON wins, no subprocess.
  if (existsSync(jsonPath)) {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    return normalizeMinerUOutput({ docId, docType, sourceUri, minerUOutput: raw });
  }
  // Production path: shell out to MinerU CLI.
  const outDir = await mkdtemp(path.join(tmpdir(), 'mineru-'));
  const mineruBin = process.env.MINERU_BIN || 'mineru';
  const cliT0 = performance.now();
  console.log(`[perf-mineru] start docId=${docId} file=${path.basename(sourceUri)} bin=${mineruBin}`);
  try {
    const { stdout, stderr } = await execFileAsync(mineruBin, [
      '-p', sourceUri,
      '-o', outDir,
      '-b', 'pipeline',
      '-l', 'ch',       // Chinese language
      '-d', 'cpu',      // no GPU on server
      '-m', 'auto',     // auto-download models on first run
    ], { timeout: 600_000 });  // 10 min timeout per PDF
    console.log(
      `[perf-mineru] cli-done docId=${docId} ${Math.round(performance.now() - cliT0)}ms`,
    );
    // MinerU 3.4.4 with `-m auto` writes its outputs one level deeper than the
    // documented layout: <outDir>/<baseName>/auto/<baseName>_middle.json (the
    // `auto/` subdir comes from the -m auto mode). The previous exact-path
    // assumption (<outDir>/<baseName>/<baseName>_middle.json) therefore missed
    // the file -- surfacing as "MinerU output not found" even though OCR had
    // completed successfully. Filenames with irregular spaces (common on trade
    // contracts) further rule out string-matching the path. Recursively scan
    // outDir for the first *_middle.json instead; MinerU emits exactly one per
    // PDF, so the match is unambiguous and survives future layout changes.
    const findMiddleJson = (dir: string): string | null => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith('_middle.json')) return full;
        if (e.isDirectory()) {
          const found = findMiddleJson(full);
          if (found) return found;
        }
      }
      return null;
    };
    const middleJsonPath = findMiddleJson(outDir);
    if (!middleJsonPath) {
      throw new Error(`MinerU output (*_middle.json) not found under ${outDir}. stdout: ${stdout}. stderr: ${stderr}`);
    }
    const raw = JSON.parse(readFileSync(middleJsonPath, 'utf-8'));
    return normalizeMinerUOutput({ docId, docType, sourceUri, minerUOutput: raw });
  } catch (e) {
    console.warn(`[perf-mineru] cli-failed docId=${docId} ${Math.round(performance.now() - cliT0)}ms`);
    throw new Error(`MinerU CLI failed: ${(e as Error).message}. Ensure MINERU_BIN points to the mineru executable.`);
  }
}

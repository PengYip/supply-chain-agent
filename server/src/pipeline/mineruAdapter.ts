import type { Block, BlockModel, BBox, DocType } from './types.js';

// TODO(real-sample): No real scanned contract PDF + no MinerU CLI available in this
// environment (`which mineru` / `uv pip show mineru` both negative). Normalizer is
// implemented against the ASSUMED MinerU JSON shape documented below and unit-tested
// against test/pipeline/fixtures/mineru-sample.json. When a real sample is captured,
// re-run the Step-1 spike, diff the shape, and adjust fromBlock/mapType/textOf as needed.
//
// MinerU spike output shape (ASSUMED 2026-08-05; adjust if real sample differs):
//   { pdf_info: [{ page_idx, preproc_blocks: [{type, bbox, lines:[{text,bbox}] | blocks:[...]}], statistics:{max_bbox_score} }] }
// Each page's per-block OCR confidence is taken from statistics.max_bbox_score
// (page-level proxy). If a finer per-block score exists, prefer it here.

interface MinerULine { text: string; bbox?: number[] }
interface MinerUBlock { type: string; bbox?: number[]; lines?: MinerULine[]; blocks?: MinerUBlock[] }
interface MinerUPage { page_idx: number; preproc_blocks?: MinerUBlock[]; statistics?: { max_bbox_score?: number } }
interface MinerUOutput { pdf_info?: MinerUPage[] }

export interface NormalizeInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  minerUOutput: unknown;
}

function toBBox(n: number[] | undefined): BBox | null {
  if (!n || n.length < 4) return null;
  // Length guard above guarantees indices 0..3 exist; defaults satisfy
  // noUncheckedIndexedAccess and never fire at runtime.
  const [x = 0, y = 0, w = 0, h = 0] = n;
  return { x, y, w, h };
}

function textOf(b: MinerUBlock): string {
  const own = (b.lines ?? []).map((l) => l.text).join('');
  if (own) return own;
  // Container block (e.g. "table") carries no lines of its own; fold its children's
  // text so the resulting Block.text is non-empty and usable for span offsets.
  return (b.blocks ?? []).map((c) => textOf(c)).join('');
}

function fromBlock(b: MinerUBlock, page: number, conf: number, counter: { n: number }): Block {
  const id = `b${counter.n++}`;
  const block: Block = {
    id,
    type: mapType(b.type),
    text: textOf(b),
    page,
    bbox: toBBox(b.bbox),
    ocrConfidence: clamp01(conf),
  };
  if (b.blocks && b.blocks.length) {
    block.children = b.blocks.map((c) => fromBlock(c, page, conf, counter));
  }
  return block;
}

function mapType(t: string): Block['type'] {
  if (t === 'table_row') return 'table_row';
  if (t === 'table') return 'text'; // container; children carry rows
  if (t === 'image') return 'figure';
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
    const conf = clamp01(page.statistics?.max_bbox_score ?? 0.9);
    for (const b of page.preproc_blocks ?? []) {
      blocks.push(fromBlock(b, page.page_idx + 1, conf, counter));
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
 * produce JSON, then normalizes. The CLI invocation is environment-specific;
 * for MVP it reads pre-generated JSON at `<sourceUri>.mineru.json` to keep
 * tests hermetic. Production wires the real MinerU subprocess here.
 */
export async function ingestWithMinerU(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  const { readFileSync } = await import('node:fs');
  const jsonPath = `${sourceUri}.mineru.json`;
  const minerUOutput = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  return normalizeMinerUOutput({ docId, docType, sourceUri, minerUOutput });
}

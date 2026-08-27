import { createReadStream, readFileSync } from 'node:fs';
import TurndownService from 'turndown';
import * as turndownPluginGfm from 'turndown-plugin-gfm';
import type { Block, BlockModel, DocType } from './types.js';

export interface FromTextInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  text: string;
}

/** Classify a text line: GFM pipe-table row, kv (colon) line, else plain text. */
function blockTypeForLine(text: string): Block['type'] {
  // GFM pipe-table row (docx tables are converted to markdown tables).
  if (text.startsWith('|')) return 'table_row';
  return text.includes(':') || text.includes('：') ? 'kv' : 'text';
}

/** Split born-digital text into line-level Blocks. Born-digital => conf=1.0, bbox=null. */
export function blockModelFromText(input: FromTextInput): BlockModel {
  const lines = input.text.split(/\r?\n/);
  const blocks: Block[] = [];
  let n = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (text.length === 0) continue;
    blocks.push({
      id: `b${n++}`,
      type: blockTypeForLine(text),
      text,
      page: 1,
      bbox: null,
      ocrConfidence: 1.0,
    });
  }
  return {
    docId: input.docId,
    docType: input.docType,
    modality: 'digital',
    blocks,
    sourceUri: input.sourceUri,
    createdAt: new Date().toISOString(),
  };
}

type TurndownPlugin = Parameters<TurndownService['use']>[0];

// turndown-plugin-gfm ships a UMD/CJS bundle: depending on the loader, the
// tables plugin surfaces either as a named export or under `default`. Resolve
// once, lazily, on the first .docx parse.
let turndownWithTables: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndownWithTables) {
    turndownWithTables = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const gfm = turndownPluginGfm as unknown as {
      tables?: TurndownPlugin;
      default?: { tables?: TurndownPlugin };
    };
    const tablesPlugin = gfm.tables ?? gfm.default?.tables;
    if (tablesPlugin) turndownWithTables.use(tablesPlugin);
  }
  return turndownWithTables;
}

/**
 * mammoth emits plain Word tables (no "repeat header row" marking) as
 * <table><tr><td>... with no <thead>/<th>, and wraps every cell's text in
 * <p>. Both break turndown-plugin-gfm's tables rule, which REFUSES tables
 * without a heading row (keeps raw HTML) and whose pipe rows would be
 * shattered by the blank lines turndown's <p> rule emits. So normalize table
 * HTML first: promote row 1 to <thead> (business tables conventionally carry
 * the header there; already-marked tables pass through) and unwrap cell
 * paragraphs, joining multi-paragraph cells with a space.
 */
function normalizeTableHtml(html: string): string {
  return html.replace(/<table>[\s\S]*?<\/table>/g, (tableHtml) => {
    let t = tableHtml;
    if (!t.includes('<thead')) {
      t = t.replace('<tr>', '<thead><tr>').replace('</tr>', '</tr></thead>');
    }
    t = t.replace(/<\/p>\s*<p[^>]*>/g, ' ').replace(/<\/?p[^>]*>/g, '');
    return t;
  });
}

/**
 * Extract .docx text as light markdown via mammoth:
 *   docx -> semantic HTML (tables kept as <table>) -> GFM markdown.
 * mammoth's own convertToMarkdown is deprecated and DROPS table structure, so
 * convertToHtml + turndown is the officially suggested route. Tables survive
 * as GFM pipe rows, which blockModelFromText types as table_row blocks.
 * Chinese content needs no special handling: docx XML is UTF-8 throughout.
 */
async function extractDocxText(sourceUri: string): Promise<string> {
  type MammothModule = typeof import('mammoth');
  const mod: MammothModule = await import('mammoth');
  // CJS interop: prefer the synthetic default (module.exports) when present.
  const mammoth = (mod as { default?: MammothModule }).default ?? mod;
  const buffer = readFileSync(sourceUri);
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      // Drop embedded images: mammoth would inline them as base64 data URIs
      // and bloat every downstream chunk. imgElement with empty src emits
      // <img src="">, which turndown's default img rule discards (falsy src).
      // Voucher images go through the VLM branch instead; images inside docx
      // are out of scope for now.
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    },
  );
  return getTurndown().turndown(normalizeTableHtml(html));
}

/**
 * Extract .xlsx text via exceljs: each sheet becomes a `## Sheet:` heading
 * plus GFM pipe rows (table_row blocks downstream).
 *
 * Irregular headers (merged cells / multi-row headers, common in Chinese
 * trade documents) are handled by EXPANDING merges: exceljs leaves every
 * non-anchor cell of a merged range (e.g. A1:C1) null; we copy the anchor
 * value into the whole range first, so every emitted row keeps a stable
 * column count and multi-row headers keep their full information (each
 * header row is emitted as its own pipe row instead of being flattened).
 * Old binary .xls is NOT supported by exceljs and fails with a clear error.
 */
async function extractXlsxText(sourceUri: string): Promise<string> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  // xlsx.read() is the documented Node path (streams); Buffer input hits a
  // Buffer<ArrayBuffer> generic mismatch between this repo's @types/node and
  // exceljs's bundled types, so use a read stream instead.
  await wb.xlsx.read(createReadStream(sourceUri));
  const lines: string[] = [];
  for (const ws of wb.worksheets) {
    // 1) Expand merged ranges: copy the anchor (top-left) value into every
    //    covered cell so rows/columns stay aligned downstream.
    const merges: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];
    for (const ref of ws.model.merges ?? []) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      const c1 = colToIndex(m[1]!);
      const c2 = colToIndex(m[3]!);
      merges.push({ r1: Number(m[2]), c1, r2: Number(m[4]), c2 });
    }
    const expanded = new Map<string, string>();
    const cellAt = (r: number, c: number): string => {
      const hit = expanded.get(`${r}:${c}`);
      if (hit !== undefined) return hit;
      return cellText(ws.getRow(r).getCell(c).value);
    };
    for (const { r1, c1, r2, c2 } of merges) {
      const anchor = cellAt(r1, c1);
      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) expanded.set(`${r}:${c}`, anchor);
      }
    }
    // 2) Materialize rows (exceljs row values are 1-indexed sparse arrays).
    let maxCols = 0;
    const rows: string[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row: string[] = [];
      let hasValue = false;
      const width = Math.max(ws.columnCount, maxMergedWidth(merges, r));
      for (let c = 1; c <= width; c++) {
        const v = cellAt(r, c);
        row.push(v);
        if (v.length > 0) hasValue = true;
      }
      maxCols = Math.max(maxCols, row.length);
      if (hasValue) rows.push(row);
    }
    if (rows.length === 0) continue;
    lines.push(`## Sheet: ${ws.name}`);
    rows.forEach((row, i) => {
      const cells = [...row];
      while (cells.length < maxCols) cells.push('');
      lines.push(`| ${cells.join(' | ')} |`);
      // GFM separator right after the first row (single-row header by
      // convention; multi-row headers just continue as more pipe rows).
      if (i === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
    });
  }
  if (lines.length === 0) throw new Error('xlsx 解析得到 0 个内容块：所有工作表均为空');
  return lines.join('\n');
}

/** Normalize an exceljs cell value to display text ('' for empty). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const obj = v as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
  }
  // Formula cells: prefer the cached result, fall back to the formula text.
  if ('result' in obj) return cellText(obj.result);
  if ('text' in obj) return String(obj.text);
  if ('error' in obj) return String(obj.error);
  return String(v);
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 'A'.charCodeAt(0) + 1);
  return n;
}

/** Widest merged range touching row r (so expanded rows don't get truncated). */
function maxMergedWidth(
  merges: Array<{ r1: number; c1: number; r2: number; c2: number }>,
  r: number,
): number {
  let w = 0;
  for (const m of merges) {
    if (r >= m.r1 && r <= m.r2) w = Math.max(w, m.c2);
  }
  return w;
}

/**
 * Quick text-layer probe for uploaded PDFs (Model C): reads the extracted text
 * length to predict 'digital' vs 'scanned' BEFORE /process runs, so the parse
 * path can start with the right adapter instead of the digital->0-blocks->OCR
 * detour. Cheap (~one pdf-parse pass), fault-tolerant:
 *  - true  => enough embedded text (born-digital);
 *  - false => little/no text (likely scanned -> MinerU OCR);
 *  - null  => not a PDF, or the probe itself failed (caller keeps its default).
 */
export async function pdfHasTextLayer(buffer: Buffer): Promise<boolean | null> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const { text } = await pdfParse(buffer);
    if (typeof text !== 'string') return null;
    return text.replace(/\s+/g, '').length >= 32;
  } catch {
    return null;
  }
}

/**
 * Ingest a born-digital file. Supports .txt/.md/.json (direct utf-8 read),
 * .pdf (pdf-parse), .docx (mammoth HTML -> GFM markdown; tables kept) and
 * .xlsx (exceljs; merges expanded, one pipe row per sheet row).
 */
export async function ingestWithDigital(
  sourceUri: string,
  docType: DocType,
  docId: string,
): Promise<BlockModel> {
  let text: string;
  if (/\.pdf$/i.test(sourceUri)) {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = readFileSync(sourceUri);
    text = (await pdfParse(buf)).text;
  } else if (/\.docx$/i.test(sourceUri)) {
    text = await extractDocxText(sourceUri);
  } else if (/\.xlsx$/i.test(sourceUri)) {
    text = await extractXlsxText(sourceUri);
  } else if (/\.xls$/i.test(sourceUri)) {
    throw new Error('旧版 .xls 不支持解析，请先在 Excel 中另存为 .xlsx 再上传');
  } else {
    text = readFileSync(sourceUri, 'utf-8');
  }
  return blockModelFromText({ docId, docType, sourceUri, text });
}

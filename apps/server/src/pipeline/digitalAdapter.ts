import { readFileSync } from 'node:fs';
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
 * Ingest a born-digital file. Supports .txt/.md/.json (direct utf-8 read),
 * .pdf (pdf-parse), and .docx (mammoth HTML -> GFM markdown; tables kept).
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
  } else {
    text = readFileSync(sourceUri, 'utf-8');
  }
  return blockModelFromText({ docId, docType, sourceUri, text });
}

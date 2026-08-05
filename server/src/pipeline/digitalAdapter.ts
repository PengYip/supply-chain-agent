import { readFileSync } from 'node:fs';
import type { Block, BlockModel, DocType } from './types.js';

export interface FromTextInput {
  docId: string;
  docType: DocType;
  sourceUri: string;
  text: string;
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
      type: text.includes(':') || text.includes('：') ? 'kv' : 'text',
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

/** Ingest a born-digital file. Supports .txt/.md (direct read) and .pdf (pdf-parse). */
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
  } else {
    text = readFileSync(sourceUri, 'utf-8');
  }
  return blockModelFromText({ docId, docType, sourceUri, text });
}

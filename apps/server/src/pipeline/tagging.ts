import type { Block, DocType } from './types.js';

/**
 * L1 internal auto-tag stage. Derives a small, deterministic tag set from the
 * docType + content keywords. No LLM (cheap, reproducible). Tags are a CLOSED
 * set drawn from AUTO_TAG_KEYWORDS below, so they are safe to surface unwrapped
 * (no injection risk). Design §8: auto-tags are an internal byproduct of
 * ingest_document, persisted, and included in the return summary.
 */
const AUTO_TAG_KEYWORDS: ReadonlyArray<{ tag: string; keywords: string[] }> = [
  { tag: '信用证', keywords: ['信用证', 'L/C', 'LC'] },
  { tag: 'CIF', keywords: ['CIF', 'cif'] },
  { tag: 'FOB', keywords: ['FOB', 'fob'] },
  { tag: '电汇', keywords: ['电汇', 'T/T', 'TT'] },
  { tag: '提单', keywords: ['提单', 'B/L', 'Bill of Lading'] },
  { tag: '装箱单', keywords: ['装箱单', 'Packing List'] },
  { tag: '发票', keywords: ['发票', 'Invoice'] },
  { tag: '合同', keywords: ['合同', 'Contract'] },
  { tag: '港口', keywords: ['港口', '装运港', '目的港', 'PORT'] },
  { tag: '重量', keywords: ['重量', '吨', '公斤', 'kg', 'ton'] },
  { tag: '检验', keywords: ['检验', '质检', '商检', 'Inspection'] },
];

const MAX_AUTO_TAGS = 8;

export function deriveAutoTags(input: { docType: DocType; blocks: Block[] }): string[] {
  const text = input.blocks.map((b) => b.text).join('\n');
  // Case-insensitive match: OCR on bilingual trade docs routinely produces
  // ALL-CAPS Latin forms (KG, TON, INVOICE, PACKING LIST, CONTRACT, INSPECTION,
  // BILL OF LADING). Normalize both sides to lowercase so those still match.
  // This only ADDS recall; exact-case matches are unchanged. The PUSHED tag is
  // the canonical-cased entry from the table, never the lowercased input.
  const lc = text.toLowerCase();
  const tags: string[] = [input.docType];
  for (const { tag, keywords } of AUTO_TAG_KEYWORDS) {
    if (tags.length >= MAX_AUTO_TAGS) break;
    if (keywords.some((k) => lc.includes(k.toLowerCase()))) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags.slice(0, MAX_AUTO_TAGS);
}

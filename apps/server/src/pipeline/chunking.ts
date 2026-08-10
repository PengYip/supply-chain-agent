// Deterministic block-based chunking for the L4 document recall index.
//
// Splits a BlockModel's text-bearing blocks into chunks small enough to be
// useful BM25 recall units (~target chars). Strategy:
//   - walk top-level blocks in document order, using their normalized text;
//   - greedily merge CONSECUTIVE small blocks into one chunk up to `target` chars
//     (newline-joined), so a document of many short KV lines does not become one
//     chunk per token;
//   - a single block larger than `target` becomes its own chunk (never split
//     mid-block, so source spans stay valid within a chunk);
//   - empty blocks are skipped.
//
// Determinism: no timestamps, no random, pure function of (blockModel, target).
// Children blocks are not recursed separately -- adapters already fold nested
// text into the parent block.text (see digitalAdapter / mineruAdapter textOf).

import type { BlockModel } from './types.js';

export interface DocChunk {
  /** Chunk text (trimmed, non-empty). */
  text: string;
  /** 0-based position of this chunk within the document. */
  index: number;
}

export const DEFAULT_CHUNK_TARGET_CHARS = 500;

/**
 * Chunk a BlockModel into recall-sized text units. Always returns a stable
 * ordering; returns [] for a document with no text-bearing blocks.
 */
export function chunkBlockModel(
  model: BlockModel,
  target: number = DEFAULT_CHUNK_TARGET_CHARS,
): DocChunk[] {
  const safeTarget = target > 0 ? target : DEFAULT_CHUNK_TARGET_CHARS;

  const texts: string[] = [];
  for (const b of model.blocks) {
    const t = (b.text ?? '').trim();
    if (t.length > 0) texts.push(t);
  }

  const chunks: DocChunk[] = [];
  let buf = '';
  let index = 0;

  const flush = (): void => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) {
      chunks.push({ text: trimmed, index: index++ });
    }
    buf = '';
  };

  for (const text of texts) {
    // A block already at/over target flushes the buffer, then stands alone so a
    // long block is never merged with neighbours (keeps spans coherent).
    if (text.length >= safeTarget) {
      flush();
      chunks.push({ text, index: index++ });
      continue;
    }
    // Merge into the buffer unless it would exceed target.
    if (buf.length > 0 && buf.length + text.length + 1 > safeTarget) {
      flush();
    }
    buf = buf.length > 0 ? `${buf}\n${text}` : text;
  }
  flush();

  return chunks;
}

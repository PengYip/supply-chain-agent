// Lane B retrieval filter: narrow a chunk list by tag membership.
//
// Pure, synchronous, total. Works on any chunk shape that carries an optional
// `tags` field (string[] | null | undefined), so it composes with DocChunk
// augmented by the tagger without coupling to a specific struct.

export type TagFilterMode = 'any' | 'all';

/**
 * Keep chunks whose tags satisfy `wantTags` under the chosen mode.
 *
 * - mode 'any' (default): keep if the chunk's tags intersect `wantTags` (>=1).
 * - mode 'all': keep if `wantTags` is a subset of the chunk's tags.
 * - Chunks with null/undefined/empty tags never match.
 * - Empty `wantTags` -> return chunks unchanged (no-op, never filter).
 */
export function filterChunksByTag<T extends { tags?: string[] | null }>(
  chunks: T[],
  wantTags: string[],
  mode: TagFilterMode = 'any',
): T[] {
  if (!wantTags || wantTags.length === 0) return chunks;

  const want = new Set(wantTags);

  return chunks.filter((c) => {
    const tags = c.tags;
    if (!tags || !Array.isArray(tags) || tags.length === 0) return false;

    if (mode === 'all') {
      // every wanted tag must be present on the chunk
      for (const t of want) {
        if (!tags.includes(t)) return false;
      }
      return true;
    }
    // 'any': at least one wanted tag present
    for (const t of tags) {
      if (want.has(t)) return true;
    }
    return false;
  });
}

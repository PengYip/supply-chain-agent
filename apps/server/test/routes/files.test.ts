import { describe, it, expect } from 'vitest';
import { env } from '../../src/env.js';
import { exceedsUploadLimit } from '../../src/routes/files.js';

describe('exceedsUploadLimit (upload size guard predicate)', () => {
  const limit = env.MAX_UPLOAD_BYTES;

  it('returns true when size exceeds the limit', () => {
    expect(exceedsUploadLimit(limit + 1, limit)).toBe(true);
    expect(exceedsUploadLimit(limit * 2, limit)).toBe(true);
  });

  it('returns false at or under the limit (boundary inclusive)', () => {
    expect(exceedsUploadLimit(limit, limit)).toBe(false);
    expect(exceedsUploadLimit(0, limit)).toBe(false);
    expect(exceedsUploadLimit(limit - 1, limit)).toBe(false);
  });

  it('default MAX_UPLOAD_BYTES is 25 MiB (CI-safe permissive default)', () => {
    // Only OPENAI_API_KEY is required; MAX_UPLOAD_BYTES has a permissive default
    // so env.ts zod-parses cleanly in CI and unit tests that import env.ts.
    expect(env.MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

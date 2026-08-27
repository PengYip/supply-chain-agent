import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createFileFolder,
  listFileFolders,
  listFileFoldersUnder,
  renameFileFoldersPrefix,
} from '../../../src/pipeline/db/repositories.js';

let ctx: ReturnType<typeof createDb>;
beforeEach(() => {
  ctx = createDb(':memory:');
  migrate(ctx.sqlite);
});

describe('renameFileFoldersPrefix', () => {
  it('cascades the rename to every row inside the subtree and returns the count', async () => {
    await createFileFolder(ctx, 'u1', '合同');
    await createFileFolder(ctx, 'u1', '合同/上游');
    await createFileFolder(ctx, 'u1', '合同/下游/明细');
    await createFileFolder(ctx, 'u1', '发票');
    const n = await renameFileFoldersPrefix(ctx, 'u1', '合同', '2026/合同归档');
    expect(n).toBe(3);
    const paths = (await listFileFolders(ctx, 'u1')).map((f) => f.path).sort();
    expect(paths).toEqual([
      '2026/合同归档',
      '2026/合同归档/上游',
      '2026/合同归档/下游/明细',
      '发票',
    ]);
  });

  it('scoping: sibling look-alikes and other users are untouched', async () => {
    await createFileFolder(ctx, 'u2', 'a');
    await createFileFolder(ctx, 'u2', 'a/b');
    await createFileFolder(ctx, 'u2', 'ax');
    await createFileFolder(ctx, 'u3', 'a');
    await renameFileFoldersPrefix(ctx, 'u2', 'a', 'z');
    expect((await listFileFolders(ctx, 'u2')).map((f) => f.path).sort())
      .toEqual(['ax', 'z', 'z/b']);
    expect((await listFileFolders(ctx, 'u3')).map((f) => f.path)).toEqual(['a']);
  });

  it('returns 0 and does not throw when nothing matches', async () => {
    expect(await renameFileFoldersPrefix(ctx, 'uX', 'ghost', 'new')).toBe(0);
  });
});

describe('listFileFoldersUnder', () => {
  it('returns only rows equal to or under the prefix for that user', async () => {
    await createFileFolder(ctx, 'u1', '合同');
    await createFileFolder(ctx, 'u1', '合同/上游');
    await createFileFolder(ctx, 'u1', '合同化');
    await createFileFolder(ctx, 'u9', '合同');
    const rows = await listFileFoldersUnder(ctx, 'u1', '合同');
    expect(rows.map((r) => r.path).sort()).toEqual(['合同', '合同/上游']);
  });
});

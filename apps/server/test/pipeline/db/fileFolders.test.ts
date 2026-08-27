import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, migrate } from '../../../src/pipeline/db/client.js';
import {
  createFileFolder,
  listFileFolders,
  listFileFoldersUnder,
  renameFileFoldersPrefix,
  setFolderSortOrders,
  listFileRanks,
  upsertFileRanks,
  deleteFileRank,
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

describe('drag-to-sort persistence', () => {
  it('setFolderSortOrders reorders listing; unlisted rows fall back to path ASC', async () => {
    await createFileFolder(ctx, 'u1', 'a');
    await createFileFolder(ctx, 'u1', 'b');
    await createFileFolder(ctx, 'u1', 'c');
    // 拖 c 到最前、b 第二；a 未列入（保持 rank=0 兜底组）
    const n = await setFolderSortOrders(ctx, 'u1', ['c', 'b']);
    expect(n).toBe(2);
    expect((await listFileFolders(ctx, 'u1')).map((f) => f.path)).toEqual(['c', 'b', 'a']);
  });

  it('user scoping: another user keeps default order', async () => {
    await createFileFolder(ctx, 'u1', 'x');
    await createFileFolder(ctx, 'u1', 'y');
    await createFileFolder(ctx, 'u2', 'x');
    await createFileFolder(ctx, 'u2', 'y');
    await setFolderSortOrders(ctx, 'u1', ['y', 'x']);
    expect((await listFileFolders(ctx, 'u1')).map((f) => f.path)).toEqual(['y', 'x']);
    expect((await listFileFolders(ctx, 'u2')).map((f) => f.path)).toEqual(['x', 'y']);
  });

  it('file ranks upsert idempotently and delete cleanly', async () => {
    const k = 'users/u1/a.pdf';
    await upsertFileRanks(ctx, 'u1', [{ key: k, order: 2 }]);
    await upsertFileRanks(ctx, 'u1', [{ key: k, order: 0 }, { key: 'users/u1/b.csv', order: 1 }]);
    expect(await listFileRanks(ctx, 'u1')).toEqual(
      new Map([['users/u1/b.csv', 1], [k, 0]]),
    );
    // 别的用户不受影响
    expect((await listFileRanks(ctx, 'u9')).size).toBe(0);
    await deleteFileRank(ctx, 'u1', k);
    expect([...(await listFileRanks(ctx, 'u1')).keys()]).toEqual(['users/u1/b.csv']);
  });
});

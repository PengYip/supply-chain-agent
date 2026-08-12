import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../src/env.js';
import { parseDocument } from '../../src/pipeline/parseDocument.js';

describe('parseDocument (pure primitive)', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(env.INGEST_ROOT, `pd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  it('parses a digital txt file into a BlockModel without DB', async () => {
    const f = join(dir, 'note.txt');
    writeFileSync(f, '第一行内容\n第二行内容\n');
    const model = await parseDocument({
      sourcePath: f,
      docType: '其他',
      docId: 'DOC-test-1',
      modality: 'digital',
    });
    expect(model.docId).toBe('DOC-test-1');
    expect(model.modality).toBe('digital');
    expect(model.blocks.length).toBeGreaterThan(0);
    expect(model.blocks.some((b) => b.text.includes('第一行内容'))).toBe(true);
  });

  it('throws on zero blocks for a non-PDF digital file (no OCR fallback)', async () => {
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '');
    await expect(
      parseDocument({ sourcePath: f, docType: '其他', docId: 'DOC-test-2', modality: 'digital' }),
    ).rejects.toThrow(/0 个内容块/);
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { env } from '../../src/env.js';
import { ingestWithMinerUApi } from '../../src/pipeline/mineruApiAdapter.js';
import type { BlockModel } from '../../src/pipeline/types.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('ingestWithMinerUApi — hermetic sidecar path', () => {
  let dir: string;
  let pdfPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mineru-api-'));
    pdfPath = join(dir, 'sample.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 fake');
    // The cloud backend shares the `.mineru.json` sidecar with the local CLI
    // backend (same middle-JSON shape), so the existing fixture is reused.
    writeFileSync(
      `${pdfPath}.mineru.json`,
      readFileSync(resolve(here, 'fixtures/mineru-sample.json'), 'utf-8'),
    );
  });

  afterAll(() => {
    // temp dir cleanup is unnecessary for tests; OS tmp handles it.
  });

  it('reads the <file>.mineru.json sidecar without network or API key', async () => {
    // No MINERU_API_KEY in the test env: the sidecar path must not require it.
    const model: BlockModel = await ingestWithMinerUApi(pdfPath, '合同', 'DOC-HERMETIC');
    expect(model.docId).toBe('DOC-HERMETIC');
    expect(model.modality).toBe('scanned');
    expect(model.blocks.length).toBeGreaterThan(0);
  });

  it('throws a config error (not a network call) when the key is missing and no sidecar exists', async () => {
    // env.ts parses process.env at import time, so the key cannot be injected
    // per-test. When MINERU_API_KEY is present (e.g. the dev .env), the missing-
    // key branch is unreachable hermetically and the network path would run —
    // skip rather than hit the live API. CI (no key) exercises the real branch.
    if (env.MINERU_API_KEY) {
      return;
    }
    const noSidecar = join(dir, 'other.pdf');
    writeFileSync(noSidecar, '%PDF-1.4 fake');
    await expect(ingestWithMinerUApi(noSidecar, '合同', 'DOC-NOKEY')).rejects.toThrowError(
      /MINERU_API_KEY/,
    );
  });
});

describe('ingestWithMinerUApi — cloud HTTP failures', () => {
  it('fails on a non-2xx presigned-URL response without polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineru-api-http-'));
    const pdfPath = join(dir, 'sample.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 fake');
    const fetchImpl = vi.fn(async () => new Response('cloud unavailable', { status: 503 }));

    await expect(
      ingestWithMinerUApi(pdfPath, '合同', 'DOC-HTTP', {
        apiKey: 'test-key',
        fetchImpl,
        uploadTimeoutMs: 1,
      }),
    ).rejects.toThrowError(/batch request failed \(HTTP 503\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the independent upload timeout for the presigned PUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mineru-api-upload-'));
    const pdfPath = join(dir, 'sample.pdf');
    writeFileSync(pdfPath, '%PDF-1.4 fake');
    const calls: Array<RequestInit | undefined> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ code: 0, data: { batch_id: 'B1', file_urls: ['https://example.test/upload'] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('upload rejected', { status: 403 });
    }) as typeof fetch;

    await expect(
      ingestWithMinerUApi(pdfPath, '合同', 'DOC-UPLOAD', {
        apiKey: 'test-key',
        fetchImpl,
        uploadTimeoutMs: 12345,
      }),
    ).rejects.toThrowError(/upload failed \(HTTP 403\)/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

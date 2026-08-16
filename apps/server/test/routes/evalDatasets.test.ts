// apps/server/test/routes/evalDatasets.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createEvalDatasetsRoute } from '../../src/routes/evalDatasets.js';

let userRoot: string;
let coreRoot: string;

function makeApp(validator: Parameters<typeof createEvalDatasetsRoute>[0]) {
  const app = new Hono();
  app.use('/api/eval/*', async (c, next) => { c.set('user', { id: 'u1' } as never); await next(); });
  app.route('/api/eval', createEvalDatasetsRoute({ coreRoot, userRoot, ...(validator ? { validator: validator.validator } : {}) }));
  return app;
}

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'eval-ds-'));
  userRoot = join(base, 'user');
  coreRoot = join(base, 'datasets');
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(coreRoot, { recursive: true });
  writeFileSync(join(coreRoot, 'core.yaml'), 'scenarios: []\n', 'utf-8');
});
afterAll(() => rmSync(userRoot, { recursive: true, force: true }));

const H = { 'Content-Type': 'application/json' };

describe('evalDatasets routes', () => {
  it('lists core (builtin) + user datasets', async () => {
    writeFileSync(join(userRoot, 'mine.yaml'), 'scenarios: []\n', 'utf-8');
    const app = makeApp(undefined);
    const r = await app.request('/api/eval/datasets');
    const d = (await r.json()) as { ok: boolean; data: { datasets: { name: string; builtin: boolean }[] } };
    const names = d.data.datasets.map((x) => `${x.name}:${x.builtin}`);
    expect(names).toContain('core:true');
    expect(names).toContain('mine:false');
  });

  it('GET returns yaml content; builtin flagged', async () => {
    const app = makeApp(undefined);
    const r = await app.request('/api/eval/datasets/core');
    const d = (await r.json()) as { ok: boolean; data: { yaml: string; builtin: boolean } };
    expect(d.data.builtin).toBe(true);
    expect(d.data.yaml).toBe('scenarios: []\n');
    await expect((await app.request('/api/eval/datasets/missing')).status).toBe(404);
  });

  it('PUT valid yaml persists; invalid -> 422 with error; builtin -> 400', async () => {
    const app = makeApp({ validator: async (f) => {
      const text = readFileSync(f, 'utf-8');
      return text.includes('BAD') ? { ok: false, error: 'scenario #0 invalid: 缩进错误' } : { ok: true, scenarioCount: 2 };
    } });
    const ok = await app.request('/api/eval/datasets/edited', { method: 'PUT', headers: H, body: JSON.stringify({ yaml: 'scenarios: fine\n' }) });
    expect(ok.status).toBe(200);
    expect(readFileSync(join(userRoot, 'edited.yaml'), 'utf-8')).toBe('scenarios: fine\n');
    expect(existsSync(join(userRoot, 'edited.yaml.tmp'))).toBe(false); // atomic: no tmp left
    const bad = await app.request('/api/eval/datasets/edited', { method: 'PUT', headers: H, body: JSON.stringify({ yaml: 'BAD' }) });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toContain('scenario #0');
    expect(readFileSync(join(userRoot, 'edited.yaml'), 'utf-8')).toBe('scenarios: fine\n'); // unchanged
    const builtin = await app.request('/api/eval/datasets/core', { method: 'PUT', headers: H, body: JSON.stringify({ yaml: 'x' }) });
    expect(builtin.status).toBe(400);
  });

  it('copy core -> user (?to=); rejects bad names / overwrite', async () => {
    const app = makeApp(undefined);
    const r = await app.request('/api/eval/datasets/core/copy?to=my-copy', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(readFileSync(join(userRoot, 'my-copy.yaml'), 'utf-8')).toBe('scenarios: []\n');
    // traversal destination -> 400 (dataset identifier contract)
    expect((await app.request('/api/eval/datasets/core/copy?to=../evil', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/api/eval/datasets/core/copy?to=my-copy', { method: 'POST' })).status).toBe(409);
    expect((await app.request('/api/eval/datasets/nosuch/copy?to=x', { method: 'POST' })).status).toBe(404);
  });

  it('DELETE removes user dataset; builtin -> 400; missing -> 404', async () => {
    const app = makeApp(undefined);
    writeFileSync(join(userRoot, 'gone.yaml'), 'x', 'utf-8');
    expect((await app.request('/api/eval/datasets/gone', { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(userRoot, 'gone.yaml'))).toBe(false);
    expect((await app.request('/api/eval/datasets/core', { method: 'DELETE' })).status).toBe(400);
    expect((await app.request('/api/eval/datasets/gone', { method: 'DELETE' })).status).toBe(404);
  });
});

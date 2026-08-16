// apps/server/src/routes/evalDatasets.ts
// User dataset CRUD: core.yaml is read-only (CD git-resets tracked files);
// user datasets live under eval/agent/datasets/user/ (gitignored). PUT
// validates via a one-shot validate.ts child process (rootDir-safe pattern).

import { Hono } from 'hono';
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { datasetArgFor } from './evalRunCore.js';

const here = dirname(fileURLToPath(import.meta.url));

// Spawn tsx via node directly (no npx wrapper). Probe-verified: the package
// bin entry 'tsx/cli' resolves to dist/cli.mjs; 'tsx/dist/cli.mjs' is not
// exported (same seam as evalRunCore).
const require_ = createRequire(import.meta.url);
let tsxCliPath: string | null = null;
try {
  tsxCliPath = require_.resolve('tsx/cli');
} catch {
  tsxCliPath = null;
}

export interface DatasetRouteOpts {
  coreRoot?: string;
  userRoot?: string;
  validator?: (file: string) => Promise<{ ok: true; scenarioCount: number } | { ok: false; error: string }>;
}

/** Default validator: spawn tsx eval/agent/validate.ts (cwd=apps/server). */
async function defaultValidator(file: string): Promise<{ ok: true; scenarioCount: number } | { ok: false; error: string }> {
  return new Promise((res) => {
    const command = tsxCliPath ? process.execPath : process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const args = tsxCliPath
      ? [tsxCliPath, 'eval/agent/validate.ts', file]
      : ['tsx', 'eval/agent/validate.ts', file];
    const child = spawn(command, args, { cwd: resolve(here, '../..'), stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    child.on('exit', (code) => {
      try {
        const parsed = JSON.parse(out.trim()) as { ok: boolean; scenarioCount?: number; error?: string };
        if (code === 0 && parsed.ok) res({ ok: true, scenarioCount: parsed.scenarioCount ?? 0 });
        else res({ ok: false, error: parsed.error ?? '校验失败' });
      } catch {
        res({ ok: false, error: '校验进程输出异常' });
      }
    });
    child.on('error', () => res({ ok: false, error: '无法启动校验进程' }));
  });
}

/**
 * Dataset name validation reusing evalRunCore's identifier contract
 * ('core' | 'user/<name>', rejects '..' / absolute paths / slash nesting).
 * Extra filename hardening for the Windows separator/drive edge (`\`, `:`).
 */
function validName(name: string): boolean {
  if (!name || name.includes('\\') || name.includes(':')) return false;
  try {
    datasetArgFor(name === 'core' ? 'core' : `user/${name}`);
    return true;
  } catch {
    return false;
  }
}

export function createEvalDatasetsRoute(opts: DatasetRouteOpts = {}) {
  const coreRoot = opts.coreRoot ?? resolve(here, '../../eval/agent/datasets');
  const userRoot = opts.userRoot ?? resolve(coreRoot, 'user');
  const validate = opts.validator ?? defaultValidator;
  const route = new Hono<AuthEnv>();

  // Defense-in-depth: join then resolve, and require the final path to stay
  // inside the intended root (validName already blocks traversal; this is a
  // second line of defense per controller requirement).
  const guarded = (root: string, file: string): string => {
    const full = resolve(join(root, file));
    if (!full.startsWith(resolve(root) + sep)) throw new Error('数据集路径越界');
    return full;
  };

  const userPath = (name: string) => guarded(userRoot, `${name}.yaml`);
  const corePath = (name: string) => guarded(coreRoot, `${name}.yaml`);

  route.get('/datasets', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const datasets: { name: string; builtin: boolean; scenarioCount: number | null }[] = [];
    if (existsSync(coreRoot)) {
      for (const f of readdirSync(coreRoot)) {
        if (f.endsWith('.yaml')) datasets.push({ name: f.slice(0, -5), builtin: true, scenarioCount: null });
      }
    }
    if (existsSync(userRoot)) {
      for (const f of readdirSync(userRoot)) {
        if (f.endsWith('.yaml')) datasets.push({ name: f.slice(0, -5), builtin: false, scenarioCount: null });
      }
    }
    return c.json({ ok: true, data: { datasets } });
  });

  route.get('/datasets/:name', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!validName(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (existsSync(corePath(name))) {
      return c.json({ ok: true, data: { name, builtin: true, yaml: readFileSync(corePath(name), 'utf-8') } });
    }
    if (existsSync(userPath(name))) {
      return c.json({ ok: true, data: { name, builtin: false, yaml: readFileSync(userPath(name), 'utf-8') } });
    }
    return c.json({ ok: false, error: '数据集不存在' }, 404);
  });

  route.put('/datasets/:name', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!validName(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (existsSync(corePath(name))) return c.json({ ok: false, error: '内置数据集只读' }, 400);
    const body = await c.req.json().catch(() => null) as { yaml?: unknown } | null;
    if (typeof body?.yaml !== 'string' || !body.yaml.trim()) return c.json({ ok: false, error: 'yaml 内容缺失' }, 400);
    mkdirSync(userRoot, { recursive: true });
    // Validate against the tmp file, then atomic-rename into place.
    const tmp = guarded(userRoot, `${name}.yaml.tmp`);
    writeFileSync(tmp, body.yaml, 'utf-8');
    const verdict = await validate(tmp);
    if (!verdict.ok) {
      unlinkSync(tmp);
      return c.json({ ok: false, error: verdict.error }, 422);
    }
    renameSync(tmp, userPath(name));
    return c.json({ ok: true, data: { name, scenarioCount: verdict.scenarioCount } });
  });

  route.post('/datasets/:name/copy', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!validName(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    // Copy source = current dataset of the same name (core or user).
    const src = existsSync(corePath(name)) ? corePath(name) : existsSync(userPath(name)) ? userPath(name) : null;
    if (!src) return c.json({ ok: false, error: '源数据集不存在' }, 404);
    // Destination name from query ?to=
    const to = c.req.query('to');
    if (!to || !validName(to)) return c.json({ ok: false, error: '目标名不合法' }, 400);
    const dst = userPath(to);
    if (existsSync(dst)) return c.json({ ok: false, error: '目标已存在' }, 409);
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(dst, readFileSync(src, 'utf-8'), 'utf-8');
    return c.json({ ok: true, data: { name: to } });
  });

  route.delete('/datasets/:name', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    if (!validName(name)) return c.json({ ok: false, error: '数据集名不合法' }, 400);
    if (existsSync(corePath(name))) return c.json({ ok: false, error: '内置数据集不可删除' }, 400);
    if (!existsSync(userPath(name))) return c.json({ ok: false, error: '数据集不存在' }, 404);
    unlinkSync(userPath(name));
    return c.json({ ok: true, data: { deleted: true } });
  });

  return route;
}

export const evalDatasetsRoute = createEvalDatasetsRoute();

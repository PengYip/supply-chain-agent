// apps/server/src/routes/evalResults.ts
// 评估结果只读 API (spec §4.2/§4.3)。工厂注入 resultsRoot; requireAuth 由
// index.ts 统一门控 (对齐 sessions/files/review 模式)。
import { Hono } from 'hono';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, parseEpisodesFile, toEpisodeView, defaultResultsRoot } from './evalResultsCore.js';

export function createEvalResultsRoute(resultsRoot: string = defaultResultsRoot()) {
  const evalResultsRoute = new Hono<AuthEnv>();

  evalResultsRoute.get('/runs', (c) => {
    return c.json({ ok: true, data: { runs: listRuns(resultsRoot) } });
  });

  evalResultsRoute.get('/runs/:runId/episodes', (c) => {
    const runId = c.req.param('runId');
    const episodesPath = join(resultsRoot, runId, 'episodes.jsonl');
    // runId 来自路径参数, 直接拼 join 有目录穿越风险, 只允许目录名字符集,
    // 且显式拒绝 `..` (该字符集本身放行两个连续点, join 会解析到上级目录)。
    if (!/^[\w.-]+$/.test(runId) || runId.includes('..') || !existsSync(episodesPath)) {
      return c.json({ ok: false, error: 'run 不存在' }, 404);
    }
    const { pairs, droppedLines } = parseEpisodesFile(readFileSync(episodesPath, 'utf-8'));
    const episodes = pairs
      .slice()
      .sort((a, b) => a.artifact.scenarioId.localeCompare(b.artifact.scenarioId) || a.artifact.runIndex - b.artifact.runIndex)
      .map(toEpisodeView);
    return c.json({ ok: true, data: { episodes, droppedLines } });
  });

  return evalResultsRoute;
}

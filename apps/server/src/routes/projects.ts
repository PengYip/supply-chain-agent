// 项目维度 API(design 2026-08-20 §6.1)。projects/project_memberships 是 SSOT;
// Neo4j 只在确认时经 syncProjectMembershipGraph 投影(故障隔离, 结果落 graph_status)。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  createProject, findProjectByCode, listProjects, findMembershipById,
  listMembershipsByProject, updateMembershipStatus, upsertProjectMembership,
  setMembershipGraphStatus, normalizeProjectCode,
} from '../pipeline/db/repositories.js';
import { syncProjectMembershipGraph } from '../pipeline/projectGraphSync.js';
import { normalizeContractNo } from '../pipeline/contractLedger.js';
import { rollupProject } from '../pipeline/projectRollup.js';
import { TRADE_VOCAB } from '../domain/tradeSemantics.js';

export const projectsRoute = new Hono<AuthEnv>();

// 每请求取 ctx(与 bindings/parties 路由同款; 生产下 getDbContext 自身是单例)。
function ctx(): DbContext {
  return getDbContext();
}

const createProjectSchema = z.object({ code: z.string().min(1), name: z.string().min(1) });
const assignSchema = z.object({
  contractNo: z.string().min(1),
  role: z.string().optional(),
  confidence: z.number().optional(),
});
const MEMBERSHIP_STATUSES = new Set(['proposed', 'confirmed', 'rejected']);

/** GET /api/projects —— 列表 + 归属计数。 */
projectsRoute.get('/', async (c) => {
  const user = c.get('user');
  const projects = await listProjects(ctx(), user?.id);
  const out = [];
  for (const p of projects) {
    const ms = await listMembershipsByProject(ctx(), p.code, user?.id);
    out.push({
      ...p,
      membershipCount: ms.filter((m) => m.status === 'confirmed').length,
      proposedCount: ms.filter((m) => m.status === 'proposed').length,
    });
  }
  return c.json({ projects: out });
});

/** POST /api/projects —— 新建项目(code 归一大写)。 */
projectsRoute.post('/', async (c) => {
  const user = c.get('user');
  const parsed = createProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const code = normalizeProjectCode(parsed.data.code);
  const project = await createProject(ctx(), { code, name: parsed.data.name.trim(), userId: user?.id });
  if (!project) return c.json({ ok: false, error: 'project_exists' }, 409);
  return c.json({ ok: true, project }, 201);
});

/** GET /api/projects/:code/rollup —— 项目统计汇总(spec §5)。 */
projectsRoute.get('/:code/rollup', async (c) => {
  const user = c.get('user');
  const rollup = await rollupProject(ctx(), c.req.param('code'), user?.id);
  if (!rollup) return c.json({ ok: false, error: 'project_not_found' }, 404);
  return c.json({ ok: true, rollup });
});

/** GET /api/projects/:code/memberships —— 项目归属列表(?status= 过滤)。 */
projectsRoute.get('/:code/memberships', async (c) => {
  const user = c.get('user');
  const code = normalizeProjectCode(c.req.param('code'));
  const project = await findProjectByCode(ctx(), code, user?.id);
  if (!project) return c.json({ ok: false, error: 'project_not_found' }, 404);
  const statusParam = c.req.query('status');
  const status = statusParam && MEMBERSHIP_STATUSES.has(statusParam)
    ? (statusParam as 'proposed' | 'confirmed' | 'rejected')
    : undefined;
  const memberships = await listMembershipsByProject(ctx(), project.code, user?.id, status);
  return c.json({ ok: true, project, memberships });
});

/** POST /api/projects/:code/memberships —— 人工指派(直接 confirmed)。 */
projectsRoute.post('/:code/memberships', async (c) => {
  const user = c.get('user');
  const code = normalizeProjectCode(c.req.param('code'));
  const project = await findProjectByCode(ctx(), code, user?.id);
  if (!project) return c.json({ ok: false, error: 'project_not_found' }, 404);
  const parsed = assignSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  if (parsed.data.role && !TRADE_VOCAB.contractTypes.includes(parsed.data.role as never)) {
    return c.json({ ok: false, error: 'invalid_role' }, 400);
  }
  const contractNo = normalizeContractNo(parsed.data.contractNo);
  if (!contractNo) return c.json({ ok: false, error: 'invalid_contract_no' }, 400);
  const id = await upsertProjectMembership(ctx(), {
    contractNo,
    projectCode: project.code,
    role: parsed.data.role ?? null,
    status: 'confirmed',
    proposedBy: 'human',
    confirmationSource: 'human',
    confidence: parsed.data.confidence ?? 1,
    createdBy: user?.id ?? 'human',
  }, user?.id);
  // 图投影: 故障隔离, 结果落 graph_status, 绝不阻塞指派。
  let graphStatus: Awaited<ReturnType<typeof syncProjectMembershipGraph>> | null = null;
  try {
    graphStatus = await syncProjectMembershipGraph(ctx(), {
      contractNo, projectCode: project.code, projectName: project.name,
      role: parsed.data.role ?? '', confidence: parsed.data.confidence ?? 1,
    });
    await setMembershipGraphStatus(ctx(), id, graphStatus, user?.id);
  } catch (e) {
    console.error('[projects] 归属图同步失败:', e instanceof Error ? e.message : String(e));
  }
  const memberships = await listMembershipsByProject(ctx(), project.code, user?.id);
  const membership = memberships.find((m) => m.id === id) ?? null;
  return c.json({ ok: true, membership, graphStatus }, 201);
});

/** POST /api/projects/memberships/:id/confirm —— 确认提议。 */
projectsRoute.post('/memberships/:id/confirm', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const existing = await findMembershipById(ctx(), id, user?.id);
  if (!existing) return c.json({ ok: false, error: 'membership_not_found' }, 404);
  const updated = await updateMembershipStatus(ctx(), id, 'confirmed', 'human', user?.id);
  const project = await findProjectByCode(ctx(), existing.projectCode, user?.id);
  let graphStatus: Awaited<ReturnType<typeof syncProjectMembershipGraph>> | null = null;
  try {
    graphStatus = await syncProjectMembershipGraph(ctx(), {
      contractNo: existing.contractNo,
      projectCode: existing.projectCode,
      projectName: project?.name ?? existing.projectCode,
      role: existing.role ?? '',
      confidence: existing.confidence,
    });
    await setMembershipGraphStatus(ctx(), id, graphStatus, user?.id);
  } catch (e) {
    console.error('[projects] 确认图同步失败:', e instanceof Error ? e.message : String(e));
  }
  return c.json({ ok: true, membership: updated, graphStatus });
});

/** POST /api/projects/memberships/:id/reject —— 拒绝提议(不触图)。 */
projectsRoute.post('/memberships/:id/reject', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const updated = await updateMembershipStatus(ctx(), id, 'rejected', 'human', user?.id);
  if (!updated) return c.json({ ok: false, error: 'membership_not_found' }, 404);
  return c.json({ ok: true, membership: updated });
});

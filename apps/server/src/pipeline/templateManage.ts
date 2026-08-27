// 模板管理业务层(P4 spec 2026-08-26 §3.3/§5): Task 3(REST /api/templates)与
// Task 4(Agent manage_template 工具)共用的唯一写入面。所有成功路径原子地:
//   写业务列 + SET managed_at/managed_by(managed-wins => boot seed 不再覆写,
//   见 Task 1 ensure* 条件更新) + bumpTemplateVersion(结构化 changeSummary)。
//
// 层裁定: 双后端分支写在本文件内(ctx.sqlite / ctx.pool), 操作面窄(每操作一条
// UPDATE/INSERT + 两条只读查询), 不值得为此扩 repositories 公共面(quotaTools 先例)。
// 变更不回溯铁律(spec §5): 只写三表自身与 versions 审计表, 已落图边/契约台账不触碰。
import type { DbContext } from './db/client.js';
import { bumpTemplateVersion } from './db/repositories.js';

export type ManageErrorCode = 'not_found' | 'duplicate' | 'protected' | 'invalid';

/** 工具层与 REST 各自把 code 映射为工具 error 文案/HTTP 状态, 业务层不掺传输语义。 */
export type ManageResult<T> =
  | { ok: true; data: T; templateVersion: number }
  | { ok: false; reason: string; code: ManageErrorCode };

interface TypeCoreRow {
  id: string;
  kind: 'doc_type' | 'contract_type';
  name: string;
  parentId: string | null;
  propsRaw: string;
}

function fail<T>(reason: string, code: ManageErrorCode): ManageResult<T> {
  return { ok: false, reason, code };
}

function templateTypeId(kind: 'doc_type' | 'contract_type', name: string): string {
  return `${kind === 'doc_type' ? 'dt' : 'ct'}-${name}`;
}

async function findTypeIdByNameAndKind(ctx: DbContext, name: string, kind: string): Promise<string | null> {
  if (ctx.backend === 'sqlite') {
    const r = ctx.sqlite.prepare(
      'SELECT id FROM template_types WHERE kind = ? AND name = ?',
    ).get(kind, name) as { id: string } | undefined;
    return r ? r.id : null;
  }
  const { rows } = await ctx.pool.query(
    'SELECT id FROM template_types WHERE kind = $1 AND name = $2 LIMIT 1', [kind, name]);
  return rows.length > 0 ? String((rows[0] as Record<string, unknown>).id) : null;
}

async function getTemplateTypeById(ctx: DbContext, id: string): Promise<TypeCoreRow | null> {
  if (ctx.backend === 'sqlite') {
    const r = ctx.sqlite.prepare(
      'SELECT id, kind, name, parent_id, props FROM template_types WHERE id = ?',
    ).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      kind: r.kind === 'contract_type' ? 'contract_type' : 'doc_type',
      name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
      propsRaw: String(r.props ?? '{}'),
    };
  }
  const { rows } = await ctx.pool.query(
    'SELECT id, kind, name, parent_id, props FROM template_types WHERE id = $1 LIMIT 1', [id]);
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    kind: r.kind === 'contract_type' ? 'contract_type' : 'doc_type',
    name: String(r.name), parentId: r.parent_id ? String(r.parent_id) : null,
    propsRaw: typeof r.props === 'string' ? r.props : JSON.stringify(r.props ?? {}),
  };
}

/**
 * bindingsTargetKind 是 props 中唯一有行为语义的键(立项书 binds->Project 的
 * 终点泛化), 值域收紧为 'Project'|'Contract'; 其余键是自由 JSON, 消费方自行
 * 取键, 不做白名单过滤(spec §3.3 裁定)。返回 null=合法。
 */
function checkBindingsTargetKind(props?: Record<string, unknown>): string | null {
  const btk = props?.bindingsTargetKind;
  if (btk === undefined) return null;
  if (btk !== 'Project' && btk !== 'Contract') {
    return `bindingsTargetKind 只接受 'Project' 或 'Contract', 得到 ${JSON.stringify(btk) ?? String(btk)}`;
  }
  return null;
}

async function stampManagedAndBump(
  ctx: DbContext, summary: string, changedBy: string,
): Promise<number> {
  return bumpTemplateVersion(ctx, { changedBy, changeSummary: summary });
}

export async function createTemplateType(
  ctx: DbContext, actor: string, input: {
    kind: 'doc_type' | 'contract_type'; name: string;
    parentIdName?: string;
    props?: Record<string, unknown>;
  },
): Promise<ManageResult<{ id: string }>> {
  const name = input.name.trim();
  if (!name) return fail('name 不能为空', 'invalid');
  const propsErr = checkBindingsTargetKind(input.props);
  if (propsErr) return fail(propsErr, 'invalid');

  let parentId: string | null = null;
  if (input.parentIdName !== undefined && input.parentIdName.trim() !== '') {
    parentId = await findTypeIdByNameAndKind(ctx, input.parentIdName.trim(), input.kind);
    if (!parentId) return fail(`父类型不存在: ${input.parentIdName}`, 'not_found');
  }

  // 重名判定走预查(唯一索引兜底并发窗口; 单实例 Hono 下预查即终态)。
  const dup = await findTypeIdByNameAndKind(ctx, name, input.kind);
  if (dup) return fail(`同 kind 下已存在同名类型: ${name}`, 'duplicate');

  const id = templateTypeId(input.kind, name);
  if (ctx.backend === 'sqlite') {
    ctx.sqlite.prepare(
      `INSERT INTO template_types (id, kind, name, parent_id, props, managed_at, managed_by)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
    ).run(id, input.kind, name, parentId, JSON.stringify(input.props ?? {}), actor);
  } else {
    await ctx.pool.query(
      `INSERT INTO template_types (id, kind, name, parent_id, props, managed_at, managed_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [id, input.kind, name, parentId, JSON.stringify(input.props ?? {}), actor]);
  }
  const templateVersion = await stampManagedAndBump(ctx, `type.create ${name}`, actor);
  return { ok: true, data: { id }, templateVersion };
}

export async function updateTemplateTypeProps(
  ctx: DbContext, actor: string, input: {
    typeId: string; parentIdName?: string | null; props?: Record<string, unknown>;
  },
): Promise<ManageResult<{ id: string }>> {
  const cur = await getTemplateTypeById(ctx, input.typeId);
  if (!cur) return fail(`类型不存在: ${input.typeId}`, 'not_found');
  if (input.props === undefined && input.parentIdName === undefined) {
    return fail('未提供任何变更字段(props / parentIdName)', 'invalid');
  }
  const propsErr = checkBindingsTargetKind(input.props);
  if (propsErr) return fail(propsErr, 'invalid');

  // parentIdName 三态: undefined=不动; null=解除挂接; 字符串=按名引父(与 dt-/ct- 约定解耦)。
  let nextParentId = cur.parentId;
  if (input.parentIdName !== undefined) {
    if (input.parentIdName === null) {
      nextParentId = null;
    } else {
      const p = await findTypeIdByNameAndKind(ctx, input.parentIdName.trim(), cur.kind);
      if (!p) return fail(`父类型不存在: ${input.parentIdName}`, 'not_found');
      if (p === cur.id) return fail('父类型不能是自己', 'invalid');
      nextParentId = p;
    }
  }

  // props 为整体替换语义(调用方传完整期望对象); 未提供则原样保留。
  const nextPropsRaw = input.props !== undefined ? JSON.stringify(input.props) : cur.propsRaw;

  if (ctx.backend === 'sqlite') {
    ctx.sqlite.prepare(
      `UPDATE template_types SET parent_id = ?, props = ?, managed_at = datetime('now'), managed_by = ?
       WHERE id = ?`,
    ).run(nextParentId, nextPropsRaw, actor, cur.id);
  } else {
    await ctx.pool.query(
      `UPDATE template_types SET parent_id = $1, props = $2, managed_at = now(), managed_by = $3
       WHERE id = $4`,
      [nextParentId, nextPropsRaw, actor, cur.id],
    );
  }
  const templateVersion = await stampManagedAndBump(ctx, `type.props_update ${cur.name}`, actor);
  return { ok: true, data: { id: cur.id }, templateVersion };
}

export async function updateEdgeRuleVocab(
  ctx: DbContext, actor: string, input: { ruleId: string; allowedVocab: string[] },
): Promise<ManageResult<{ id: string }>> {
  if (!Array.isArray(input.allowedVocab) || input.allowedVocab.some((v) => typeof v !== 'string')) {
    return fail('allowedVocab 必须是字符串数组', 'invalid');
  }
  const exists = await ruleExistsById(ctx, input.ruleId);
  if (!exists) return fail(`边规则不存在: ${input.ruleId}`, 'not_found');

  const vocabJson = JSON.stringify(input.allowedVocab);
  if (ctx.backend === 'sqlite') {
    ctx.sqlite.prepare(
      `UPDATE template_edge_rules SET allowed_vocab = ?, managed_at = datetime('now'), managed_by = ?
       WHERE id = ?`,
    ).run(vocabJson, actor, input.ruleId);
  } else {
    await ctx.pool.query(
      `UPDATE template_edge_rules SET allowed_vocab = $1, managed_at = now(), managed_by = $2
       WHERE id = $3`,
      [vocabJson, actor, input.ruleId],
    );
  }
  const templateVersion = await stampManagedAndBump(ctx, `rule.vocab_update ${input.ruleId}`, actor);
  return { ok: true, data: { id: input.ruleId }, templateVersion };
}

export async function setTemplateTypeActive(
  ctx: DbContext, actor: string, input: { typeName: string; active: boolean },
): Promise<ManageResult<{ id: string; inUseReasons?: string[] }>> {
  // 只作用于 doc_type 软禁用: 契约类型是登记型字典, 校验守卫模型只挂 doc_type 树。
  const t = await findTypeIdByNameAndKind(ctx, input.typeName.trim(), 'doc_type');
  if (!t) return fail(`doc_type 类型不存在: ${input.typeName}`, 'not_found');

  // 删除保护形态: 硬删一律不存在(spec §5); inUseReasons 仅展示提示, 不阻止软禁用。
  let payload: { id: string; inUseReasons?: string[] } = { id: t };
  if (!input.active) {
    payload = { id: t, inUseReasons: await typeUsageReasonsInternal(ctx, t, input.typeName.trim()) };
  }

  if (ctx.backend === 'sqlite') {
    ctx.sqlite.prepare(
      `UPDATE template_types SET is_active = ?, managed_at = datetime('now'), managed_by = ?
       WHERE id = ?`,
    ).run(input.active ? 1 : 0, actor, t);
  } else {
    await ctx.pool.query(
      `UPDATE template_types SET is_active = $1, managed_at = now(), managed_by = $2
       WHERE id = $3`,
      [input.active ? 1 : 0, actor, t],
    );
  }
  const verb = input.active ? 'activate' : 'deactivate';
  const templateVersion = await stampManagedAndBump(ctx, `type.${verb} ${input.typeName.trim()}`, actor);
  return { ok: true, data: payload, templateVersion };
}

export async function setEdgeRuleActive(
  ctx: DbContext, actor: string, input: { ruleId: string; active: boolean },
): Promise<ManageResult<{ id: string }>> {
  if (!(await ruleExistsById(ctx, input.ruleId))) {
    return fail(`边规则不存在: ${input.ruleId}`, 'not_found');
  }
  if (ctx.backend === 'sqlite') {
    ctx.sqlite.prepare(
      `UPDATE template_edge_rules SET is_active = ?, managed_at = datetime('now'), managed_by = ?
       WHERE id = ?`,
    ).run(input.active ? 1 : 0, actor, input.ruleId);
  } else {
    await ctx.pool.query(
      `UPDATE template_edge_rules SET is_active = $1, managed_at = now(), managed_by = $2
       WHERE id = $3`,
      [input.active ? 1 : 0, actor, input.ruleId],
    );
  }
  const verb = input.active ? 'activate' : 'deactivate';
  const templateVersion = await stampManagedAndBump(ctx, `rule.${verb} ${input.ruleId}`, actor);
  return { ok: true, data: { id: input.ruleId }, templateVersion };
}

// ---- 删除保护展示 helper(spec §5) -------------------------------------------
// 硬删一律不存在; 这里只为管理界面/AI 话术计算"该类型还被谁用着"的提示信息。

/** 边规则引用不计 target_type_id='' 通配行(通配不构成对特定类型的占用依赖)。 */
async function typeUsageReasonsInternal(ctx: DbContext, typeId: string, typeName: string): Promise<string[]> {
  const reasons: string[] = [];
  let refIds: string[] = [];
  if (ctx.backend === 'sqlite') {
    refIds = (ctx.sqlite.prepare(
      `SELECT r.id FROM template_edge_rules r
       WHERE r.is_active = 1 AND (r.source_type_id = ? OR r.target_type_id = ?)
       ORDER BY r.id`,
    ).all(typeId, typeId) as Array<{ id: string }>).map((r) => r.id);
  } else {
    const { rows } = await ctx.pool.query(
      `SELECT r.id FROM template_edge_rules r
       WHERE r.is_active = 1 AND (r.source_type_id = $1 OR r.target_type_id = $1)
       ORDER BY r.id`, [typeId]);
    refIds = rows.map((r: Record<string, unknown>) => String(r.id));
  }
  for (const rid of refIds) reasons.push(`激活边规则 ${rid} 引用`);
  const n = await documentsCountByDocType(ctx, typeName);
  if (n > 0) reasons.push(`documents 表存在 ${n} 个该类型文档`);
  return reasons;
}

export async function typeUsageReasons(ctx: DbContext, typeName: string): Promise<string[]> {
  const typeId = await findTypeIdByNameAndKind(ctx, typeName.trim(), 'doc_type');
  // 名称解析失败直接返回空: 传 '' 进内部查询会命中 er-bind-fallback
  // (source_type_id='') 通配行, 产生伪占用原因。(软禁用链路已有 not_found 守卫。)
  if (!typeId) return [];
  return typeUsageReasonsInternal(ctx, typeId, typeName.trim());
}

async function ruleExistsById(ctx: DbContext, ruleId: string): Promise<boolean> {
  if (ctx.backend === 'sqlite') {
    return ctx.sqlite.prepare('SELECT 1 AS x FROM template_edge_rules WHERE id = ?').get(ruleId) !== undefined;
  }
  const { rows } = await ctx.pool.query('SELECT 1 AS x FROM template_edge_rules WHERE id = $1 LIMIT 1', [ruleId]);
  return rows.length > 0;
}

async function documentsCountByDocType(ctx: DbContext, docTypeName: string): Promise<number> {
  // documents.doc_type 无独立索引, 全扫可接受(管理端低频修复类操作)。
  if (ctx.backend === 'sqlite') {
    const r = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM documents WHERE doc_type = ?')
      .get(docTypeName) as { n: number };
    return Number(r.n);
  }
  const { rows } = await ctx.pool.query('SELECT COUNT(*) AS n FROM documents WHERE doc_type = $1', [docTypeName]);
  return Number((rows[0] as Record<string, unknown>).n);
}

// ---- 版本审计只读(Task 2 一并补齐, REST GET /api/templates/versions 用) ------

export interface TemplateVersionRow {
  version: number; changedBy: string; changeSummary: string; changedAt: string;
}

export async function listTemplateVersions(ctx: DbContext, limit = 100): Promise<TemplateVersionRow[]> {
  const capped = Math.max(1, Math.min(limit, 500));
  if (ctx.backend === 'sqlite') {
    const rows = ctx.sqlite.prepare(
      'SELECT version, changed_by, change_summary, changed_at FROM template_versions ORDER BY version DESC LIMIT ?',
    ).all(capped) as Record<string, unknown>[];
    return rows.map((r) => ({
      version: Number(r.version), changedBy: String(r.changed_by),
      changeSummary: String(r.change_summary), changedAt: String(r.changed_at),
    }));
  }
  const { rows } = await ctx.pool.query(
    'SELECT version, changed_by, change_summary, changed_at FROM template_versions ORDER BY version DESC LIMIT $1',
    [capped],
  );
  return rows.map((r: Record<string, unknown>) => ({
    version: Number(r.version), changedBy: String(r.changed_by),
    changeSummary: String(r.change_summary), changedAt: String(r.changed_at),
  }));
}

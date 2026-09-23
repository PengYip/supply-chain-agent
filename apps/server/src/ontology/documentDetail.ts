// apps/server/src/ontology/documentDetail.ts
// 穿透图谱 Document 节点详情(2026-09-23)：把 docId 解析成人类可读的
// 「项目 \ 合同 \ 单据类型 \ 单据名称」面包屑 + 原文件预览锚点。
// 只读：本模块只含 SELECT，绝不写任何源表(与 projection.ts 同铁律)。
// 数据链: documents -> bindings(target_kind=Contract) / contract_ledger.document_id
//   (单据即合同原件) -> contract_ledger(合同名/类型) -> project_memberships -> projects。
import type { DbContext, PostgresDbContext } from '../pipeline/db/client.js';
import { effectiveUserId } from '../pipeline/db/repositories.js';
import { numberPlaceholders } from './asof.js';
import { parseFileKey } from '../routes/files.js';

/** 旧表 user_id 历史可空，防御性三路(对齐 projection.USER_SCOPE_LEGACY)。 */
const USER_SCOPE_LEGACY = "(user_id = ? OR user_id = '' OR user_id IS NULL)";

export interface DocumentContractRef {
  contractNo: string;
  /** contract_ledger 行 id(穿透跳转锚点)；台账无此合同号时 null(绑定悬空)。 */
  ledgerId: string | null;
  title: string | null;
  contractType: string | null;
  /** 绑定关系词(凭证/货权转移/...); 单据即合同原件时为 '合同原件'。 */
  relation: string;
  /** proposed=待确认绑定, confirmed=已确认。 */
  status: string;
}

export interface DocumentProjectRef {
  code: string;
  name: string;
  status: string;
}

export interface DocumentDetail {
  docId: string;
  docType: string;
  /** 人类可读文件名: MinIO key 还原的上传原名, 回退 source_uri basename。 */
  filename: string;
  parseStatus: string;
  reviewStatus: string;
  batchRole: string | null;
  minioKey: string | null;
  /** 同源文件流式预览锚点(GET /api/files/stream, 会话鉴权); 无 MinIO 对象时 null。 */
  previewUrl: string | null;
  createdAt: string | null;
  contracts: DocumentContractRef[];
  projects: DocumentProjectRef[];
  /** 项目 \ 合同 \ 单据类型 \ 单据名称(多值取第一个, 依序拼非空段)。 */
  breadcrumb: string;
}

/** SQLite datetime('now') -> ISO(字典序=时间序, 对齐 projection.normalizeLegacyDt)。 */
function normalizeLegacyDt(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.includes(' ') ? `${s.replace(' ', 'T')}Z` : s;
}

async function query(
  ctx: DbContext, sql: string, params: unknown[],
): Promise<Array<Record<string, unknown>>> {
  if (ctx.backend === 'postgres') {
    const res = await (ctx as PostgresDbContext).pool.query(numberPlaceholders(sql), params);
    return res.rows as Array<Record<string, unknown>>;
  }
  return ctx.sqlite.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/** 单据绑定的合同集合: bindings(Contract 目标) ∪ 台账 document_id=本单(合同原件)。 */
async function loadContractRefs(
  ctx: DbContext, docId: string, uid: string,
): Promise<DocumentContractRef[]> {
  const bindSql = `SELECT contract_no, relation, status FROM bindings
                    WHERE document_id = ? AND target_kind = 'Contract' AND ${USER_SCOPE_LEGACY}`;
  const bound = await query(ctx, bindSql, [docId, uid]);
  const refMap = new Map<string, DocumentContractRef>();
  for (const b of bound) {
    const no = String(b['contract_no'] ?? '');
    if (!no) continue;
    refMap.set(no, {
      contractNo: no, ledgerId: null, title: null, contractType: null,
      relation: String(b['relation'] ?? ''), status: String(b['status'] ?? 'proposed'),
    });
  }
  // 单据即合同原件: 台账行由本单抽取回写(document_id=docId)。
  const origSql = `SELECT contract_no, title, contract_type FROM contract_ledger
                    WHERE document_id = ? AND ${USER_SCOPE_LEGACY}`;
  for (const r of await query(ctx, origSql, [docId, uid])) {
    const no = String(r['contract_no'] ?? '');
    if (!no) continue;
    const existing = refMap.get(no);
    if (existing) {
      existing.relation = '合同原件';
      existing.status = 'confirmed';
    } else {
      refMap.set(no, {
        contractNo: no, ledgerId: null, title: null, contractType: null,
        relation: '合同原件', status: 'confirmed',
      });
    }
  }
  // 台账行补全(ledgerId/title/contractType); 绑定悬空(无台账行)保持 ledgerId=null。
  if (refMap.size > 0) {
    const nos = [...refMap.keys()];
    const leadSql = `SELECT id, contract_no, title, contract_type FROM contract_ledger
                      WHERE contract_no IN (${nos.map(() => '?').join(',')}) AND ${USER_SCOPE_LEGACY}`;
    for (const r of await query(ctx, leadSql, [...nos, uid])) {
      const no = String(r['contract_no'] ?? '');
      const ref = refMap.get(no);
      if (!ref) continue;
      ref.ledgerId = String(r['id']);
      ref.title = r['title'] != null && String(r['title']) !== '' ? String(r['title']) : null;
      ref.contractType = r['contract_type'] != null ? String(r['contract_type']) : null;
    }
  }
  return [...refMap.values()];
}

/** 合同集合 -> 项目归属(project_memberships SSOT, confirmed 优先保留全部状态)。 */
async function loadProjectRefs(
  ctx: DbContext, contractNos: readonly string[], uid: string,
): Promise<DocumentProjectRef[]> {
  if (contractNos.length === 0) return [];
  const sql = `SELECT m.project_code, m.status, p.name FROM project_memberships m
                 LEFT JOIN projects p ON p.code = m.project_code AND (p.user_id = ? OR p.user_id IS NULL)
                WHERE m.contract_no IN (${contractNos.map(() => '?').join(',')})
                  AND (m.user_id = ? OR m.user_id IS NULL)`;
  const rows = await query(ctx, sql, [uid, ...contractNos, uid]);
  const byCode = new Map<string, DocumentProjectRef>();
  for (const r of rows) {
    const code = String(r['project_code'] ?? '');
    if (!code) continue;
    const status = String(r['status'] ?? 'proposed');
    const name = r['name'] != null ? String(r['name']) : code;
    const prev = byCode.get(code);
    // 同项目多行(多合同归属)取状态最高者: confirmed > proposed。
    if (!prev || (prev.status !== 'confirmed' && status === 'confirmed')) {
      byCode.set(code, { code, name, status });
    }
  }
  return [...byCode.values()];
}

/** 项目 \ 合同 \ 单据类型 \ 单据名称(每段取第一个非空值)。 */
export function buildBreadcrumb(d: Omit<DocumentDetail, 'breadcrumb'>): string {
  const project = d.projects[0]?.name ?? '';
  const contract = d.contracts[0]?.contractNo ?? '';
  return [project, contract, d.docType, d.filename].filter((s) => s !== '').join(' \\ ');
}

/** Document 节点详情入口；单据不存在或不属该用户返回 null(路由转 404)。 */
export async function getDocumentDetail(
  ctx: DbContext, docId: string, userId?: string,
): Promise<DocumentDetail | null> {
  const uid = effectiveUserId(userId);
  const docSql = `SELECT id, doc_type, parse_status, review_status, batch_role,
                         minio_key, source_uri, created_at
                    FROM documents WHERE id = ? AND ${USER_SCOPE_LEGACY}`;
  const rows = await query(ctx, docSql, [docId, uid]);
  const doc = rows[0];
  if (!doc) return null;

  const minioKey = doc['minio_key'] != null ? String(doc['minio_key']) : null;
  // 文件名: MinIO key 还原上传原名(users/<uid>/[目录/]<uuid>-原名); 旧数据回退
  // source_uri basename(展平名带 uuid 前缀, 仍比 docId 可读)。
  const filename = documentFilename(minioKey, String(doc['source_uri'] ?? ''), uid, docId);

  const contracts = await loadContractRefs(ctx, docId, uid);
  const projects = await loadProjectRefs(
    ctx, contracts.map((c) => c.contractNo), uid);

  const base: Omit<DocumentDetail, 'breadcrumb'> = {
    docId,
    docType: String(doc['doc_type'] ?? ''),
    filename,
    parseStatus: String(doc['parse_status'] ?? ''),
    reviewStatus: String(doc['review_status'] ?? ''),
    batchRole: doc['batch_role'] != null ? String(doc['batch_role']) : null,
    minioKey,
    previewUrl: minioKey
      ? `/api/files/stream?key=${encodeURIComponent(minioKey)}`
      : null,
    createdAt: normalizeLegacyDt(doc['created_at']),
    contracts,
    projects,
  };
  return { ...base, breadcrumb: buildBreadcrumb(base) };
}

// ---------------------------------------------------------------------------
// 合同台账详情的血缘反查(2026-09-23 验收缺口): 台账只能看投影字段, 看不到
// 「这个合同挂了哪些单据」。listContractDocuments 以合同号为锚列出全部绑定
// 单据(bindings) + 合同原件(台账 document_id), 与 getDocumentDetail 正向互逆。
// ---------------------------------------------------------------------------

export interface ContractDocumentSummary {
  docId: string;
  docType: string;
  /** 人类可读文件名(MinIO key 还原, 回退 source_uri basename)。 */
  filename: string;
  /** 绑定关系词(凭证/货权转移/...); 合同原件行为 '合同原件'。 */
  relation: string;
  status: string;
  parseStatus: string;
  batchRole: string | null;
  previewUrl: string | null;
  ingestedAt: string | null;
}

/** 文件名解析与 getDocumentDetail 同口径(导出供测试断言一致性)。 */
export function documentFilename(
  minioKey: string | null, sourceUri: string, uid: string, docId: string,
): string {
  if (minioKey) {
    return parseFileKey(minioKey, uid)?.name ?? minioKey.split('/').pop() ?? minioKey;
  }
  return sourceUri.split(/[\\/]/).filter(Boolean).pop() ?? docId;
}

/** 合同行 -> 关联单据清单(bindings 并集 + 合同原件), 录入时间倒序。
 *  ledgerRowId 用于「合同原件」(台账行 document_id 指向的单据)。 */
export async function listContractDocuments(
  ctx: DbContext, args: { contractNo: string; ledgerRowId?: string }, userId?: string,
): Promise<ContractDocumentSummary[]> {
  const uid = effectiveUserId(userId);
  const sql = `SELECT d.id, d.doc_type, d.parse_status, d.batch_role, d.minio_key,
                      d.source_uri, d.created_at, b.relation, b.status AS bind_status
                 FROM bindings b JOIN documents d ON d.id = b.document_id
                WHERE b.contract_no = ? AND b.target_kind = 'Contract'
                  AND (b.user_id = ? OR b.user_id = '' OR b.user_id IS NULL)
                  AND (d.user_id = ? OR d.user_id = '' OR d.user_id IS NULL)
                UNION ALL
               SELECT d.id, d.doc_type, d.parse_status, d.batch_role, d.minio_key,
                      d.source_uri, d.created_at, '合同原件' AS relation,
                      'confirmed' AS bind_status
                 FROM documents d
                WHERE d.id = (SELECT document_id FROM contract_ledger
                               WHERE id = ? AND (user_id = ? OR user_id = '' OR user_id IS NULL))
                ORDER BY created_at DESC, id`;
  const params = args.ledgerRowId
    ? [args.contractNo, uid, uid, args.ledgerRowId, uid]
    : [args.contractNo, uid, uid, null, uid];
  const rows = await query(ctx, sql, params);

  // 同一单据可能既在 bindings 又是合同原件(抽取回写后再次绑定): 按 docId 去重,
  // '合同原件' 优先(语义最强)。
  const byDoc = new Map<string, ContractDocumentSummary>();
  for (const r of rows) {
    const docId = String(r['id'] ?? '');
    if (!docId) continue;
    const minioKey = r['minio_key'] != null ? String(r['minio_key']) : null;
    const relation = String(r['relation'] ?? '');
    const prev = byDoc.get(docId);
    if (prev && !(relation === '合同原件' && prev.relation !== '合同原件')) continue;
    byDoc.set(docId, {
      docId,
      docType: String(r['doc_type'] ?? ''),
      filename: documentFilename(minioKey, String(r['source_uri'] ?? ''), uid, docId),
      relation,
      status: String(r['bind_status'] ?? 'proposed'),
      parseStatus: String(r['parse_status'] ?? ''),
      batchRole: r['batch_role'] != null ? String(r['batch_role']) : null,
      previewUrl: minioKey ? `/api/files/stream?key=${encodeURIComponent(minioKey)}` : null,
      ingestedAt: normalizeLegacyDt(r['created_at']),
    });
  }
  return [...byDoc.values()];
}

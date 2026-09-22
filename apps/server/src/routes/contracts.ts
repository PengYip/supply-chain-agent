// 合同搜索 REST 面(spec 2026-08-26 §4.1)。挂在 /api/contracts(requireAuth,
// index.ts)。只读; 供图谱页/绑定页搜索组合框共用。
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../lib/auth-middleware.js';
import { getDbContext } from '../pipeline/db/dbBackend.js';
import type { DbContext } from '../pipeline/db/client.js';
import {
  findContractLedgerByNo,
  searchContractLedger,
  updateContractLedgerType,
  listBindingsForContract,
} from '../pipeline/db/repositories.js';
import { buildFlowPanel } from '../pipeline/flowPanel.js';
import {
  refreshExecutionFlowsForDocument,
  type RefreshSkipEntry,
} from '../pipeline/executionFlow.js';
import { materializeDocumentOntologySafe } from '../pipeline/ontologyMaterialize.js';
import { TRADE_VOCAB, type ContractType } from '../domain/tradeSemantics.js';

export const contractsRoute = new Hono<AuthEnv>();

contractsRoute.use('*', async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

const searchSchema = z.object({
  q: z.string().trim().min(1, 'q 必填'),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

function errDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** GET /:contractNo/flow-panel — 对账面板聚合(spec 2026-09-09 §15)。L1 只读:
 *  四泳道里程碑 + alerts + netPosition, 全部数字带证据 id, 绝不写库。 */
contractsRoute.get('/:contractNo/flow-panel', async (c) => {
  const user = c.get('user')!;
  const contractNo = c.req.param('contractNo').trim();
  if (contractNo === '') return c.json({ error: 'invalid contractNo' }, 400);
  try {
    const panel = await buildFlowPanel(getDbContext(), contractNo, user.id);
    if (!panel) return c.json({ error: 'contract not found' }, 404);
    return c.json(panel);
  } catch (e) {
    console.error('[contracts] flow-panel failed:', errDetail(e));
    return c.json({ error: 'flow-panel failed', detail: errDetail(e) }, 500);
  }
});

/** GET /search?q=&limit= — 台账模糊搜索(编号/买方/卖方/标题), 分组字段 matchedField。 */
contractsRoute.get('/search', async (c) => {
  const user = c.get('user')!;
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json(
      { error: 'invalid query params', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
      400,
    );
  }
  const { q, limit } = parsed.data;
  try {
    const items = await searchContractLedger(getDbContext(), q, user.id, limit);
    return c.json({ items });
  } catch (e) {
    console.error('[contracts] search failed:', errDetail(e));
    return c.json({ error: 'search failed', detail: errDetail(e) }, 500);
  }
});

const contractTypeChangeSchema = z.object({ contractType: z.string().min(1) });

/**
 * PATCH /:contractNo/type — 合同类型人工修正 + 绑定执行流水重建(wave7 Task 2)。
 *
 * 入库时合同类型可能未识别/误判(如 '购销合同' 无方向语义不映射), 工作台让用户
 * 直接改正: 落 contract_ledger.contract_type(更新域 = 请求者本人的
 * (contract_no, user_id) 行), 然后对请求者 confirmed 绑定的去重文档重建执行
 * 流水 —— 修正后的合同类型是六向方向二级判定的输入(采购: 货收/资付/票收)。
 * 修正值此后被 docType 修正的重派生守卫保护(已有值不动)。
 *
 * Request body (JSON): { contractType: string } — 必须 ∈ TRADE_VOCAB.contractTypes
 * ('采购'|'销售'|'物流'|'租赁'|'服务'|'其他'); '购销合同' 等歧义值拒绝。
 *
 * Responses:
 *   200 { ok, contractNo, contractType, refreshedDocuments, refreshedFlows, failed, skipped }
 *        —— refreshedDocuments = 重建流水的文档张数(语义准确名); refreshedFlows 为
 *           同名遗留别名(deprecated, 同值, 单位同样=文档张数, 供旧消费方兼容)。
 *   400 { ok: false, error: 'invalid_body' | 'invalid_contract_type' }
 *   401 { error: 'unauthorized' }            (requireAuth, applied in index.ts)
 *   404 { ok: false, error: 'contract_not_found' }
 *   500 { ok: false, error: <message> }
 */
contractsRoute.patch('/:contractNo/type', async (c) => {
  const user = c.get('user')!;
  const contractNo = c.req.param('contractNo').trim();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }
  const parsed = contractTypeChangeSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const contractType = parsed.data.contractType;
  // 受控值白名单(SSOT = TRADE_VOCAB.contractTypes): 拒绝 '购销合同' 等无方向
  // 语义的歧义值 —— 修正后的类型是流水方向二级判定的输入。
  if (!(TRADE_VOCAB.contractTypes as readonly string[]).includes(contractType)) {
    return c.json({ ok: false, error: 'invalid_contract_type' }, 400);
  }

  const ctx = getDbContext();
  try {
    const row = await findContractLedgerByNo(ctx, contractNo, user.id);
    if (!row) return c.json({ ok: false, error: 'contract_not_found' }, 404);
    // 更新域 = (contract_no, user_id): 请求者本人的行。用台账行的规范化键
    // (findContractLedgerByNo 已归一化全角/空白/大小写噪声)。
    const updated = await updateContractLedgerType(
      ctx, row.contractNo, contractType as ContractType, user.id,
    );
    if (!updated) return c.json({ ok: false, error: 'contract_not_found' }, 404);
    // 流水重建: 只作用于请求者 confirmed 绑定的去重文档(ownership 过滤在
    // listBindingsForContract 内 3-way OR)。refreshedFlows 实为"文档张数"(每文档 +1),
    // W8 T4 契约卫生: refreshedDocuments 为语义准确名, refreshedFlows 保留同值别名。
    const { refreshedDocuments, failed, skipped } = await rebuildFlowsForContract(ctx, row.contractNo, user.id);
    return c.json({
      ok: true,
      contractNo: row.contractNo,
      contractType,
      refreshedDocuments,
      // @deprecated 同名遗留别名: 单位=文档张数(与 refreshedDocuments 同值), 新消费方用 refreshedDocuments。
      refreshedFlows: refreshedDocuments,
      failed,
      skipped,
    });
  } catch (e) {
    console.error('[contracts] contract-type change failed:', errDetail(e));
    return c.json({ ok: false, error: errDetail(e) }, 500);
  }
});

/**
 * 修正后重建: 对合同名下请求者 confirmed 绑定的去重 documentId 逐文档
 * refreshExecutionFlowsForDocument(镜像 parties.backfillFlows 的循环捕获模式:
 * refreshedDocuments 按文档计数、failed 按文档捕获不中断其余、skipped 透传)。
 * 每成功文档 fire-and-forget 实体化本体(materializeDocumentOntologySafe 永不
 * 抛出, 不阻塞修正响应)。
 */
async function rebuildFlowsForContract(
  ctx: DbContext,
  contractNo: string,
  userId: string,
): Promise<{ refreshedDocuments: number; failed: number; skipped: RefreshSkipEntry[] }> {
  const bindings = await listBindingsForContract(ctx, contractNo, userId);
  const docIds = [...new Set(bindings.filter((b) => b.status === 'confirmed').map((b) => b.documentId))];
  let refreshedDocuments = 0;
  let failed = 0;
  const skipped: RefreshSkipEntry[] = [];
  for (const docId of docIds) {
    try {
      const res = await refreshExecutionFlowsForDocument(ctx, docId, userId);
      refreshedDocuments += 1;
      skipped.push(...res.skipped);
      void materializeDocumentOntologySafe(ctx, docId, userId);
    } catch (e) {
      console.error('[contracts] 合同流水重建失败(文档级捕获):', docId, errDetail(e));
      failed += 1;
    }
  }
  return { refreshedDocuments, failed, skipped };
}

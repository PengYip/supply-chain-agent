// 核销工作台 L2 工具（roadmap Item 5）：create_writeoff / create_offset。
// 一次调用 = 一张审批单 = 整单守恒校验后落 N 条带参边。
// numbers 铁律：items 逐字来自工作台提交（提交路由指令强制），execute 端
// validateAllocationPlan 是权威校验（余额/守恒以 DB 为准），失败整单拒绝零边产生。
// 批准后 execute 自动落 side_effect_results 审计（harness/agent.ts L2 gated wrapper，
// 审批中心 Task 7 已落地），本文件无需自理审计。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { withContainerLock } from '../lib/containerLock.js';
import { insertOntologyEdgesBatch, getTradeFactById, type OntologyEdgeInput } from './repo.js';
import { validateAllocationPlan, type AllocationItem, type AllocationViolation } from './writeoff.js';
import { syncOntologyGraphSafe } from './graphSync.js';

const itemSchema = z.object({
  srcId: z.string().min(1).describe('资金行 id（PaymentEvent/CollectionEvent 事实 id，工作台提交原样传递）'),
  dstId: z.string().min(1).describe('目标行 id（InvoiceEvent 或 SettlementEvent 事实 id，原样传递）'),
  amount: z.number().positive().describe('分配金额（正数；累计不超两端余额）'),
  partial: z.boolean().optional().describe('部分核销标记（金额小于资金行余额时为 true）'),
  batch: z.string().optional().describe('批次标识（分批核销时由工作台生成）'),
});

export function buildCreateWriteoffTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '票款核销：在收付资金与发票之间建立 WRITE_OFF 带参边（多对多/部分金额/分批）。' +
      '仅在工作台提交指令中调用，items 数组必须逐字传递指令中的 JSON，禁止修改/四舍五入/拆并任何数字。' +
      '服务端按 DB 余额做整单守恒校验，任一条超额则整单拒绝、零边产生。',
    inputSchema: z.object({
      items: z.array(itemSchema).min(1).max(50).describe('整单分配计划（srcId/dstId/amount 逐字来自工作台提交）'),
    }),
    execute: async ({ items }) => {
      return executeWriteoffEdges(deps, 'WRITE_OFF', 'create_writeoff', items);
    },
  });
}

export function buildCreateOffsetTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '预付冲抵：在付款/收款与结算之间建立 OFFSET_SETTLE 带参边。' +
      '仅在工作台提交指令中调用，items 必须逐字传递，冲抵额累计不超结算余额（服务端校验）。',
    inputSchema: z.object({
      items: z.array(itemSchema).min(1).max(50).describe('整单冲抵计划（逐字来自工作台提交）'),
    }),
    execute: async ({ items }) => {
      return executeWriteoffEdges(deps, 'OFFSET_SETTLE', 'create_offset', items);
    },
  });
}

async function executeWriteoffEdges(
  deps: { ctx: DbContext; userId?: string },
  relation: 'WRITE_OFF' | 'OFFSET_SETTLE',
  toolName: 'create_writeoff' | 'create_offset',
  items: AllocationItem[],
): Promise<
  | { status: 'ok'; relation: string; edges: Array<{ edgeId: string; srcId: string; dstId: string; amount: number }>; totalAmount: number }
  | { status: 'invalid'; violations: AllocationViolation[] }
> {
  // 校验与落边整体进程内串行(batch/review 路由同款 containerLock): 并发审批单
  // 若都基于同一份余额快照通过守恒校验再各自落边, 会超额核销(TOCTOU)。这些是
  // 短 DB 操作(<=50 条边), 全局单键串行开销可忽略; 单 pm2 实例部署下进程内锁已够。
  return withContainerLock('ontology-writeoff-execute', async () => {
    const violations = await validateAllocationPlan(deps.ctx, relation, items, deps.userId);
    if (violations.length > 0) return { status: 'invalid', violations };

    // 先取全部事实行并组装边输入, 任一消失即整单拒绝(此时尚未落任何边)。
    const now = new Date();
    const inputs: OntologyEdgeInput[] = [];
    for (const [itemIndex, item] of items.entries()) {
      // 事实行存在性已由 validateAllocationPlan 保证；这里取 entityType 供连接对写入。
      const src = await getTradeFactById(deps.ctx, item.srcId, deps.userId);
      const dst = await getTradeFactById(deps.ctx, item.dstId, deps.userId);
      if (!src || !dst) {
        return { status: 'invalid', violations: [{ itemIndex, code: 'unknown_fact', detail: '事实行在写入时消失' }] };
      }
      const params: Record<string, unknown> = { amount: item.amount };
      if (item.partial !== undefined) params['partial'] = item.partial;
      if (item.batch !== undefined) params['batch'] = item.batch;
      inputs.push({
        relation,
        fromType: src.entityType as never,
        fromId: item.srcId,
        toType: dst.entityType as never,
        toId: item.dstId,
        params,
        validAt: now,
        createdBy: toolName,
      });
    }
    // 整批单事务落边(repo.insertOntologyEdgesBatch): 中途失败整批回滚,
    // 践行"失败整单拒绝零边产生"的承诺。
    const edgeIds = await insertOntologyEdgesBatch(deps.ctx, inputs, deps.userId);
    // 落边成功后图投影 fire-and-forget(spec 2026-09-09): 永不阻塞审批主流程。
    void syncOntologyGraphSafe(deps.ctx, deps.userId);
    const edges = inputs.map((inp, i) => ({
      edgeId: edgeIds[i]!,
      srcId: inp.fromId,
      dstId: inp.toId,
      amount: items[i]!.amount,
    }));
    const totalAmount = edges.reduce((s, e) => s + e.amount, 0);
    return { status: 'ok', relation, edges, totalAmount };
  });
}
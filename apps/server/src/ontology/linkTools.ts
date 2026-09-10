// 本体关系登记 L2 工具（2026-09-09 P4，spec 本体图谱投影 §关系入口补全）：
// link_ontology。覆盖核销工作台之外的 9 种关系（ALLOCATE_TO 分摊 / REVERSE_ORIGIN
// 红冲溯源 / FEEDS_INTO / CORRESPONDS_TO / TRIGGERS / PROVIDE，及主体身份 spec
// 2026-09-09 增补的 PARENT_OF 母子公司 / DELIVERED_AS 实际交付 / 决策 #11 TRADING_WITH
// 交易对手）——这些关系此前只有 repo 写入边界、无对话入口。WRITE_OFF/OFFSET_SETTLE
// 刻意不在本工具词表内（整单守恒语义归核销工作台 create_writeoff/create_offset，
// 描述里显式引导）。
// 校验链：事实行存在 -> 连接对白名单(relationDef/isRelationPairAllowed) ->
// params 走注册表关系 strict schema -> insertOntologyEdge 唯一写入边界。
// 批准后 execute 自动落 side_effect_results 审计（harness L2 gated wrapper）。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { getTradeFactById, insertOntologyEdge } from './repo.js';
import { findContractRowById } from './projection.js';
import { relationDef, isRelationPairAllowed, AllocateMethod } from './index.js';
import { syncOntologyGraphSafe } from './graphSync.js';

export const LINKABLE_RELATIONS = [
  'ALLOCATE_TO', 'REVERSE_ORIGIN', 'FEEDS_INTO', 'CORRESPONDS_TO', 'TRIGGERS', 'PROVIDE',
  'PARENT_OF', 'DELIVERED_AS', 'TRADING_WITH',
] as const;

export function buildLinkOntologyTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '登记一条本体关系边（分摊/红冲溯源/结算依据/开票对应/触发付款/提供服务/母子公司/实际交付/交易对手）。' +
      '当用户口述一条明确的关系时调用，例如"把这笔服务费分摊 15000 元到合同 HT-CG-2601" ' +
      '-> relation=ALLOCATE_TO, fromId=<服务费事实id>, toId=<台账合同行id>, amount=15000, method=金额；' +
      '"这张红字发票冲的是 INV-001 那张蓝票" -> relation=REVERSE_ORIGIN, amount=<红冲金额>, reason=<原因>；' +
      '"A 公司是 B 公司的母公司, 持股 60%" -> relation=PARENT_OF, fromId=<母公司事实id>, ' +
      'toId=<子公司事实id>, ratio=0.6（主体更名后旧事实 id 仍有效, 台账按 uscc 归一）；' +
      '"这批收货实际到的是螺纹钢 HRB400E Φ12" -> relation=DELIVERED_AS, fromId=<收货事实id>, ' +
      'toId=<商品事实id>, batch=<到货批次>；' +
      '"这批收货是某矿业发来的" -> relation=TRADING_WITH, fromId=<收/发货事实id>, ' +
      'toId=<对手方事实id>, role=上游（发货事件则 role=下游, spec 决策 #11 事件对手显式化）。' +
      '边界：核销（票款匹配）用 create_writeoff、预付冲抵用 create_offset，本工具不受理；' +
      'fromId 必须是台账/穿透里的事实 id（TF- 开头）；toId 通常是事实 id，' +
      '仅 ALLOCATE_TO 的 toId 用台账合同行 id；' +
      '连接对必须满足本体注册表（如 PARENT_OF 只允许 交易对手->交易对手、' +
      'DELIVERED_AS 只允许 收/发货->商品），不符整单拒绝并返回原因；' +
      'REVERSE_ORIGIN 要求红冲方为逆向（负数）发票、原票为正向；' +
      '参数必须匹配关系定义（分摊必须 amount+method，红冲必须 amount，辅助关系无参），' +
      '多余参数会被注册表 strict 校验拒绝。' +
      '数字或日期不精确时先向用户确认，不要猜测。' +
      '返回 { status: "ok", edgeId, relation } 或 { status: "invalid", detail }。',
    inputSchema: z.object({
      relation: z.enum(LINKABLE_RELATIONS).describe('关系类型（9 类之一；核销/冲抵用 create_writeoff/create_offset）'),
      fromId: z.string().min(1).describe('起点实体 id（事实 id TF- 开头；台账列表/详情可复制）'),
      toId: z.string().min(1).describe('终点实体 id（事实 id；ALLOCATE_TO 用台账合同行 id）'),
      amount: z.number().optional().describe('关系金额（ALLOCATE_TO/REVERSE_ORIGIN 必填，如 15000）'),
      ratio: z.number().min(0).max(1).optional().describe('比例（ALLOCATE_TO 分摊比例 / PARENT_OF 持股比例，选填，如 0.5）'),
      method: AllocateMethod.optional().describe('分摊方式（仅 ALLOCATE_TO 必填：金额/数量/重量/定额）'),
      batch: z.string().optional().describe('批次标识（ALLOCATE_TO 族选填；DELIVERED_AS=到货批次，如 SIF 厂号批次）'),
      partial: z.boolean().optional().describe('部分核销标记（本工具词表内暂无核销关系，保留字段）'),
      reason: z.string().optional().describe('红冲原因（仅 REVERSE_ORIGIN 选填）'),
      note: z.string().optional().describe('备注（仅 PARENT_OF 选填，如 控股/全资）'),
      role: z.enum(['上游', '下游']).optional().describe('对手方位（仅 TRADING_WITH 必填：收货事件=上游，发货事件=下游）'),
    }),
    execute: async ({ relation, fromId, toId, amount, ratio, method, batch, partial, reason, note, role }) => {
      try {
        // 1. 起点：必须是事实行（6 种关系的 from 全是事实实体）。
        const from = await getTradeFactById(deps.ctx, fromId, deps.userId);
        if (!from) {
          return { status: 'invalid' as const, detail: `起点事实不存在或不可见: ${fromId}` };
        }
        // 2. 终点：事实优先；ALLOCATE_TO 允许台账合同行（TradeContract 投影源）。
        let toType: string;
        const toFact = await getTradeFactById(deps.ctx, toId, deps.userId);
        if (toFact) {
          toType = toFact.entityType;
        } else if (relation === 'ALLOCATE_TO') {
          const contract = await findContractRowById(deps.ctx, toId, deps.userId ?? '');
          if (!contract) {
            return { status: 'invalid' as const, detail: `终点合同不存在或不可见: ${toId}` };
          }
          toType = 'TradeContract';
        } else {
          return { status: 'invalid' as const, detail: `终点事实不存在或不可见: ${toId}` };
        }
        // 3. 连接对白名单（注册表 SSOT，逐字对应 docx §5）。
        if (!isRelationPairAllowed(relation, from.entityType, toType)) {
          const def = relationDef(relation);
          return {
            status: 'invalid' as const,
            detail:
              `关系 ${relation} 不允许 ${from.entityType} -> ${toType}` +
              `（允许: ${def.pairs.map((p) => `${p.from}->${p.to}`).join(', ')}）`,
          };
        }
        // 4. REVERSE_ORIGIN 语义校验：红冲方逆向(负数)、原票正向(正数)。
        if (relation === 'REVERSE_ORIGIN') {
          const fromBiz = from.payload['eventBizType'];
          const toBiz = toFact?.payload['eventBizType'];
          if (fromBiz !== '逆向' || toBiz !== '正向') {
            return {
              status: 'invalid' as const,
              detail: `REVERSE_ORIGIN 要求 from=逆向(负数)发票、to=正向(正数)发票；` +
                `实际 from.eventBizType=${String(fromBiz)}，to.eventBizType=${String(toBiz ?? '<合同/缺失>')}`,
            };
          }
        }
        // 5. params 按注册表关系 strict schema 校验（多余/缺失参数在此快速失败）。
        const params: Record<string, unknown> = {};
        if (amount !== undefined) params['amount'] = amount;
        if (ratio !== undefined) params['ratio'] = ratio;
        if (method !== undefined) params['method'] = method;
        if (batch !== undefined) params['batch'] = batch;
        if (partial !== undefined) params['partial'] = partial;
        if (reason !== undefined) params['reason'] = reason;
        if (note !== undefined) params['note'] = note;
        if (role !== undefined) params['role'] = role;
        const edgeId = await insertOntologyEdge(
          deps.ctx,
          {
            relation,
            fromType: from.entityType as never,
            fromId,
            toType: toType as never,
            toId,
            params,
            validAt: new Date(),
            createdBy: 'link_ontology',
          },
          deps.userId,
        );
        // 落边成功后图投影 fire-and-forget(spec 2026-09-09): 永不阻塞登记主流程。
        void syncOntologyGraphSafe(deps.ctx, deps.userId);
        return { status: 'ok' as const, edgeId, relation, fromType: from.entityType, toType };
      } catch (e) {
        return { status: 'invalid' as const, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

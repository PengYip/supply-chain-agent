// 商品主数据注册兜底(spec 2026-09-09 §11 Phase 2, 波次一): register_goods L2。
// "匹配优先、注册兜底、注册必过人工"——错误主数据会全链扩散, needsApproval 审批链
// 不能省; 描述强制先 match_goods 确认无匹配, 归一键重复仍允许落库(重名不同规格
// 合法)但 detail 软提示疑似重复。写入必经 insertTradeFact 唯一写入边界:
// 注册表 strict zod + attributes 受控袋(标量/键长<=40/条数<=32 superRefine)
// 对 Agent 预填同样生效, 不绕过。落账后图投影 fire-and-forget, 永不阻塞主流程。
// 批准后 execute 自动落 side_effect_results 审计(harness L2 gated wrapper)。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { insertTradeFact } from './repo.js';
import { syncOntologyGraphSafe } from './graphSync.js';
import { normalizeSpec } from './goodsSpec.js';
import { GOODS_MATCH_THRESHOLD, matchGoods } from './goodsMatch.js';

export function buildRegisterGoodsTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '注册新商品主数据到台账(L2 操作: 调用需附带人工授权, 注册处 needsApproval)。' +
      '什么时候用: match_goods 匹配后确认无高置信候选(suggestion="register")时, 把单据抽取的' +
      '品名/规格/商品码/品类属性注册为主数据, 例如"螺纹钢 HRB400E Φ12 系统里没有, 登记一下"。' +
      '边界: 调用前必须先 match_goods 确认无匹配, 避免重复建档(归一键与既有商品相同时本工具仍会' +
      '落库但返回疑似重复提示, 重名不同规格是合法场景); attributes 只收标量键值对(键<=40字, ' +
      '值 string/number, 最多 32 条, 超限整单拒绝); 品名/规格不确定时先向用户确认, 不要猜测。' +
      '返回 { status: "ok", id, entityType } 或 { status: "invalid", detail }。',
    inputSchema: z.object({
      name: z.string().min(1).describe('品名(品类族聚合键, 如 螺纹钢/冻牛肉/YJV电力电缆)'),
      commodityCode: z.string().min(1).optional().describe('商品码(v1 开放词汇; 缺省时以归一键合成占位码, 业务确认词汇后补正)'),
      spec: z.string().optional().describe('规格品位(如 HRB400E Φ12mm 9m定尺; SKU 粒度=品名+规格)'),
      unit: z.string().optional().describe('计量单位(如 吨/公斤)'),
      attributes: z.record(z.string().min(1).max(40), z.union([z.string(), z.number()]))
        .optional()
        .describe('品类异构属性受控袋(如 {"牌号":"HRB400E","直径":"12mm"}; 标量值, 键<=40字, 最多 32 条)'),
      validAt: z.string().min(1).describe('生效时间 ISO 日期(如 2026-09-10)'),
    }),
    execute: async ({ name, commodityCode, spec, unit, attributes, validAt }) => {
      try {
        // 软提示(不阻断): 品名+规格归一键与既有商品相同——重名不同规格合法,
        // 但大概率是重复建档, detail 提示模型向用户转述"建议先 match_goods"。
        const { candidates } = await matchGoods(deps.ctx, { name, spec }, deps.userId);
        const dup = candidates.find((c) => c.score >= GOODS_MATCH_THRESHOLD && c.evidence === '归一键精确');
        const id = await insertTradeFact(
          deps.ctx,
          {
            entityType: 'TradeGoods',
            payload: {
              name,
              // 缺商品码以归一键合成占位码(goodsSeed 同款 v1 开放词汇惯例,
              // 注册表 commodityCode min(1) 必填的兜底)。
              commodityCode: commodityCode
                ?? `${normalizeSpec(name)}${spec ? `-${normalizeSpec(spec)}` : ''}`,
              ...(spec ? { spec } : {}),
              ...(unit ? { unit } : {}),
              ...(attributes ? { attributes } : {}),
            },
            validAt,
            createdBy: 'register_goods',
          },
          deps.userId,
        );
        // 落账成功后图投影 fire-and-forget(spec 2026-09-09): 永不阻塞登记主流程。
        void syncOntologyGraphSafe(deps.ctx, deps.userId);
        return {
          status: 'ok' as const,
          id,
          entityType: 'TradeGoods' as const,
          ...(dup
            ? {
                detail:
                  `存在疑似重复: 品名+规格归一后与既有商品 ${dup.id}(${dup.name}` +
                  `${dup.spec ? ` ${dup.spec}` : ''})相同, 建议先 match_goods 核对; ` +
                  '本次注册已照常落库(重名不同规格合法, 如确属重复请以失效/更正流程处理)。',
              }
            : {}),
        };
      } catch (e) {
        return { status: 'invalid' as const, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

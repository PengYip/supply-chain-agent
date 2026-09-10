// 商品主数据匹配(spec 2026-09-09 §11 Phase 2, 波次一): "匹配优先、注册兜底"的
// 匹配半边。三通道从硬到软(向量召回属波次二, 本模块纯 SQL 检索 trade_facts,
// 不依赖 Neo4j/嵌入):
//   1) commodityCode 精确(1.0) 2) 归一键 normalizeSpec(name)+normalizeSpec(spec)
//   精确(0.95, 决策 #9) 3) 名称归一后双向包含(0.6)。
// 候选去重(同事实取最高分通道)、按分降序、上限 10; suggestion: 有 >=0.95 候选
// -> 'match'(直接挂接既有商品), 否则 'register'(引导走 register_goods 注册兜底)。
// 只读 L1: 失效事实不参与匹配(as-of 业务时间现行口径), 用户隔离与 repo 一致。
import { tool } from 'ai';
import { z } from 'zod';
import type { DbContext } from '../pipeline/db/client.js';
import { listTradeFactsAsOf } from './repo.js';
import { asOfBusinessTime } from './asof.js';
import { normalizeSpec } from './goodsSpec.js';

export interface GoodsCandidate {
  id: string;
  name: string;
  spec: string | null;
  commodityCode: string | null;
  score: number;
  /** 命中通道: 'commodityCode 精确' | '归一键精确' | '名称包含' */
  evidence: string;
}

export const GOODS_MATCH_SCORES = {
  commodityCode: 1.0,
  identityKey: 0.95,
  nameContains: 0.6,
} as const;

/** suggestion 的 match 判定阈值: 有 score>=0.95 的候选才算高置信命中。 */
export const GOODS_MATCH_THRESHOLD = 0.95;
/** 候选上限(防长尾品类刷屏, 与工具结果预算对齐)。 */
export const GOODS_MATCH_CAP = 10;

/** 归一键: 与 goodsSeed 幂等键同构(normalizeSpec(name)|normalizeSpec(spec))。 */
function identityKey(name: string, spec?: string | null): string {
  return `${normalizeSpec(name)}|${normalizeSpec(spec ?? '')}`;
}

export async function matchGoods(
  ctx: DbContext,
  q: { name: string; spec?: string; commodityCode?: string },
  userId?: string,
): Promise<{ candidates: GoodsCandidate[]; suggestion: 'match' | 'register' }> {
  const rows = await listTradeFactsAsOf(
    ctx, asOfBusinessTime(new Date().toISOString()), { entityType: 'TradeGoods' }, userId,
  );
  const qName = normalizeSpec(q.name);
  const qKey = identityKey(q.name, q.spec);
  const byId = new Map<string, GoodsCandidate>();
  const keep = (c: GoodsCandidate) => {
    const prev = byId.get(c.id);
    if (!prev || prev.score < c.score) byId.set(c.id, c);
  };
  for (const r of rows) {
    const name = typeof r.payload['name'] === 'string' ? r.payload['name'] : '';
    if (!name) continue;
    const spec = typeof r.payload['spec'] === 'string' ? r.payload['spec'] : null;
    const code = typeof r.payload['commodityCode'] === 'string' ? r.payload['commodityCode'] : null;
    if (q.commodityCode && code && code === q.commodityCode) {
      keep({ id: r.id, name, spec, commodityCode: code, score: GOODS_MATCH_SCORES.commodityCode, evidence: 'commodityCode 精确' });
      continue;
    }
    if (identityKey(name, spec) === qKey) {
      keep({ id: r.id, name, spec, commodityCode: code, score: GOODS_MATCH_SCORES.identityKey, evidence: '归一键精确' });
      continue;
    }
    // 名称包含(双向): 查询名 ⊂ 行名(如 "热轧" ⊂ "热轧卷板")或行名 ⊂ 查询名;
    // qName 归一后为空时跳过(空串被一切包含会产生全量噪音候选)。
    const rowName = normalizeSpec(name);
    if (qName !== '' && (rowName.includes(qName) || qName.includes(rowName))) {
      keep({ id: r.id, name, spec, commodityCode: code, score: GOODS_MATCH_SCORES.nameContains, evidence: '名称包含' });
    }
  }
  const candidates = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, GOODS_MATCH_CAP);
  return {
    candidates,
    suggestion: candidates.some((c) => c.score >= GOODS_MATCH_THRESHOLD) ? 'match' : 'register',
  };
}

export function buildMatchGoodsTool(deps: { ctx: DbContext; userId?: string }) {
  return tool({
    description:
      '商品主数据匹配(只读): 按品名/规格/商品码检索台账既有商品, 三通道从硬到软打分——' +
      '商品码精确(1.0)、品名+规格归一键精确(0.95, 全半角/乘号族/大小写异写同规)、名称包含(0.6)。' +
      '什么时候用: 单据或对话里出现一个商品描述、要确定它对应哪条主数据时; ' +
      'register_goods 之前必先调用本工具——有 score>=0.95 候选(suggestion="match")直接挂接既有商品, ' +
      '不要重复建档; 无候选(suggestion="register")才走注册兜底。' +
      '边界: 只读不写; 只对现行(未失效)商品事实匹配; 返回候选列表(带 id/名称/规格/商品码/分数/命中通道)与 suggestion。',
    inputSchema: z.object({
      name: z.string().min(1).describe('品名(品类族, 如 螺纹钢/热轧卷板/YJV电力电缆)'),
      spec: z.string().optional().describe('规格品位(如 HRB400E Φ12mm 9m定尺 / 3*120+1*70)'),
      commodityCode: z.string().optional().describe('商品码(已知时优先, 精确通道)'),
    }),
    execute: async ({ name, spec, commodityCode }) => {
      const { candidates, suggestion } = await matchGoods(
        deps.ctx, { name, spec, commodityCode }, deps.userId,
      );
      return {
        query: { name, spec: spec ?? null, commodityCode: commodityCode ?? null },
        candidates,
        suggestion,
        usage:
          suggestion === 'match'
            ? '存在高置信候选(分数>=0.95): 应挂接既有商品事实, 不要 register_goods 重复建档。'
            : '无高置信候选: 确认后走 register_goods 注册新商品(L2 需人工审批); 分数 0.6 的名称包含候选仅供人工参考。',
      };
    },
  });
}

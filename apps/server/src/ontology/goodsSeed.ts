// 冷启动种子核心逻辑（spec 主体身份 §12，2026-09-09）：两层薄种子——品类族层
// （高频品类 name 级条目）+ 高频 SKU 层（具体规格）。正式名单由业务确认提供，
// 本模块只承载机制：
//   - 写入必经 insertTradeFact 唯一写入边界（entityType=TradeGoods, createdBy='seed',
//     注册表 strict zod + attributes 受控袋 superRefine 全部生效，不绕过）
//   - 幂等键 = normalizeSpec(name) + '|' + normalizeSpec(spec ?? '')——异写同规
//     不增殖（登记照存原文，比对双方归一值）；错误种子走 supersede 换代纠错，不删行
//   - 归属共享域（user_id=''，全用户可见，沿 templateSeed managed 语义）
//   - 逐条容错：非法 payload 拒绝并报告，不中断整批（图投影同款故障隔离）
// CLI 包装见 scripts/seed-goods.ts（--dry-run 先行，沿 backfill:embeddings 惯例）。
import type { DbContext } from '../pipeline/db/client.js';
import { insertTradeFact, listTradeFactsAsOf } from './repo.js';
import { asOfSystemTime } from './asof.js';
import { normalizeSpec } from './goodsSpec.js';

export interface GoodsSeedItem {
  name: string;
  spec?: string;
  unit?: string;
  commodityCode?: string;
  attributes?: Record<string, string | number>;
}

export interface GoodsSeedOptions {
  ctx: DbContext;
  items: GoodsSeedItem[];
  /** 种子归属用户；缺省=共享域（user_id=''，全用户可见）。 */
  userId?: string;
  dryRun?: boolean;
}

export interface GoodsSeedResult {
  total: number;
  inserted: number;
  skipped: number;
  failed: Array<{ index: number; name: string; error: string }>;
  /** dry-run/实跑样例（人读，报告用，cap 5）。 */
  samples: Array<{ name: string; spec?: string }>;
}

/** 种子幂等键：品名+规格双方归一（normalizeSpec），异写同规同键。 */
export function seedIdempotencyKey(name: string, spec?: string): string {
  return `${normalizeSpec(name)}|${normalizeSpec(spec ?? '')}`;
}

export async function seedGoodsMasterData(opts: GoodsSeedOptions): Promise<GoodsSeedResult> {
  const { ctx, items, dryRun = false } = opts;
  // 既有商品全集（含失效行不影响：失效行仍是"见过的规格"，重复种子仍应跳过）。
  const existing = await listTradeFactsAsOf(
    ctx, asOfSystemTime(new Date().toISOString()), { entityType: 'TradeGoods' }, opts.userId ?? '',
  );
  const seen = new Set(existing.map((r) => seedIdempotencyKey(
    String(r.payload['name'] ?? ''), typeof r.payload['spec'] === 'string' ? r.payload['spec'] : undefined,
  )));

  const result: GoodsSeedResult = { total: items.length, inserted: 0, skipped: 0, failed: [], samples: [] };
  for (const [index, item] of items.entries()) {
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      result.failed.push({ index, name: String(item.name ?? ''), error: 'seed: 缺少 name（必填字符串）' });
      continue;
    }
    const key = seedIdempotencyKey(item.name, item.spec);
    if (seen.has(key)) {
      result.skipped += 1;
      continue;
    }
    if (dryRun) {
      result.inserted += 1; // dry-run: inserted = 将写入的行数
      if (result.samples.length < 5) {
        result.samples.push({ name: item.name, ...(item.spec ? { spec: item.spec } : {}) });
      }
      seen.add(key);
      continue;
    }
    try {
      await insertTradeFact(
        ctx,
        {
          entityType: 'TradeGoods',
          payload: {
            name: item.name,
            commodityCode: item.commodityCode ?? `${normalizeSpec(item.name)}${item.spec ? `-${normalizeSpec(item.spec)}` : ''}`,
            ...(item.spec ? { spec: item.spec } : {}),
            ...(item.unit ? { unit: item.unit } : {}),
            ...(item.attributes ? { attributes: item.attributes } : {}),
          },
          validAt: new Date(),
          createdBy: 'seed',
        },
        opts.userId ?? '',
      );
      result.inserted += 1;
      if (result.samples.length < 5) {
        result.samples.push({ name: item.name, ...(item.spec ? { spec: item.spec } : {}) });
      }
      seen.add(key);
    } catch (e) {
      result.failed.push({
        index,
        name: item.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

// 冷启动种子脚本（spec 主体身份 §12，2026-09-09）：品类族层 + 高频 SKU 层两层薄种子。
// 正式清单由业务确认后提供（goods-seed.example.json 仅为骨架）；本脚本只承载执行。
//
// RUN（项目根；先 dry-run 再实跑，沿 backfill:embeddings 惯例）：
//   export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH   # ubuntu-server 需 nvm PATH
//   npm run seed:goods --workspace apps/server -- --file apps/server/scripts/goods-seed.example.json --dry-run
//   npm run seed:goods --workspace apps/server -- --file apps/server/scripts/goods-seed.example.json
//
// 语义（机制在 src/ontology/goodsSeed.ts）：
//   - 逐条经 insertTradeFact 唯一写入边界（entityType=TradeGoods, createdBy='seed'，
//     注册表 strict zod + attributes 袋约束全生效），归属共享域全用户可见
//   - 幂等：normalizeSpec(name)+normalizeSpec(spec) 去重，重复执行不增殖
//   - 清单条目缺 commodityCode 时以归一键合成占位码（v1 开放词汇；业务确认后收敛）
//   - 纠错：错误种子走 supersede 换代失效（POST /api/ontology/master-data/change），不删行
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { seedGoodsMasterData, type GoodsSeedItem } from '../src/ontology/goodsSeed.js';

function parseArgs(argv: string[]): { file?: string; dryRun: boolean } {
  let file: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') { file = argv[i + 1]; i += 1; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--help' || a === '-h') {
      console.log('Usage: seed-goods --file <清单.json> [--dry-run]');
      process.exit(0);
    }
  }
  return { file, dryRun };
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('缺少 --file <清单.json>（骨架见 apps/server/scripts/goods-seed.example.json）');
    process.exit(1);
  }
  let items: GoodsSeedItem[];
  try {
    items = JSON.parse(readFileSync(file, 'utf-8')) as GoodsSeedItem[];
  } catch (e) {
    console.error(`清单读取/解析失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!Array.isArray(items)) {
    console.error('清单必须是 JSON 数组');
    process.exit(1);
  }

  console.log(`[seed:goods] 清单 ${file}: ${items.length} 条${dryRun ? '（dry-run，不写入）' : ''}`);
  const ctx = getDbContext();
  const res = await seedGoodsMasterData({ ctx, items, dryRun });
  console.log(`[seed:goods] total=${res.total} inserted=${res.inserted} skipped=${res.skipped} failed=${res.failed.length}`);
  if (res.samples.length > 0) {
    console.log('[seed:goods] 样例:');
    for (const s of res.samples) console.log(`  - ${s.name}${s.spec ? ` / ${s.spec}` : ''}`);
  }
  if (res.failed.length > 0) {
    console.error('[seed:goods] 失败明细（写入边界拒绝）:');
    for (const f of res.failed) console.error(`  #${f.index} ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

void main();

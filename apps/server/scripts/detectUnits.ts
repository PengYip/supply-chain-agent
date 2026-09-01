// 批量拆分器检测器实查工具(不落库): 对一个 PDF 跑 detectDocumentUnits,
// 打印逐页清点与逻辑单据清单, 供新样例验收与线上排查。
//
// RUN (on the server, project root):
//   export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
//   npx tsx apps/server/scripts/detectUnits.ts /path/to/file.pdf \
//     [--concurrency 4] [--max-pages 50]
//
// 需要 VLM_BASE_URL / VLM_API_KEY(与生产凭证管线同一配置)。

import { detectDocumentUnits } from '../src/pipeline/batchSplit.js';
import { env } from '../src/env.js';

function intFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number.parseInt(process.argv[i + 1]!, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const sourcePath = positional[0];
  if (!sourcePath) {
    console.error('用法: npx tsx apps/server/scripts/detectUnits.ts <pdf> [--concurrency N] [--max-pages N]');
    process.exit(2);
  }
  if (!env.VLM_BASE_URL || !env.VLM_API_KEY) {
    console.error('VLM_BASE_URL / VLM_API_KEY 未配置, 无法做版面清点');
    process.exit(2);
  }
  const result = await detectDocumentUnits(
    { sourcePath, maxPages: intFlag('--max-pages', env.BATCH_SPLIT_MAX_PAGES) },
    { concurrency: intFlag('--concurrency', env.BATCH_SPLIT_CONCURRENCY) },
  );
  console.log(JSON.stringify(result, null, 2));
  console.error(
    `[detectUnits] pages=${result.pages.length} units=${result.units.length} ` +
    `blank=${result.pages.filter((p) => p.blank).length}`,
  );
}

main().catch((e) => {
  console.error('[detectUnits] fatal:', e);
  process.exit(1);
});

// 历史执行流水回填脚本(一次性维护工具, spec 2026-08-27 §10)。
//
// 背景(dev 库实测): 发货单白名单(90fe685)晚于用户绑定确认落库 -> 历史 confirmed
// 绑定从未物化流水; 物化层扩围(运输三类型/进销项票)同理只对新确认生效。
// 本脚本对全部 status='confirmed' 的绑定, 按最新抽取重跑 refresh(先撤后物化, 幂等,
// 与复核修正同一条防漂移路径), 补齐历史流水。
//
// 用法(在部署目录, 读根目录 .env):
//   npx tsx apps/server/scripts/backfillFlows.ts [--dry-run] [--limit N] [--doc-id DOC-xxx ...]
//
// 护栏: 按 (userId, documentId) 分组后传真实 userId -- effectiveUserId(undefined)=''
// 只匹配 legacy 行, 直接物化会以 ('binding_id','') 落重复行(与 'u1' 行不同键)。
// 每组 try/catch 单条隔离; 结束打印统计与 skip 原因分布。

// 副作用导入: env.ts 负责加载根目录 .env 并 zod 校验(失败即抛, 快速失败)。
import '../src/env.js';
import { getDbContext } from '../src/pipeline/db/dbBackend.js';
import { listAllConfirmedBindings } from '../src/pipeline/db/repositories.js';
import { refreshExecutionFlowsForDocument } from '../src/pipeline/executionFlow.js';

interface CliOptions {
  dryRun: boolean;
  limit: number;
  docIds: string[];
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, limit: Number.POSITIVE_INFINITY, docIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit 需要正整数');
      opts.limit = n;
    } else if (a === '--doc-id') {
      const v = argv[++i];
      if (!v) throw new Error('--doc-id 需要 docId 值');
      opts.docIds.push(v);
    } else {
      throw new Error(`未知参数: ${a}(支持 --dry-run / --limit N / --doc-id X)`);
    }
  }
  return opts;
}

interface FlowDocGroup {
  documentId: string;
  userId: string | null;
  bindingCount: number;
  contractNos: string[];
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  console.log(`[backfill:flows] backend=${process.env.DB_BACKEND ?? 'sqlite(默认)'} dryRun=${cli.dryRun}`);

  const ctx = getDbContext();
  const bindings = await listAllConfirmedBindings(ctx);

  // (userId, documentId) 分组: refresh 需要文档归属用户的真实 userId(见文件头护栏)。
  const groups = new Map<string, FlowDocGroup>();
  for (const b of bindings) {
    const key = `${b.userId ?? ''}|${b.documentId}`;
    const g = groups.get(key) ?? {
      documentId: b.documentId,
      userId: b.userId,
      bindingCount: 0,
      contractNos: [],
    };
    g.bindingCount += 1;
    if (!g.contractNos.includes(b.contractNo)) g.contractNos.push(b.contractNo);
    groups.set(key, g);
  }

  let actionable = [...groups.values()];
  if (cli.docIds.length > 0) {
    const allow = new Set(cli.docIds);
    actionable = actionable.filter((g) => allow.has(g.documentId));
  }
  if (Number.isFinite(cli.limit)) actionable = actionable.slice(0, cli.limit);

  console.log(`[backfill:flows] confirmed 绑定=${bindings.length}, 文档组=${groups.size}, 待处理=${actionable.length}`);
  if (cli.dryRun) {
    console.log('[backfill:flows] DRY-RUN 清单:');
    for (const g of actionable) {
      console.log(`  ${g.documentId}  user=${g.userId ?? ''} bindings=${g.bindingCount} contracts=${g.contractNos.join(',')}`);
    }
    console.log(`[backfill:flows] 共 ${actionable.length} 组将被重建(--dry-run 未执行)。`);
    return;
  }

  let materialized = 0;
  let skipped = 0;
  let failed = 0;
  for (const g of actionable) {
    try {
      const res = await refreshExecutionFlowsForDocument(ctx, g.documentId, g.userId ?? undefined);
      materialized += res.materialized;
      skipped += res.skipped.length;
      const reasons = res.skipped.map((s) => s.reason).join(',') || '-';
      console.log(
        `[ok]   ${g.documentId} user=${g.userId ?? ''}: retracted=${res.retracted} materialized=${res.materialized} skipped=${res.skipped.length}(${reasons})`,
      );
    } catch (e) {
      failed += 1;
      console.error(`[fail] ${g.documentId} user=${g.userId ?? ''}: ${(e as Error).message}`);
    }
  }

  console.log('\n==== 统计 ====');
  console.log(`文档组: ${actionable.length}`);
  console.log(`materialized: ${materialized}`);
  console.log(`skipped: ${skipped}`);
  console.log(`failed: ${failed}`);
}

main().catch((e) => {
  console.error('[backfill:flows] 致命错误:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});

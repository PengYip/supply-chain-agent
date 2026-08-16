// apps/server/eval/agent/validate.ts
// One-shot dataset validator: exit 0 + {ok:true,scenarioCount} on stdout, or
// exit 1 + {ok:false,error}. Spawned by the dataset CRUD routes so src/
// never imports eval/** (same subprocess pattern as run orchestration).
import { loadDataset } from './datasets.js';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.log(JSON.stringify({ ok: false, error: '用法: tsx eval/agent/validate.ts <dataset.yaml>' }));
  process.exit(1);
}
try {
  const scenarios = loadDataset(resolve(process.cwd(), file));
  console.log(JSON.stringify({ ok: true, scenarioCount: scenarios.length }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
}

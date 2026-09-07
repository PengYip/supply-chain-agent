import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Vitest setup: pin the parse-backend env to hermetic values BEFORE any module
// (and thus env.ts's dotenv of the project-root .env) loads. dotenv does NOT
// override already-set process.env entries, so setting these here wins over a
// developer's real .env. Without this, a valid MINERU_API_KEY/QIANFAN_API_KEY
// in the local root .env turns "OCR fails fast" test paths into LIVE cloud
// calls (observed: batchSplitter 'container 解析失败' timing out against the
// real MinerU API). Mirrors CI, where no .env exists at all.
process.env.OPENAI_API_KEY ??= 'ci-dummy-key'; // env.ts requires it; tests never call the API
process.env.PARSE_BACKEND = 'mineru'; // local adapter: fails fast without the CLI binary
process.env.MINERU_API_KEY = ''; // '' is falsy -> adapters take the missing-key error path
process.env.QIANFAN_API_KEY = '';

// Per-file hermetic data roots: setup files run before test modules import, so
// these win over any defaults. Each test FILE gets a fresh temp dir -> its own
// agent.db / pipeline.db / ingest-root, removing the shared-file coupling that
// forced fileParallelism:false (2026-08-18 SQLITE_BUSY incidents). Temp dirs are
// intentionally not cleaned up (tiny; OS tmp policy owns them).
const perFileRoot = mkdtempSync(path.join(tmpdir(), 'sca-test-'));
process.env.SCA_DATA_DIR = perFileRoot;
process.env.SCA_PIPELINE_DB = path.join(perFileRoot, 'pipeline.db');
process.env.INGEST_ROOT = path.join(perFileRoot, 'ingest-root');

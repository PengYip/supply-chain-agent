// Vitest setup: pin the parse-backend env to hermetic values BEFORE any module
// (and thus env.ts's dotenv of the project-root .env) loads. dotenv does NOT
// override already-set process.env entries, so setting these here wins over a
// developer's real .env. Without this, a valid MINERU_API_KEY/QIANFAN_API_KEY
// in the local root .env turns "OCR fails fast" test paths into LIVE cloud
// calls (observed: batchSplitter 'container 解析失败' timing out against the
// real MinerU API). Mirrors CI, where no .env exists at all.
process.env.PARSE_BACKEND = 'mineru'; // local adapter: fails fast without the CLI binary
process.env.MINERU_API_KEY = ''; // '' is falsy -> adapters take the missing-key error path
process.env.QIANFAN_API_KEY = '';

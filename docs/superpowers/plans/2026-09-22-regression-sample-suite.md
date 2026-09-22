# Wave 9 — 回归测试样例集（ERP Ground Truth 冻结 + eval 接线守门）

计划时间: 2026-09-22 · 状态: 执行中
上位指令: 用户三段式第三阶段 "(c) 回归测试样例集制作——从语料选代表性文档，以 ERP 结构化数据为
Ground Truth 冻结 golden expectations，接入 eval 管线做变更守门"。
前置: (a) 采集+导入完成（`样本收集/华能湖北供煤项目/_采集报告.md` / `_导入报告.md`）；
(b) Wave 8 已合并部署（490efdd）。

## Objective

建一套**字段级抽取回归样例集**：代表性真实单据随仓走，ERP 真值冻结为 golden expectations，
任何抽取/物化变更导致关键字段漂移 → eval 红（退出码 1）。防御面 = Wave 8 全部修复语义
（fieldStr 解包 / kg 推断 / 发票号 / 轨道衡数量 / 守卫跳过语义）。

## 设计裁决（已定，实现不再议）

1. **走直连管线模式**（`eval/run.ts` 先例）：文件 → `ingestWithDigital/ingestWithMinerU`
   → `saveDocument` → `extractGroundedFields` → 字段级断言。不走 agent yaml 线
   （LLM-as-judge 是行为质量评估，噪声大不适合数字回归）。
2. **守门 = 退出码**：`eval/run.ts` 无失败退出码是已知缺口；新 runner 任何 MISS →
   `process.exitCode=1`。不进 CI（需真实 API key，与既有 evals 同为 dev 手动跑）。
3. **Hermetic fixtures（执行中修订）**：fixture = 从 dev 库冻结的已验证 **block_model**
   （每份 0.6-53KB，共约 290KB，旁挂 `<file>.blocks.json`）。runner 跳过 ingest/OCR 层直接
   `saveDocument(blockModel)`（eval/run.ts 同形）——比 MinerU fixture 更确定性（冻结厂商
   OCR 层，回归只守我方代码），且零 MinerU/网络依赖；抽取仍用真实 DeepSeek（本地 .env 已有
   凭证）。数字断言 = 归一化后精确匹配（复用 run.ts `eq()` 语义：剥 `,，\s`）；LLM 偶发漂移
   → 红 → 重跑确认（这是特性不是缺陷）。
4. **边界**：V1 只断言抽取字段级（含守卫跳过语义的负例），不断言物化/流水
   （物化回归已由 vitest fixture 覆盖）。
5. **选样锚点 = 12 份已验证链**（`_导入报告.md` 逐份清单——dev 全链实弹过，值有人工复核），
   补 kg 案例文档；解析失败 3 份（.doc/货物运动/9.17运单）不入正例集。

## Tasks

### T1 选样入库（fixer）
- 在语料目录定位 12 份清单文档 + 识别 kg 案例文件（抽取字段含 `重量(kg)` 的运输凭证/
  大票类，候选在 `发货批次/`、`收货批次/`；用导入报告+本地管线探测确认）。
- 拷贝（非移动）至 `apps/server/eval/regression/samples/`，文件名保持原文（UTF-8 安全）。
- 产出 `samples/manifest.json`：每份 {file, sourceDir, docType, whySelected, sizeBytes}。
- 体积守门：单份 >15MB 换同目录更小同类型替代（记入 manifest.rationale）。
- 验收: manifest 与磁盘文件一一对应；零解析失败样本混入。

### T2 真值冻结（orchestrator 亲做——产品判断不可外包）
- `eval/regression/ground-truth.json`：per-sample {file, docType, expectedFields{...},
  guards{...}, erpTruth{...}, provenance}。
- 真值来源三方对账：ERP manifests（`C:/Users/yepeng/AppData/Local/Temp/opencode/`
  manifest.json/manifest-buy.json）× 导入报告 dev 验证值 × 采集报告 ERP 元数据。
  分歧时 ERP 为准（用户指令明示），分歧记录在 provenance。
- 负例守卫入册：货转单 qty 无锚点 / 电厂收货数据 payType 无关键词（跳过即正确）。
- 验收: 13±1 份样本全有 expectedFields；金额/数量/合同号三类键硬覆盖；发票号在 dev 为
  修正补键（raw 抽取不产出），V1 以 erpTruth 记录覆盖（T5 评审 minor 采纳说明）。

### T3 Runner + fixtures（fixer）
- `eval/regression.ts` + package.json script `eval:regression`（tsx）。
- 流程: 读 ground-truth.json → 逐样本 ingest（PDF 有 MinerU fixture 则 hermetic，无则
  首跑生成并落盘旁挂）→ saveDocument → extractGroundedFields → 归一化比对 →
  报告表（OK/MISS + diff）→ 任何 MISS exitCode=1。`--sample=<id>` 单跑。
- fixture 生成路径探测（按成本序）：本地 MinerU CLI（若本机有）→ dev 隧道触发解析后
  取回 parse 产物 → 报告 orchestrator 裁决。生成一次即冻结提交。
- 验收: `npm run build && npm run lint && npm test` 绿（runner 是 eval/ 下新文件，
  tsc rootDir 不含 eval——注意 package.json script 与 oxlint 面即可）。

### T4 首跑绿 + 守门实弹（orchestrator 亲做）
- 对 dev DeepSeek 全量首跑，逐 MISS 定性（真回归 / 容差问题 / LLM 漂移），修 ground-truth
  或归一化器直到绿。
- 守门实弹：故意改坏一条 expectation → 跑 → 确认 exitCode=1 且 MISS 报告清晰 → 还原。
- 验收: 连续两次全绿 + 守门实弹通过；结果快照记入 spec。

### T5 评审 + 文档（councillor，复用 cou-1 域上下文）
- 评审范围: ground-truth 真值对账合理性 / runner 归一化与守门正确性 / 选样代表性。
- spec 回填（`2026-09-20-ontology-business-loop-design.md` Wave 9 节）+ AGENTS.md
  命令表加 `eval:regression` 行。

## Verification

- T3/T4 后: build → lint → test 全绿（顺序同 CI）。
- T4 首跑绿 ×2 + 破坏性实弹 exit 1。
- councillor 评审 PASS 后合并 main（本波含代码与二进制样本，正常触发 CI/CD）。

## Guardrails

- 零 src/ 变更（package.json script 行除外）；注册表 `ontology/index.ts` 零变更。
- 样本文件为真实业务单据（内部私有仓，随仓提交可接受——与 `eval/contracts/` 先例一致）。
- 真值分歧 ERP 优先；守卫跳过语义是"正确答案"不是缺陷（W2-C 不造假数据原则）。
- 零 emoji；提交信息沿仓库惯例。

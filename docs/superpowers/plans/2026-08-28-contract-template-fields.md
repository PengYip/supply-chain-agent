# 合同模板保底字段（抽取下限保证）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽取结果恒 ⊇ 合同模板保底字段集（可多不可少，原文缺失存空值），模型多抽字段保留。

**Architecture:** 方案 B（确定性补齐）：抽取后纯函数 `padTemplateFields` 对模型输出做保底字段并集；提示词同步列出保底字段；`missingRequired` 语义更新为"保底字段为空/缺失"；抽取层 `overallConfidence` 仅平均非空字段。字段清单 SSOT 在 `schemas/contract.ts`，模板种子引用之。下游（图谱派生/绑定锚点/台账）对空值已安全退化，只加回归测试不改代码。

**Tech Stack:** TypeScript / zod / AI SDK 6 (`generateObject`) / vitest / better-sqlite3（测试内存库）。

**Spec:** `docs/superpowers/specs/2026-08-28-contract-template-fields-design.md`

## Global Constraints

- 代码中禁止 emoji（repo 全局约定）。
- 每个任务完成即 commit；最终验证顺序 **build → lint → test**（CI 等价）。
- 锚点字段名不可改动：`合同号` `合同类型` `甲方` `乙方` `标的物` `数量` `单位` `金额` `签订日` `生效日` `交货期` `项目编号`。
- AI SDK 6：抽取用 `generateObject` + `providerOptions.openai.structuredOutputs:false`（现状保持，勿改 `inputSchema`/`parameters` 等无关面）。
- 台账层 `overallConfidence/needsReview` 语义不动（原始全字段平均；空值→低分→needsReview 是期望的完整性信号）。
- 合同号为空 → 不建台账行（现状结构行为，保持）。
- 不改前端；不动 Postgres schema（无表结构变更）。

---

### Task 1: 保底字段集 SSOT + 模板种子接线

**Files:**
- Modify: `apps/server/src/pipeline/schemas/contract.ts`
- Modify: `apps/server/src/pipeline/templateSeed.ts:11`
- Test: `apps/server/test/pipeline/templateSeed.test.ts`

**Interfaces:**
- Produces: `CONTRACT_TEMPLATE_FIELDS: readonly string[]`（39 字段）、`CONTRACT_FIELD_HINTS: Readonly<Record<string, string>>`、`REQUIRED_CONTRACT_FIELDS: readonly string[]`（= CONTRACT_TEMPLATE_FIELDS，兼容别名，类型从 `(keyof ContractFields)[]` 放宽）。Task 2 的 extraction 与本任务测试均消费。
- 现状事实：`ensureTemplateType` 是 managed-wins upsert（`repositories.ts:3659`，`WHERE managed_at IS NULL` 时覆写 props）→ 存量环境重启自动获得新字段集；被 `/api/templates` 管理过的行不受影响（预期行为）。

- [ ] **Step 1: 写失败测试**（`templateSeed.test.ts` 顶部补 import，`describe('template seed')` 内追加用例）

```ts
import { CONTRACT_TEMPLATE_FIELDS } from '../../src/pipeline/schemas/contract.js';
```

```ts
  it('合同模板 props 逐名覆盖保底字段集(SSOT), 锚点字段在列', async () => {
    await ensureTemplateSeed(ctx);
    const types = await listTemplateTypes(ctx);
    const hetong = types.find((t) => t.name === '合同')!;
    const req = hetong.props.requiredFields as string[];
    expect(req).toHaveLength(CONTRACT_TEMPLATE_FIELDS.length);
    for (const f of CONTRACT_TEMPLATE_FIELDS) expect(req).toContain(f);
    for (const anchor of ['合同号', '合同类型', '甲方', '乙方', '标的物', '数量', '单位', '金额', '签订日', '生效日', '交货期', '项目编号']) {
      expect(req).toContain(anchor);
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts`
Expected: FAIL（`CONTRACT_TEMPLATE_FIELDS` 无此导出 / props 仅 8 字段）。

- [ ] **Step 3: 最小实现**

`apps/server/src/pipeline/schemas/contract.ts`：删除旧 `REQUIRED_CONTRACT_FIELDS` 定义（31-33 行），替换为：

```ts
/** 合同保底字段集(spec 2026-08-28): 模板下限。抽取输出必须逐名包含(原文缺失存空值)。
 *  锚点字段(台账入口/类型派生/图谱实体/绑定评分按名硬匹配)不可改名。
 *  模板演化经 /api/templates; 本常量是种子与新环境基线的 SSOT。 */
export const CONTRACT_TEMPLATE_FIELDS: readonly string[] = [
  // 主体与元信息
  '合同号', '合同名称', '合同类型', '签订日', '生效日', '项目编号',
  // 当事人(子项拍平, 保 Party 按名派生)
  '甲方', '甲方地址', '甲方电话', '甲方联系人', '甲方联系方式',
  '乙方', '乙方地址', '乙方电话', '乙方联系人', '乙方联系方式',
  // 标的与价格
  '标的物', '质量标准', '数量', '单位', '价格', '金额', '币种',
  // 结算
  '调价条款', '结算规则', '支付方式', '开票信息',
  // 物流交付
  '发货地', '收货地', '运输方式', '交割方式', '交货期', '履约期限', '供货期限',
  // 风险与其他
  '违约责任', '货品争议解决', '争议解决', '通知与送达', '其他约定',
];

export const CONTRACT_FIELD_HINTS: Readonly<Record<string, string>> = {
  合同号: '合同编号/合同号',
  合同类型: '受控值: 采购/销售/物流/租赁/服务/其他',
  甲方: '买方/需方',
  乙方: '卖方/供方',
  标的物: '商品/品名',
  数量: '纯数值, 不含单位',
  价格: '含税单价',
  金额: '合同总金额/价税合计(元)',
  币种: 'CNY/USD/EUR, 原文无则 CNY',
  交货期: '合同交货期/交货日期',
  运输方式: '汽运/火运/船运/空运',
  交割方式: '场地交货/到厂交货/自提',
  违约责任: '违约金条款',
  签订日: 'YYYY-MM-DD',
};

/** 兼容别名(extraction 无模板行时的 docType=合同 兜底) = 保底字段集。 */
export const REQUIRED_CONTRACT_FIELDS: readonly string[] = CONTRACT_TEMPLATE_FIELDS;
```

`apps/server/src/pipeline/templateSeed.ts`：文件头补 import，第 11 行合同 props 改为引用 SSOT：

```ts
import { CONTRACT_FIELD_HINTS, CONTRACT_TEMPLATE_FIELDS } from './schemas/contract.js';
```

```ts
  { name: '合同', props: { requiredFields: [...CONTRACT_TEMPLATE_FIELDS], fieldHints: { ...CONTRACT_FIELD_HINTS } } },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/templateSeed.test.ts test/pipeline/extractionProps.test.ts`
Expected: PASS（`extractionProps.test.ts` 两个既有用例不锁字段数量，兼容）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/schemas/contract.ts apps/server/src/pipeline/templateSeed.ts apps/server/test/pipeline/templateSeed.test.ts
git commit -m "feat(pipeline): 合同保底字段集 SSOT(39 字段)接入模板种子"
```

---

### Task 2: 抽取层确定性补齐（提示词 + padTemplateFields + missingRequired/置信度语义）

**Files:**
- Modify: `apps/server/src/pipeline/extraction.ts`（动态提示词 210-214 行；结果组装 234-249 行）
- Test: `apps/server/test/pipeline/extractionProps.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `REQUIRED_CONTRACT_FIELDS: readonly string[]`。
- Produces: `padTemplateFields(fields: ExtractedField[], required: readonly string[]): { fields: ExtractedField[]; missingRequired: string[] }`、`isEmptyValue(v: string | number): boolean`（均导出）。`ExtractionResult.missingRequired` 语义 = 保底字段空/缺失。调用方（`documentEntry.ts`/`autoExtraction.ts`）不改——它们只透传 `requiredFields/fieldHints` 与消费 `ExtractionResult`。

- [ ] **Step 1: 写失败测试**（`extractionProps.test.ts` 补 import 与新 describe）

```ts
import { CONTRACT_TEMPLATE_FIELDS } from '../../src/pipeline/schemas/contract.js';
```

```ts
describe('保底字段下限保证 (spec 2026-08-28)', () => {
  it('模型漏抽的保底字段补空值占位, 多抽字段保留', async () => {
    const model = stubModel({ fields: {
      合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] },
      质量标准: { value: 'GB 19147', sourceSpans: [{ blockId: 'b0', start: 0, end: 5 }] },
    }, llmConsistency: 0.9 });
    const r = await extractGroundedFields({ model }, { blockModel: blockModel('合同') });
    const names = r.fields.map((f) => f.name);
    for (const f of CONTRACT_TEMPLATE_FIELDS) expect(names).toContain(f);
    expect(names).toContain('质量标准');
    const padded = r.fields.find((f) => f.name === '甲方')!;
    expect(padded.value).toBe('');
    expect(padded.sourceSpans).toEqual([]);
    expect(padded.strength).toBe('none');
  });

  it('全空抽取: missingRequired=全部保底字段, overallConfidence=0, needsReview=true', async () => {
    const model = stubModel({ fields: {}, llmConsistency: 0.5 });
    const r = await extractGroundedFields({ model }, { blockModel: blockModel('合同') });
    expect(r.fields).toHaveLength(CONTRACT_TEMPLATE_FIELDS.length);
    expect(r.missingRequired).toHaveLength(CONTRACT_TEMPLATE_FIELDS.length);
    expect(r.missingRequired).toContain('合同号');
    expect(r.overallConfidence).toBe(0);
    expect(r.needsReview).toBe(true);
  });

  it('空值字段不稀释 overallConfidence(仅非空字段平均)', async () => {
    const model = stubModel({ fields: {
      合同号: { value: 'HT-2024-001', sourceSpans: [{ blockId: 'b0', start: 3, end: 15 }] },
    }, llmConsistency: 1 });
    const r = await extractGroundedFields({ model }, { blockModel: blockModel('合同') });
    const nonEmpty = r.fields.filter((f) => String(f.value).trim() !== '');
    expect(nonEmpty).toHaveLength(1);
    expect(r.overallConfidence).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace apps/server -- test/pipeline/extractionProps.test.ts`
Expected: 新 describe 3 用例 FAIL（现状无补齐：fields 少于模板集/missingRequired 口径不同）。

- [ ] **Step 3: 最小实现**（`extraction.ts`）

(a) 在 `attachConfidence` 之后、`extractGroundedFields` 之前新增：

```ts
/** 空值判定: 空串/纯空白 = 原文缺失(保底语义下的"存空")。 */
export function isEmptyValue(v: string | number): boolean {
  return typeof v === 'string' && v.trim().length === 0;
}

/** 确定性保底(spec 2026-08-28): 输出 ⊇ required 恒成立。模型漏抽的保底字段补
 *  空值占位(strength none/confidence 0/needsReview), 模型多抽的字段原样保留。
 *  required 为空数组时原样返回(no-op)。 */
export function padTemplateFields(
  fields: ExtractedField[],
  required: readonly string[],
): { fields: ExtractedField[]; missingRequired: string[] } {
  const present = new Map(fields.map((f) => [f.name, f] as const));
  const padded: ExtractedField[] = [];
  const missingRequired: string[] = [];
  for (const name of required) {
    const hit = present.get(name);
    if (!hit) {
      padded.push({
        name, value: '', sourceSpans: [],
        strength: 'none', confidence: 0,
        needsReview: true, autoAccepted: false, citedText: null,
      });
      missingRequired.push(name);
    } else if (isEmptyValue(hit.value)) {
      missingRequired.push(name);
    }
  }
  return { fields: required.length ? [...fields, ...padded] : fields, missingRequired };
}
```

(b) `extractGroundedFields` 内动态提示词段（原 `必填字段:` 行）替换为：

```ts
    ...(required.length ? [`保底字段(必须逐个出现在输出中, 此规则优先于"原文不存在则不列"; 原文缺失时 value 置空字符串、sourceSpans 置空数组): ${required.join('、')}。真实缺失的保底字段列入 missingRequired。`] : []),
```

(c) 208 行兜底行简化（REQUIRED_CONTRACT_FIELDS 已是 `readonly string[]`）：

```ts
  const required = input.requiredFields ?? (input.docType === '合同' ? REQUIRED_CONTRACT_FIELDS : []);
```

(d) 结果组装段（原 234-249 行）替换为：

```ts
  const fields = attachConfidence(input.blockModel, grounded, object.llmConsistency);
  const padded = padTemplateFields(fields, required);
  const nonEmpty = padded.fields.filter((f) => !isEmptyValue(f.value));
  const overallConfidence = nonEmpty.length
    ? nonEmpty.reduce((s, f) => s + f.confidence, 0) / nonEmpty.length
    : 0;

  return {
    fields: padded.fields,
    overallConfidence: Math.round(overallConfidence * 1000) / 1000,
    needsReview: padded.fields.some((f) => f.needsReview) || padded.missingRequired.length > 0,
    missingRequired: padded.missingRequired,
    proposedRelationships: deriveProposedRelationships(padded.fields),
    llmRaw: object,
  };
```

（原 `const present = new Set(...)` / `missingRequired = required.filter(...)` 两行删除；`deriveProposedRelationships` 对空值字段自带跳过，传 padded.fields 保持单源。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace apps/server -- test/pipeline/extractionProps.test.ts test/pipeline/extraction.test.ts test/pipeline/extraction.relationships.test.ts test/pipeline/extraction.edges.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/pipeline/extraction.ts apps/server/test/pipeline/extractionProps.test.ts
git commit -m "feat(pipeline): 抽取层保底字段确定性补齐(可多不可少, 缺失存空值)"
```

---

### Task 3: 下游空值安全回归测试（只加测试，不改产品代码）

**Files:**
- Test: `apps/server/test/pipeline/contractLedger.test.ts`
- Test: `apps/server/test/pipeline/bindingProposal.test.ts`

**Interfaces:**
- Consumes: 既有导出 `buildLedgerEntryFromExtraction`、`generateBindingProposals`/`LedgerEntryLike`/`VoucherAnchors`。本任务锁定 spec 的"消费链路安全退化"结论；任何用例 FAIL 即为真实回归（已知安全路径：`strField` 跳过空串 bindingProposal.ts:170；`numField('')`→0→命中 `===0` 中性分支 :276/:292）。

- [ ] **Step 1: 加测试**

`contractLedger.test.ts` 的 `describe('buildLedgerEntryFromExtraction')` 内追加：

```ts
  it('空值保底字段: 合同号在 -> 台账行含空字段且 needsReview; 合同号空 -> 无台账行', () => {
    const entry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: {
        合同号: { value: 'HT-1', sourceSpans: [] },
        质量标准: { value: '', sourceSpans: [] },
      },
      fieldMeta: {
        合同号: { strength: 'exact', confidence: 0.95 },
        质量标准: { strength: 'none', confidence: 0 },
      },
    });
    expect(entry).not.toBeNull();
    expect(entry!.fields['质量标准']!.value).toBe('');
    expect(entry!.needsReview).toBe(true);

    const noEntry = buildLedgerEntryFromExtraction({
      documentId: 'DOC-1',
      docType: '合同',
      fields: { 质量标准: { value: '', sourceSpans: [] } },
      fieldMeta: { 质量标准: { strength: 'none', confidence: 0 } },
    });
    expect(noEntry).toBeNull();
  });
```

`bindingProposal.test.ts` 的 `describe('generateBindingProposals (路由)')` 内追加：

```ts
  it('台账锚点为空串(模板保底空值) -> 中性分 0.5 不误报', () => {
    const anchors: VoucherAnchors = { amount: 1000, quantityTon: 10, date: '2024-07-15' };
    const contract = ledger('HT-2024-001', { 金额: '', 数量: '', 交货日期: '' });
    const proposals = generateBindingProposals(anchors, [contract]);
    expect(proposals[0]!.evidence.amountScore).toBe(0.5);
    expect(proposals[0]!.evidence.qtyScore).toBe(0.5);
    expect(proposals[0]!.evidence.timeScore).toBe(0.5);
  });
```

- [ ] **Step 2: 跑测试（预期直接通过；FAIL 则按 systematic-debugging 查根因后最小修复）**

Run: `npm test --workspace apps/server -- test/pipeline/contractLedger.test.ts test/pipeline/bindingProposal.test.ts`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/pipeline/contractLedger.test.ts apps/server/test/pipeline/bindingProposal.test.ts
git commit -m "test(pipeline): 锁定空值保底字段的台账与绑定锚点中性退化"
```

---

### Task 4: 全量回归、旧断言修缮与合流

**Files:**
- Modify(按需): `apps/server/test/pipeline/ingestLedgerWriteback.test.ts`、`apps/server/test/pipeline/templatePropsE2E.test.ts`、`apps/server/test/routes/reviewType.test.ts` —— 这些文件可能编码了旧 8 字段语义（字段数、missingRequired 内容、台账 fields 键集）。修缮原则：断言改为对 `CONTRACT_TEMPLATE_FIELDS` 的相对表达（长度/包含），**不得**为凑数删除行为断言。
- Modify: 本计划与 spec 文档一并入库。

- [ ] **Step 1: 全量测试**

Run: `npm test --workspace apps/server`
Expected: 上述风险文件若有旧语义断言则 FAIL；其余全绿。

- [ ] **Step 2: 修缮失败断言**（相对表达化，示例形态）

```ts
// 旧: expect(fields).toHaveLength(8) / toEqual([...])
// 新:
import { CONTRACT_TEMPLATE_FIELDS } from '../../src/pipeline/schemas/contract.js';
expect(fields.length).toBeGreaterThanOrEqual(CONTRACT_TEMPLATE_FIELDS.length);
```

- [ ] **Step 3: 全量验证（CI 等价顺序）**

Run: `npm run build && npm run lint && npm test`
Expected: 三者全绿。

- [ ] **Step 4: 提交文档与修缮**

```bash
git add docs/superpowers/specs/2026-08-28-contract-template-fields-design.md docs/superpowers/plans/2026-08-28-contract-template-fields.md apps/server/test
git commit -m "docs(spec): 合同模板保底字段设计与计划; test: 旧字段语义断言修缮"
```

- [ ] **Step 5: 推分支并合回 main（repo 工作流约定）**

```bash
git fetch origin main && git merge origin/main
npm run build && npm run lint && npm test
git push origin HEAD:PengYip/业务逻辑优化 && git push origin HEAD:main
```

Expected: merge 无冲突（或解决后复验绿）；推送触发 CI/CD。

# 业务图谱模板 Phase 2 前端（绑定工作台双下拉改造）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换绑定工作台手动绑定表单的「ContractSearchBar 全库搜索 + RELATION_PRESETS 关系下拉」路径，改为模板驱动的**双下拉**：第一步选项目（或"未挂项目"），第二步选合同；relation 由 docType 自动派生只读展示，用户不面对词表下拉。交互成本铁律：**不超过 ERP 的"选项目 → 选合同"两次下拉**。

**Architecture:** 消费 P1+P2 后端已上线的 `GET /api/templates/context?documentId=xxx`（本分支 18 commits）。数据层在 `useBindings` 增加 `loadTemplateContext`（AbortController 竞态防护，照 `contractSearch.ts` 模式）；纯逻辑（relation 派生 / 项目选项合成 / 禁用原因 / 过滤）抽为纯函数放 `src/lib/`，按 `captionFit.test.ts` 先例做 vitest 纯函数测试（前端无组件测试设施，组件渲染不强制测试）；组件层新增 `TemplateBindingForm`，旧表单抽为 `LegacyManualForm` 仅作 context 加载失败时的降级模式保留。

**Tech Stack:** React 19 + TypeScript + Tailwind 3 + clsx + lucide-react；vitest（apps/web 已有 devDependency ^4.1.10，`npm test --workspace @sca/web`）。

**Spec:** `docs/superpowers/specs/2026-08-26-graph-template-design.md` §4.1（绑定工作台双下拉铁律）
**契约锚点（已核实）:**
- 后端 `apps/server/src/routes/templates.ts:17-79` — context 响应：`{documentId, docType, typeChain, bindsRelation, settlesVocab, allowedContractTypes, projects[{code,name,contracts[{contractNo,contractType,allowed}]}], unassignedContracts}`，挂载于 `/api/templates`（requireAuth）
- 后端 `apps/server/src/routes/bindings.ts:338-423` — POST /api/bindings `{documentId, contractNo, relation, note?, targetKind?}`；docType 的 `props.bindsTargetKind==='Project'` 时服务端自动按项目码建 Project（contractNo 实为项目码）；执行类单据有"已挂合同文件"硬门禁(409)
- 前端 `apps/web/src/components/bindings/CandidatePanel.tsx:324-449`（改造主战场）、`BindingsView.tsx:251-257/500-561`、`hooks/useBindings.ts:98-107/376-414/480-487`、`api/contractSearch.ts`（getJson+signal 模式样板）、`components/common/ContractSearchBar.tsx`（键盘模型与下拉视觉样板）

---

## 0. 交互设计规格（设计决策记录）

### 0.1 状态机

```
[未选文档] ──选文档──> [context加载中(骨架)] ──成功──> [双下拉就绪]
                              │                        │
                              └──失败──> [兼容模式(旧表单) + 通知条 + 重试]
                                                       │
   表单内部: 选项目(步骤1) → 载入该项目合同 → 选合同(步骤2, >10条时出过滤框)
            → relation 只读展示(needsChoice 时出方向澄清) → 创建绑定(二次确认弹窗)
```

- **选文档时**：`loadTemplateContext(docId)` 与现有 `loadCandidates(docId)` 并行触发；切文档 abort 上一份在途请求。
- **context 加载中**：表单区显示 3 行骨架（现有 `animate-pulse bg-surface` 样式），提交禁用。
- **context 失败**：**自动降级**到 LegacyManualForm（旧搜索+词表路径原样保留），顶部加一条可关闭的通知条："模板上下文加载失败，已切换到兼容模式 [重试]"。理由：手动绑定是自动候选失败时的恢复路径，一个辅助 API 挂掉就禁掉手动绑定会让工作台对该文档不可用；且旧路径的服务端 POST 仍有 templateGuard 硬校验兜底，安全性不降级。用户点"重试"成功则回到双下拉。
- **创建成功**：走现有 `handleManualCreate → doCreateManual → refreshAll` 链路不变（refreshAll 需追加 context 重载，见 Task 3）。

### 0.2 步骤一：项目下拉

- **原生 `<select>`**（非自制组件）。理由：项目数少（个位到两位数）、无过滤需求、键盘/读屏/移动端免费获得，与 ERP 心智完全一致；自制无收益。
- 选项顺序：`projects[]` 原序 + 末尾合成组 **`未挂项目`**（`unassignedContracts` 拼 `` key=`__unassigned__`）。空项目（contracts 为空）仍显示（与 ERP 一致，选了才知无合同）；`未挂项目` 组合同为 0 时隐藏该选项。
- 默认值：占位 `请选择项目`（context API 未提供项目排序/推荐信号，见开放问题 #2）。

### 0.3 步骤二：合同选择（listbox + 条件过滤）

- 自制轻量 listbox（**不复用 ContractSearchBar**，决策理由见 0.6），渲染该项目的 `contracts[]`：
  - `allowed=true` 且通过门禁 → 可选行（合同号 + 合同类型徽标）；
  - `allowed=false` → 禁用行（`opacity-50 cursor-not-allowed`，`title` 提示原因，键盘循环中可聚焦但 Enter 无效）；
  - 执行类单据（docType !== '合同'）且目标合同未挂合同文件 → 禁用行，`title`="未挂合同文件，执行类单据不可选"（沿用现有文案语义）。禁用原因由纯函数 `contractDisableReason` 统一给出（Task 2），前端合并计算——服务端 POST 有同规则 409 硬门禁兜底，客户端展示与服务端校验不一致时以服务端错误为准回显。
- **过滤框**：合同数 **> 10** 时显示一个简单文本过滤框（客户端子串匹配：`contractNo` 大小写不敏感 includes；无防抖无请求——数据已在内存）。≤ 10 条不显示，保持两步极简。
- **键盘模型**：对齐 ContractSearchBar 既有模式——ArrowUp/Down 循环高亮、Enter 选中、Escape 关闭、中文输入法组合期间（`isComposing`/keyCode 229）不拦截。
- **下拉方向**：表单位于中栏底部，下拉列表**向上展开**（`bottom-full mb-1`），避免溢出面板底边。宽度/层级/阴影对齐 ContractSearchBar 下拉（`z-30 max-h-72 w-[340px] overflow-auto rounded-md border border-line bg-white py-1 shadow-card`）。

### 0.4 relation 只读派生展示（不选词）

派生优先级（纯函数 `deriveRelation`，Task 2）：

| 情形 | 展示 | 交互 |
|---|---|---|
| `settlesVocab` 长度为 1（收货单/发货单/进项票/销项票等 v2 方向编码类型） | 只读 chip：`绑定关系：收货` | 无 |
| `settlesVocab` 长度 > 1（发票→收票/开票、货转单→收货/发货、付款凭证→收款/付款） | 方向澄清：小 pill 组 `收票 / 开票`，须选其一（默认不选） | **唯一允许的"第三步"**（spec §4.1 歧义澄清） |
| `settlesVocab` 为 null（合同/质检报告/立项书等无 settles 规则类型） | 只读 chip：`绑定关系：引用`（bindsRelation） | 无 |

- 提交时 `relation` = 派生词 / 澄清所选词，经现有 `onManualCreate({contractNo, relation, note})` 签名原样传出——**handleManualCreate 与二次确认弹窗零改动**。
- chip 视觉沿用现有徽标语言：`border border-primary/20 bg-primary/10 text-primary-500 rounded px-1.5 py-px text-[10px]`。
- **settlesVocab 为 null 的"不物化流水"提示：需要**，一行 11px muted 文案 `该类型单据绑定后不产生履约流水`，放在 relation chip 下方。理由：用户预期"绑完单据进执行台账"，不提示会产生"绑了为什么没流水"的困惑；一行成本换掉一类工单。

### 0.5 typeChain 展示（面包屑，不用 tooltip）

表单头部一行只读面包屑：`单据类型：收货单 ⊂ 运输凭证 ⊂ 履约凭证`（`text-[11px] text-ink-soft`，` ⊂ ` 分隔）。理由：链深最多 3 级、总长 ≤ 20 字，inline 可完整展示，tooltip 会藏住"为什么这些合同类型可选"的关键解释；同时它是双下拉合法性的可见依据（模板允许信息作为提示展示，不构成交互步骤——spec §4.1 原文）。

### 0.6 与 ContractSearchBar 的关系（决策）

- **步骤二内不复用 ContractSearchBar，改用简化客户端过滤**。理由：ContractSearchBar 是防抖 200ms 打 **全库** `/api/contracts/search` 的组合框——搜索域错（要的是"选定项目内"的子集，服务端搜索会把项目外合同也带回来，还得二次过滤）、选择模型错（选中即清空文本，无法承载"已选+禁用态"）、matchedField 分组对该场景无意义。项目内合同是有限集（几十条量级），客户端子串过滤零延迟零竞态。
- **顶部工具条的 ContractSearchBar 全局过滤路径保持不变**（BindingsView:628，按合同过滤文档列表），不受本次改造影响。
- 步骤二 listbox 的键盘处理与下拉视觉**抄** ContractSearchBar 的模式（代码级参照，不是组件复用）。

### 0.7 视觉与可达性对齐

- 标签 `text-[11px] font-medium text-ink-soft`；输入 `h-8 w-full rounded-md border border-line bg-white px-2.5 text-[12px] text-ink focus:border-primary focus:outline-none`（现有 `inputCls` 原样沿用）；步骤序号 `① 项目` `② 合同`（11px，与标签同行）。
- 展开动画 `animate-fade-in`；提交按钮沿用 `bg-primary hover:bg-primary-800 disabled:opacity-50` + Loader2 spin。
- 禁用合同行 `title` 属性承载原因（原生 tooltip，零新依赖）；过滤框/下拉加 `aria-label`。
- 无 emoji；改动词表文案全部中文。

### 0.8 立项书（binds→Project）前置分支

- 若 context 响应带 `bindsTargetKind: 'Project'`（**开放问题 #1 的 Task 0 落地后**）：跳过合同步骤，步骤二直接变**项目选择**（复用 projects 列表，选中项的 `code` 作为 `contractNo` 提交，relation='立项'）——单步完成，成本低于双下拉，符合铁律。
- **当前后端未暴露该字段时的降级**：前端临时常量 `PROJECT_TARGET_DOC_TYPES = ['立项书']`，命中即走 LegacyManualForm（避免用户在 context API 的通配陷阱里选了合同号、后端却按项目码建 Project 节点——已核实 `er-bind-lixiang` 目标通配，`allowedContractTypes` 会全量放行，真陷阱）。Task 0 合入后删除该常量。

---

## Global Constraints

- 完成顺序强制 **build → lint → test**（仓库根 `npm run build` / `npm run lint` / `npm test`）；前端纯函数测试用 `npm test --workspace @sca/web`（vitest，照 `apps/web/test/captionFit.test.ts` 先例——只测 `src/lib`、`src/api` 的纯函数，**不做组件渲染测试**，前端无组件测试设施）。
- 代码禁 emoji；不新增任何依赖（clsx/lucide-react/vitest 均已有）。
- **只改 `apps/web`**（Task 0 除外，若协调者批准则含 `apps/server/src/routes/templates.ts` 一处小改）；不动后端绑定语义——POST /api/bindings 契约与服务端门禁是权威，前端展示逻辑与服务端不一致时以服务端 409 错误回显为准。
- 旧手动表单（搜索+RELATION_PRESETS）**不删除**：抽为 `LegacyManualForm` 作为 context 失败/立项书未支持时的降级模式，行为冻结不再迭代。
- `handleManualCreate({contractNo, relation, note})` 签名与二次确认弹窗流程**零改动**（relation 由派生逻辑填充）。
- 竞态防护照 `contractSearch.ts` 既有模式：AbortController + 后发先至丢弃；消费方按 `templateContext.docId === selected.docId` 判有效性（同 `candidates` 模式）。

---

### Task 0（可选，需协调者裁决）: 后端 context API 微增强

**动机（勘察实证）:** 现版 context API 有两处会直接坑前端：
1. `bindsRelation` 用 `bindingRelationFor` 派生（templates.ts:41），映射表只有 4 类——立项书回退 `'凭证'`（正确词是 `'立项'`，种子 `er-bind-lixiang` vocab）；付款单/质检报告/结算单同理回退 `'凭证'`。
2. 未暴露 `bindsTargetKind`——立项书在 `allowedContractTypes` 全量放行（`er-bind-lixiang` 目标通配）的假象下，前端无法区分"选合同"与"选项目"，用户选了合同号会被 POST 按项目码建成 Project 节点。

**Files:**
- Modify: `apps/server/src/routes/templates.ts`（约 15 行）
- Test: `apps/server/test/pipeline/templatesContext.test.ts`（若仓库已有该路由测试文件则追加用例）

**改动:**
- [ ] `bindsRelation` 改为：先 `matchEdgeRule({edgeType:'binds', sourceChain, targetChain:['']})` 取规则词表首词，无规则再回退 `bindingRelationFor(docType)`（兜底规则 `er-bind-fallback` vocab=['凭证'] 保证 legacy 行为不变）。
- [ ] 响应追加 `bindsTargetKind: 'Contract' | 'Project'`（读 `dt-{docType}` 的 `props.bindsTargetKind`，缺省 `'Contract'`）。
- [ ] 测试：立项书 → `{bindsRelation:'立项', bindsTargetKind:'Project'}`；货转单 → bindsRelation='货权转移'（回归）；发票 → settlesVocab=['收票','开票']。

**若裁决拒绝:** 前端按 §0.8 降级（立项书走 LegacyManualForm，bindsRelation 词不达意类型照常显示后端给的词），功能不缺失但立项书新路径与派生词体验打折。

---

### Task 1: API client — `templateContext.ts`（TDD）

**Files:**
- Create: `apps/web/src/api/templateContext.ts`
- Test: `apps/web/test/templateContext.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TemplateContractRef { contractNo: string; contractType: string | null; allowed: boolean; }
export interface TemplateProjectBlock { code: string; name: string; contracts: TemplateContractRef[]; }
export interface TemplateContext {
  documentId: string;
  docType: string;
  /** 祖先链(自身在前): ['收货单','运输凭证','履约凭证']。 */
  typeChain: string[];
  bindsRelation: string;
  settlesVocab: string[] | null;
  allowedContractTypes: string[];
  projects: TemplateProjectBlock[];
  unassignedContracts: TemplateContractRef[];
  /** Task 0 合入后由后端提供; 缺省视为 'Contract'。 */
  bindsTargetKind?: 'Contract' | 'Project';
}
/** 防御性归一化(照 contractSearch.ts normalizeItem 模式): 字段缺失/类型错 -> 丢弃或默认。 */
export function normalizeTemplateContext(raw: Record<string, unknown>): TemplateContext | null;
/** GET /api/templates/context?documentId=xxx; signal 供竞态废弃; 信封兼容 + 中文错误。 */
export function fetchTemplateContext(documentId: string, signal?: AbortSignal): Promise<TemplateContext>;
```

- [ ] **Step 1: 写失败测试**（纯函数，测 `normalizeTemplateContext`；`fetchTemplateContext` 不测网络层，照 captionFit 先例只测纯逻辑）：

```ts
// apps/web/test/templateContext.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeTemplateContext } from '../src/api/templateContext';

const PAYLOAD = {
  documentId: 'DOC-1', docType: '收货单',
  typeChain: ['收货单', '运输凭证', '履约凭证'],
  bindsRelation: '凭证', settlesVocab: ['收货'],
  allowedContractTypes: ['物流', '采购', '销售', '其他'],
  projects: [{ code: 'PRJ-1', name: '焦煤采购', contracts: [
    { contractNo: 'HT-1', contractType: '物流', allowed: true },
    { contractNo: 'HT-2', contractType: '租赁', allowed: false },
  ]}],
  unassignedContracts: [{ contractNo: 'HT-9', contractType: null, allowed: true }],
};

describe('normalizeTemplateContext', () => {
  it('完整载荷原样归一化', () => {
    const c = normalizeTemplateContext(PAYLOAD)!;
    expect(c.docType).toBe('收货单');
    expect(c.settlesVocab).toEqual(['收货']);
    expect(c.projects[0]!.contracts[1]).toEqual({ contractNo: 'HT-2', contractType: '租赁', allowed: false });
    expect(c.bindsTargetKind).toBeUndefined();
  });
  it('settlesVocab null 保留为 null(区别于空数组)', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD, settlesVocab: null })!;
    expect(c.settlesVocab).toBeNull();
  });
  it('bindsTargetKind 透传 Project', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD, bindsTargetKind: 'Project' })!;
    expect(c.bindsTargetKind).toBe('Project');
  });
  it('缺 documentId / 非对象 -> null 丢弃', () => {
    expect(normalizeTemplateContext({})).toBeNull();
    expect(normalizeTemplateContext({ documentId: '' })).toBeNull();
  });
  it('contracts 非数组或元素缺 contractNo -> 过滤; allowed 非布尔 -> false', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD,
      projects: [{ code: 'P', name: 'n', contracts: [{ contractType: '物流' }, 'bad', { contractNo: 'HT-3', contractType: '物流' }] }] })!;
    expect(c.projects[0]!.contracts).toEqual([{ contractNo: 'HT-3', contractType: '物流', allowed: false }]);
  });
  it('typeChain 非字符串数组 -> 空数组兜底', () => {
    const c = normalizeTemplateContext({ ...PAYLOAD, typeChain: '收货单' })!;
    expect(c.typeChain).toEqual([]);
  });
});
```

- [ ] **Step 2:** `npm test --workspace @sca/web -- test/templateContext.test.ts` → FAIL（模块不存在）
- [ ] **Step 3:** 实现 `templateContext.ts`——`getJson` 带 signal 照 `contractSearch.ts:19-52` 抄（信封兼容 + assertOk 中文错误）；normalize 照测试驱动实现。
- [ ] **Step 4:** 同命令跑测试 → PASS；`npm run build` 过。
- [ ] **Step 5: Commit** `git add apps/web/src/api/templateContext.ts apps/web/test/templateContext.test.ts && git commit -m "feat(web): 模板上下文API client(防御性归一化+竞态signal)"`

---

### Task 2: 双下拉纯逻辑模型 — `bindingFormModel.ts`（TDD）

**Files:**
- Create: `apps/web/src/lib/bindingFormModel.ts`
- Test: `apps/web/test/bindingFormModel.test.ts`

**Interfaces:**
- Consumes: `TemplateContext`（Task 1）。
- Produces:

```ts
export const UNASSIGNED_KEY = '__unassigned__';
export const FILTER_THRESHOLD = 10;

export interface ProjectOption {
  key: string;            // 项目 code 或 UNASSIGNED_KEY
  label: string;          // 项目名 / '未挂项目'
  contracts: TemplateContractRef[];
  isUnassigned: boolean;
}
/** projects 原序 + 末尾合成'未挂项目'组; 未挂组合同为 0 时不含该组。 */
export function buildProjectOptions(ctx: TemplateContext): ProjectOption[];

export interface RelationDerivation {
  word: string;                            // 提交用词; needsChoice 时为空串
  vocab: string[];                         // 候选词集
  source: 'settles' | 'binds';
  needsChoice: boolean;                    // vocab.length > 1 时需用户澄清方向
}
/** settlesVocab 非空 -> source settles(单词直取/多词 needsChoice); 否则 bindsRelation。 */
export function deriveRelation(ctx: TemplateContext): RelationDerivation;

export interface DisableOptions { docType: string; isExecutionDoc: boolean; established: boolean; }
/** 模板规则不允许 / 执行类单据未挂合同文件 -> 中文原因; 可选返回 null。 */
export function contractDisableReason(c: TemplateContractRef, opts: DisableOptions): string | null;

/** 步骤二过滤: contractNo 大小写不敏感子串匹配(全角空格忽略, 简单 includes)。 */
export function filterContracts(list: TemplateContractRef[], query: string): TemplateContractRef[];
export function needsFilter(contracts: TemplateContractRef[]): boolean; // length > FILTER_THRESHOLD
```

- [ ] **Step 1: 写失败测试**（覆盖矩阵——用真实种子语义造数据）：

```ts
// apps/web/test/bindingFormModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildProjectOptions, contractDisableReason, deriveRelation, filterContracts, needsFilter, UNASSIGNED_KEY,
} from '../src/lib/bindingFormModel';
import type { TemplateContext } from '../src/api/templateContext';

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  documentId: 'DOC-1', docType: '收货单', typeChain: ['收货单', '运输凭证', '履约凭证'],
  bindsRelation: '凭证', settlesVocab: null, allowedContractTypes: ['物流'],
  projects: [], unassignedContracts: [], ...over,
});

describe('deriveRelation', () => {
  it('方向编码类型(收货单)单词直取', () => {
    expect(deriveRelation(ctx({ settlesVocab: ['收货'] }))).toMatchObject({ word: '收货', needsChoice: false, source: 'settles' });
  });
  it('发票多词表 -> needsChoice(收票/开票)', () => {
    const d = deriveRelation(ctx({ docType: '发票', settlesVocab: ['收票', '开票'] }));
    expect(d.needsChoice).toBe(true);
    expect(d.word).toBe('');
    expect(d.vocab).toEqual(['收票', '开票']);
  });
  it('settlesVocab null -> bindsRelation(合同->引用)', () => {
    expect(deriveRelation(ctx({ docType: '合同', bindsRelation: '引用', settlesVocab: null })))
      .toMatchObject({ word: '引用', source: 'binds', needsChoice: false });
  });
});

describe('buildProjectOptions', () => {
  it('未挂项目组拼在末尾', () => {
    const opt = buildProjectOptions(ctx({
      projects: [{ code: 'PRJ-1', name: '焦煤', contracts: [{ contractNo: 'HT-1', contractType: null, allowed: true }] }],
      unassignedContracts: [{ contractNo: 'HT-9', contractType: null, allowed: true }],
    }));
    expect(opt.map((o) => o.key)).toEqual(['PRJ-1', UNASSIGNED_KEY]);
    expect(opt[1]!.label).toBe('未挂项目');
    expect(opt[1]!.isUnassigned).toBe(true);
  });
  it('未挂组为空时不出现; 空项目保留', () => {
    const opt = buildProjectOptions(ctx({ projects: [{ code: 'P1', name: '空项目', contracts: [] }] }));
    expect(opt.map((o) => o.key)).toEqual(['P1']);
  });
});

describe('contractDisableReason', () => {
  const opts = { docType: '收货单', isExecutionDoc: true, established: true };
  it('模板不允许 -> 规则文案(含合同类型)', () => {
    const r = contractDisableReason({ contractNo: 'HT-2', contractType: '租赁', allowed: false }, opts);
    expect(r).toContain('租赁');
    expect(r).toContain('收货单');
  });
  it('执行类单据未挂合同文件 -> 门禁文案', () => {
    expect(contractDisableReason({ contractNo: 'HT-1', contractType: '物流', allowed: true }, { ...opts, established: false }))
      .toContain('未挂合同文件');
  });
  it('合同文件本身(docType=合同)不受挂靠门禁', () => {
    expect(contractDisableReason({ contractNo: 'HT-1', contractType: null, allowed: true },
      { docType: '合同', isExecutionDoc: false, established: false })).toBeNull();
  });
});

describe('filterContracts / needsFilter', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ contractNo: `HT-2024-${String(i).padStart(3, '0')}`, contractType: null, allowed: true }));
  it('>10 出过滤框; 大小写不敏感子串', () => {
    expect(needsFilter(list.slice(0, 10))).toBe(false);
    expect(needsFilter(list)).toBe(true);
    expect(filterContracts(list, 'ht-2024-00').toHaveLength(10);
    expect(filterContracts(list, '999')).toEqual([]);
    expect(filterContracts(list, '  ')).toHaveLength(12); // 纯空白视为不过滤
  });
});
```

- [ ] **Step 2:** `npm test --workspace @sca/web -- test/bindingFormModel.test.ts` → FAIL
- [ ] **Step 3:** 实现纯函数（无 React 依赖）。禁用文案定稿：
  - 模板规则：`模板规则：${docType} 不可挂「${contractType ?? '未知类型'}」合同`
  - 挂靠门禁：`未挂合同文件，执行类单据不可选`
- [ ] **Step 4:** 测试 PASS + `npm run build` 过。
- [ ] **Step 5: Commit** `git add apps/web/src/lib/bindingFormModel.ts apps/web/test/bindingFormModel.test.ts && git commit -m "feat(web): 双下拉纯逻辑模型(relation派生/项目合成/禁用原因/过滤)"`

---

### Task 3: 数据层 — `useBindings.loadTemplateContext`（竞态防护）

**Files:**
- Modify: `apps/web/src/hooks/useBindings.ts`
  - 模块级 `getJson` 加可选 `signal?: AbortSignal` 透传 fetch（照 `contractSearch.ts:21` 一行改动；现有调用点不受影响）
  - Hook 内新增 state + loader + `refreshAll` 接线

**Interfaces:**
- Consumes: `fetchTemplateContext`（Task 1）。
- Produces（hook 返回值新增）:

```ts
templateContext: TemplateContext | null;   // 仅最新文档的; 切档/清除文档时置 null
templateContextLoading: boolean;
templateContextError: { docId: string; message: string } | null;  // 带 docId, 消费方按当前文档判断
loadTemplateContext: (docId: string) => Promise<void>;
```

- [ ] **Step 1: loader 实现**（照 `contractSearch.ts:54-73` 竞态模式 + `loadCandidates` 的 docId 有效性模式）：

```ts
// useBindings.ts — hook 内
const templateContextAbortRef = useRef<AbortController | null>(null);  // 需补 import useRef

const loadTemplateContext = useCallback(async (docId: string) => {
  templateContextAbortRef.current?.abort();
  const ac = new AbortController();
  templateContextAbortRef.current = ac;
  setTemplateContextLoading(true);
  setTemplateContextError(null);
  try {
    const data = await fetchTemplateContext(docId, ac.signal);
    if (ac.signal.aborted) return;              // 后发先至丢弃
    setTemplateContext({ ...data, documentId: data.documentId || docId });
  } catch (e) {
    if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
    setTemplateContext(null);
    setTemplateContextError({ docId, message: e instanceof Error ? e.message : '模板上下文加载失败' });
  } finally {
    if (!ac.signal.aborted) setTemplateContextLoading(false);
  }
}, []);
```

- [ ] **Step 2: refreshAll 接线**（:480-487 追加一行，绑定成功后 context 里合同的 established 态可能变化）：

```ts
const refreshAll = useCallback((docId: string | null) => {
  void refreshOverview();
  void refreshProposals();
  if (docId) { void loadCandidates(docId); void loadTemplateContext(docId); }
}, [refreshOverview, refreshProposals, loadCandidates, loadTemplateContext]);
```

- [ ] **Step 3:** 组件卸载时 abort（新增 cleanup effect）；`npm run build` + 全量 `npm test --workspace @sca/web` + 根 `npm test` 过（hooks 无测试设施，逻辑薄且模式照既有先例，正确性由 Task 1/2 纯函数 + Task 6 手工 QA 覆盖）。
- [ ] **Step 4: Commit** `git add apps/web/src/hooks/useBindings.ts && git commit -m "feat(web): useBindings加载模板上下文(abort竞态+refreshAll对账)"`

---

### Task 4: 组件 — `TemplateBindingForm` + CandidatePanel 集成

**Files:**
- Create: `apps/web/src/components/bindings/TemplateBindingForm.tsx`（双下拉表单本体）
- Create: `apps/web/src/components/bindings/LegacyManualForm.tsx`（现有 :334-447 表单**原样搬移**，行为冻结）
- Modify: `apps/web/src/components/bindings/CandidatePanel.tsx`（手动区改为按模式渲染两个表单之一）

**Interfaces:**
- Consumes: `bindingFormModel`（Task 2）、`TemplateContext`（Task 1）、`establishedContracts`/`onManualCreate`（现有 props 原样）。
- `TemplateBindingForm` props：

```ts
interface TemplateBindingFormProps {
  doc: OverviewDoc;
  context: TemplateContext;                    // 已就绪的 context(加载/降级由父级处理)
  establishedContracts: Set<string>;
  pending: boolean;                            // pending.has('manual')
  onSubmit: (p: { contractNo: string; relation: string; note?: string }) => Promise<boolean>;
  onCancel: () => void;
}
```

- [ ] **Step 1: LegacyManualForm 抽取** — CandidatePanel :334-447 的表单 JSX + `RELATION_PRESETS` + 相关 state 原样搬入新文件，props 化（contracts/establishedContracts/onManualCreate/pending/onCancel）。CandidatePanel 手动区先渲染它，`npm run build` + 手工冒烟确认行为零变化。
- [ ] **Step 2: TemplateBindingForm 骨架** — 布局（沿用 §0.7 class 词汇）：

```
单据类型：收货单 ⊂ 运输凭证 ⊂ 履约凭证          ← typeChain 面包屑(§0.5)
① 项目   [原生 select: 请选择项目 / ... / 未挂项目]
② 合同   [过滤框(>10)] + [listbox 向上展开: 合同号+类型徽标, 禁用行 title 原因]
         已选 HT-2024-001 [清除]
绑定关系 (收货)                                ← 只读 chip / needsChoice 时 pill 组
         该类型单据绑定后不产生履约流水          ← 仅 settlesVocab===null 时
备注     [____] (选填)
                     [取消] [创建绑定]
```

  - 提交校验（中文 formError，沿用现有 `text-[12px] text-danger`）：未选项目→`请选择项目`；未选合同→`请选择合同`；needsChoice 未选→`请选择${vocab[0] === '收票' ? '票据方向' : '收付方向'}`（简化为 `请选择绑定方向`）。
  - 立项书分支（§0.8）：`context.bindsTargetKind === 'Project'` → 步骤二渲染项目单选列表（`projects[].code/name`，contractNo 提交 code）；当前后端无该字段时由父级按 `PROJECT_TARGET_DOC_TYPES` 常量走 LegacyManualForm。
  - 键盘模型照 ContractSearchBar.tsx:114-133 抄（ArrowUp/Down 循环、Enter 选中、Escape 关、isComposing 守卫）；禁用行进入循环但 Enter 拦截。
  - listbox 展开/收起：选合同后收起；点外部关闭（照 ContractSearchBar.tsx:80-86 的 mousedown 监听模式）。
- [ ] **Step 3: CandidatePanel 集成** — props 追加 `templateContext`/`templateLoading`/`templateError`/`onRetryTemplate`；手动区渲染规则：

```
templateError(当前文档) 或 docType 命中 PROJECT_TARGET_DOC_TYPES -> LegacyManualForm + 通知条(§0.1)
templateLoading                                              -> 3 行骨架
templateContext 就绪                                          -> TemplateBindingForm
contracts 台账为空(现有分支)                                   -> 原空态提示不变
```

- [ ] **Step 4:** `npm run build` + `npm run lint` 过；手工冒烟（选文档→表单出骨架→双下拉就绪）。
- [ ] **Step 5: Commit** `git add apps/web/src/components/bindings/ && git commit -m "feat(web): 手动绑定双下拉表单(模板驱动+legacy降级保留)"`

---

### Task 5: 容器接线 — `BindingsView`

**Files:**
- Modify: `apps/web/src/components/bindings/BindingsView.tsx`

**改动点:**
- [ ] `handleSelectDoc`（:251-257）追加 `void b.loadTemplateContext(doc.docId)`（与 loadCandidates 并行）。
- [ ] `handleClearDoc`（:293-298）无需显式清理——`templateContext.docId !== selectedDocId(null)` 时 CandidatePanel 渲染空态；保持现有 selected 置 null 语义。
- [ ] 向 CandidatePanel 透传 `templateContext={b.templateContext}` `templateLoading={b.templateContextLoading}` `templateError={b.templateContextError}` `onRetryTemplate={() => selectedDocId && void b.loadTemplateContext(selectedDocId)}`。
- [ ] 通知条文案：`模板上下文加载失败，已切换到兼容模式` + `重试` 链接（重试成功自动回双下拉——error 置 null 即切换）。
- [ ] 确认 `handleManualCreate`（:500-517）与二次确认弹窗**零改动**（relation 已由表单派生填入；弹窗文案 `（关系：收货）` 自然正确）。
- [ ] `npm run build` + `npm run lint` 过。

- [ ] **Commit** `git add apps/web/src/components/bindings/BindingsView.tsx && git commit -m "feat(web): 绑定工作台接线模板上下文(选档加载+失败降级)"`

---

### Task 6: 全量验证 + 手工 QA 清单

- [ ] 根目录完整门禁：`npm run build && npm run lint && npm test && npm test --workspace @sca/web` 全绿。
- [ ] 手工 QA（dev 双端 `npm run dev:all`，用真实分类文档）：

| # | 场景 | 预期 |
|---|---|---|
| 1 | 选收货单文档 | 面包屑`收货单 ⊂ 运输凭证 ⊂ 履约凭证`；relation chip 只读`收货`；无流水提示不出现 |
| 2 | 步骤一选项目 | 步骤二列出该项目合同；未挂项目组在末尾 |
| 3 | allowed=false 合同 | 禁用态 + title 显示模板规则原因；键盘 Enter 拦截 |
| 4 | 执行类单据 + 未挂合同文件合同 | 禁用 + title `未挂合同文件...`；POST 兜底 409 时 toast 回显 |
| 5 | 项目内合同 >10 | 过滤框出现，子串过滤生效；≤10 无过滤框 |
| 6 | 发票文档 | relation 呈现 收票/开票 澄清 pill，未选不能提交 |
| 7 | 合同文档 | relation=`引用`；全部合同不受挂靠门禁 |
| 8 | 快速连续切换文档 A→B | A 的 context 被废弃，表单始终渲染 B 的数据（无闪旧） |
| 9 | 停掉后端选文档 | 自动降级 LegacyManualForm + 通知条；重启后端点重试回双下拉 |
| 10 | 创建绑定全流程 | 二次确认弹窗显示派生 relation；成功后 toast、候选/总览/context 对账刷新 |
| 11 | 顶部工具条 ContractSearchBar | 行为不变（全局按合同过滤文档列表） |
| 12 | 立项书文档（Task 0 未合入时） | 走 LegacyManualForm；Task 0 合入后单步选项目即完成 |

- [ ] Commit（如有修补）+ push。

---

## 裁决记录（协调者 2026-08-27，执行时不再重议）

1. **Task 0 采纳**：context API 暴露 `bindsTargetKind` + `bindsRelation` 改从匹配 binds 规则词表派生（立项书通配陷阱已实证，~15 行后端小改值得）。Task 0 为正式任务，先于前端任务执行。
2. **项目下拉默认项**：占位「请选择项目」。锚点评分排序（对手方项目优先）登记 Phase 3。
3. **多词表方向澄清**：采纳 spec §4.1 歧义澄清交互（§0.4 pill 组）。按 selfParty 推断方向留 Phase 3。
4. **错误降级**：采纳自动切 LegacyManualForm + 通知条 + 重试。旧表单作为降级模式长期保留（冻结不迭代）。
5. **established 门禁**：前端本地合并计算 + 服务端 409 兜底（不在 context API 加字段，避免后端再改）。

---

## 涉及文件总览

| 文件 | 动作 |
|---|---|
| `apps/web/src/api/templateContext.ts` | 新增：context API client |
| `apps/web/src/lib/bindingFormModel.ts` | 新增：双下拉纯逻辑 |
| `apps/web/src/components/bindings/TemplateBindingForm.tsx` | 新增：双下拉表单 |
| `apps/web/src/components/bindings/LegacyManualForm.tsx` | 新增：旧表单搬移（降级模式） |
| `apps/web/src/components/bindings/CandidatePanel.tsx` | 修改：手动区按模式渲染 |
| `apps/web/src/components/bindings/BindingsView.tsx` | 修改：加载接线 + 透传 |
| `apps/web/src/hooks/useBindings.ts` | 修改：loadTemplateContext + refreshAll |
| `apps/web/test/templateContext.test.ts` / `bindingFormModel.test.ts` | 新增：纯函数测试 |
| `apps/server/src/routes/templates.ts`（Task 0，可选） | 修改：bindsTargetKind + bindsRelation 规则派生 |

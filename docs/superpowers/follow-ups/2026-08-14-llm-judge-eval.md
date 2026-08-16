# 后续跟进项 — LLM-as-judge 评估系统 (2026-08-14)

来源: eval 分支 (12 commits, 979bcb4..d9b0c40) 最终全量评审。评审结论 READY TO PUSH, 无 Critical; 以下为 (b) 级跟进项, 按价值排序。原始 triage 全文见 `.superpowers/sdd/progress.md` (gitignored)。

## 1. CI 增加 eval/** 的 noEmit 类型检查 (最高价值)

`apps/server/tsconfig.json` include 仅覆盖 `src/**`, 因此 `eval/agent/**` (含零自动化验证的 `run.ts` CLI) 从未被 `npm run build` 类型检查, Tasks 1-9 均如此。建议新增 `tsconfig.eval.json` (noEmit, include `eval/**`) 并加入 CI。在任何人再次编辑 eval 代码前应先落地此项。

## 2. 报告矩阵 Tier 列补全

`apps/server/eval/agent/reporter.ts:95` 的 `writeResults` 调用 `buildReport([], ...)` 未传场景元数据, 导致 Tier 列恒为 `-` (Task 10 冒烟已观察)。约 2 行改动 + 测试。

## 3. deny / L2-resume 路径集成覆盖 (唯一 Important, I-1)

`apps/server/eval/agent/driver.ts:254-277` (审批拒绝收尾) 与 `:306-316` (l2ResumeQueue) 无任何集成测试/场景/冒烟覆盖; `core.yaml` 所有 `approvalPolicy.rules` 为 `[]` 或缺省, 故 L2 条件规则路径在生产 eval 可达但从未被穿越。两个 driver 测试仅覆盖 approve/L3 与 sim-error。Spec 验收标准 #3 (审批拒绝场景收尾被评分) 未冒烟。建议: 1 个 fake-model deny 测试 + 1 个带 L2 rules 的场景 + `t3-payment-rejected` 在线冒烟。当前机制为 plan 原文且 approver 逻辑有单测, 结果未被污染。

## 4. escalate 续跑指令与生产文案对齐

`driver.ts:107-110` 相对 `apps/server/src/routes/approvalCallback.ts:172` 截断了尾部指令「如果人工反馈解决了不确定性，请直接回答用户；如果需要执行后续操作，请继续。」影响 `t3-escalate-missing-invoice` 剧集的 continue-vs-answer 行为。追加缺失子句即可。

## 5. 评估卫生小包

1. `loadDataset` 空 `scenarios[]` 静默 no-op → 加 `.min(1)` 守卫
2. approver 全角逗号分支无测试 (`approver.ts:22`)
3. `snapshotEnv` 的 contractLinked 事后新增不泄露无测试
4. `t1-missing-invoice` `keywordInReply ["0883"]` 比其 4 档 anchor 松 (`core.yaml`) → 下次修订数据集时收紧
5. 死代码 lint 警告: `judge.ts:23` WEIGHT_FACTOR 重复、`driver.ts:63` getPending 未用
6. 报告 cost 行补 `turnsUsed` (`reporter.ts:113-120`)

## Wontfix (已 triage, 不再跟进)

17 项 dormant/unreachable 小项 (类型加载器/CLI 现有调用点下无法污染判定) 与历史过程性报告偏差, 见评审记录。

# 批量拆分器 Phase 2 交接提示词(新对话直接引用)

> 用法: 在新对话中把本文件作为初始上下文引用("先完整阅读
> docs/superpowers/specs/2026-09-01-batch-splitter-phase2-handoff.md,
> 按其中的任务清单继续")。本文件是给下一个 agent 的指令, 不是给人看的
> 设计文档; 设计与实测结论的 SSOT 仍是
> docs/superpowers/specs/2026-09-01-batch-splitter-design.md (重点 §5/§7/§8)。

## 你接手时的仓库状态

- 分支 main 已推进到 d9234f5(含 Phase 2 全部代码与文档, 本地 build/lint/
  test 全绿后按惯例合入); 工作分支 PengYip/业务逻辑优化 与 main 同步。
- CI/CD 当前是红的, 但**不是代码问题**: 自托管 runner(ubuntu-server,
  ~/sca-runner) 经代理访问 GitHub 时 TLS 瞬断(checkout fetch 与 broker
  长轮询同时挂), 运维侧在处理, 你不需要管 CI, 也**不要**为了 CI 反复重跑。
- 灰度开关 BATCH_SPLIT_ENABLED 默认 false, 生产/dev 行为零变化; 灰度开启
  属于待办(见下)。
- 开始任何工作前: git fetch origin main 确认无新提交; 完整读一遍
  AGENTS.md 与设计文档; AI SDK 6 相关先读 ARCHITECTURE.md 附录 D。

## Phase 2 已完成(不要重做)

- 抽取层: manifest regions(padded bbox)裁剪 + 90/270 旋回双候选
  (src/pipeline/unitImages.ts, @napi-rs/canvas 已显式声明); 两遍读数共识
  (src/pipeline/batchConsensus.ts, 分歧压 overall<=0.5 + 强制 needs_review
  + _warnings 审核卡可见); runVoucherPipeline 的 unitVoucher 分支(重量组
  单图单抽/其余多图一次抽, OCR 块保留给 chunk/recall); unit 级并发复用
  BATCH_SPLIT_CONCURRENCY; 检测词表别名桥 UNIT_FORM_TYPE_ALIASES;
  实查工具 apps/server/scripts/processBatch.ts(内存库全链路)。
- 顺带修复(有回归测试): 化验指标基准词表补 daf; 重量共识改精确标签匹配
  (毛重时间/皮重时间时间字段排除, 实重=净重别名)。
- 实测(生产同款 千帆 PaddleOCR-VL + 百炼 qwen3.8-max): 宣威 11/11、
  华新 10/10(daf 修复后)、下游收货数据+磅单 12/12(跨页续表合并/单页双票
  切开)、下游收货证明 12/12(修复后零误报)。数字与证据见设计文档 §8。
- 关键实测事实: 千帆 OCR 读数 100% 正确(华新编号仲裁), 检测遍
  identifierOrNull 会误读小字号长数字 -> "两遍一致才放行"共识是正确防线;
  旋回双候选日志形态 `rot=[270] score=2.58 mismatch=0 vs rot=[90]
  score=0.59 mismatch=1 -> 取 rot=[270]` 是方向分离的正常证据。

## 待办任务(按优先级)

1. 灰度开启(运维): CI 绿 + CD 部署 d9234f5 后, dev .env 加
   BATCH_SPLIT_ENABLED=true 重启, 走真实上传链路验证一次。
2. Phase 3 谱系(设计已给完整方案, 见上一轮对话结论):
   - P3a 后端: getReviewSnapshot/文档列表/recall 带 batchRole/
     parentDocumentId/unitIndex; Neo4j (container)-[:CONTAINS]->(unit);
     container 跳过业务分类(doc_type 固定「单据组」或 batch_role 驱动);
   - P3b 前端: 文件树 container->units 层级; batch_role badge 不进 docType
     词表; container 卡=拆分清单导航(不展示字段/关系维);
   - P3c: unit 卡第六维「来源与拆分」(manifest + _warnings 数据已有, 补
     join); needs_review 按 container 聚合;
   - P3d: 重拆/合并修正/单 unit 重抽入口(现有 processDocumentWithBatch 幂等)。
3. 质量优化(零新增依赖, 按价值排序):
   - 千帆 OCR 文本纳入三向共识(实测其读数全对, 检测/抽取遍都漂移过);
   - OCR 方向仲裁替代 VLM 双候选默认路径: 对两个候选旋回各跑一次千帆 OCR
     (~2-5s), 比较 layout_det_res 分数/文本量, 差距小再回落 VLM 双候选
     (省一半 VLM 调用);
   - 消费千帆响应中当前被 paddleocrAdapter 丢弃的 layout_det_res
     ({boxes:[{label,score,coordinate,cls_id}]}) 做 bbox 精化/表格结构。
4. 小修: validateVoucher 低位发热量 ar(kcal) vs ad(MJ) 跨量纲误报(既有,
   只抬复核率); 检测 formType 标签漂移(宣威磅单 汽运磅单<->轨道衡称重单
   跨 run 漂移, 别名桥都覆盖不影响抽取)词表归一/别名迁入模板 props。
5. 校准样例(可选): 货转单/银行回单/水尺计重单多单据 PDF(三类路由零实测);
   真实汽运磅单拼版(验证标签漂移是否常态)。

## 远程实测流程(10.10.0.2, 上次清理过, 需重建)

样例: 本地 C:/Users/yepeng/Desktop/货值计算/ 下(华新水泥襄阳化验报告.pdf、
单文件多类型单据/下游收货数据+磅单532.6吨盖章.pdf、下游收货证明+磅单
537.81吨6.8盖章.pdf), 远程 /tmp/xuanwei-batch.pdf、/tmp/huaxin-reports.pdf、
/tmp/xiayou-pound.pdf、/tmp/xiayou-cert.pdf(P1/P2 遗留, 未必还在)。

1. push 分支后在 ~/supply-chain-agent: git fetch origin <分支>;
   git worktree add --detach /tmp/sca-p2 origin/<分支>;
   ln -sfn ~/supply-chain-agent/node_modules /tmp/sca-p2/node_modules
   (apps/server/node_modules 存在则同样链接)。
2. 重建 /tmp/bs.env(上次已清理):
   grep -E '^(VLM_BASE_URL|VLM_API_KEY|VLM_MODEL|PARSE_BACKEND|QIANFAN_API_KEY|QIANFAN_OCR_URL|QIANFAN_TIMEOUT_MS)=' ~/supply-chain-agent/.env > /tmp/bs.env
   echo 'OPENAI_API_KEY=ci-dummy-key' >> /tmp/bs.env
   (生产 OCR=PARSE_BACKEND=qianfan 千帆 PaddleOCR-VL API; VLM=百炼
   qwen3.8-max; 不要把整个项目 .env source 进来, 它指向共享 PG 开发库)。
3. 运行(从 worktree 根, INGEST_ROOT 默认 <cwd>/ingest-root):
   export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
   set -a; . /tmp/bs.env; set +a
   npx tsx apps/server/scripts/processBatch.ts /tmp/<样例>.pdf --concurrency 4
   注意 ssh 里后台启动要用 `(nohup ... > log 2>&1 &); sleep 3` 包一层,
   zsh 会吞 && 链上的裸 `&`; zsh 会把 URL 里的 ? 当 glob(加引号)。
4. 用完清理: git worktree remove --force /tmp/sca-p2 + 删临时文件(P1 惯例)。

## 环境坑(实测踩过, 别再踩)

- runner(sca-runner)无 sudo 可用; ssh 非交互 shell 不加载 nvm(PATH 要显式
  export)与 pm2; 代理链路: ~/.gitconfig 全局 proxy=172.18.15.20:7897(runner
  的 git 走它), 本机 mihomo 127.0.0.1:7890 当前对 github 超时(不在 git 路径)。
- pdf-parse 在 vitest 进程内偶发 "Invalid PDF structure"(已知 flaky, 夹具
  用手写 PDF 或 mineru hermetic sidecar); 测试文字层 PDF 手写, 图像型用
  pdf-lib 嵌 PNG。
- z.coerce.boolean() 把 "false" 强转 true, 布尔 env 用 preprocess(照抄
  env.ts 里 BATCH_SPLIT_ENABLED 写法)。
- pg 集成测试必须用独立 sca_test 库, 绝不可指向共享开发库 sca。
- MinerU hermetic sidecar `<file>.pdf.mineru.json`; 千帆 sidecar
  `<file>.paddleocr.json`; 两者的 parse 都走 assertWithinRoot(文件须在
  INGEST_ROOT 下)。
- 单测里 fake VLM 按"调用序回灌"的用例必须 BATCH_SPLIT_CONCURRENCY=1
  (unit 并发会打乱顺序); 共识命中要求读数归一化后长度>=4。

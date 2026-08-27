# 文件管理体验优化 — 设计文档

日期：2026-08-27
分支：Feat-文件管理体验优化
状态：已确认（用户预先批准全部设计节，跳过逐节评审）

## 背景与问题

文件管理抽屉（`apps/web/src/components/shell/FileDrawer.tsx`）当前操作受限：

1. 「新建文件夹」只能建根目录文件夹，无法在已有文件夹内建子文件夹。
2. 无拖放上传入口；上传只能从聊天输入框发起，且永远落根目录。
3. 文件夹无重命名、无法移动；文件移动只有下拉列表方式。

后端实际已具备多级路径能力：`POST /api/files/mkdir` 的 `normalizeDirectory`
接受 `a/b/c` 形式路径；`POST /api/files` 接受可选 multipart `directory` 字段；
`PATCH /move` 支持任意目录。缺口全在前端，外加一个缺失的后端接口（文件夹整体
改名/移动）。

## 方案选择

采用**方案 A：渐进增强现有抽屉**——保留展开式树形结构，原位补齐能力，后端仅新增一个接口。落选方案：B（改为当前目录视图+面包屑，丢全局总览、重构量大）、C（A+树形选择器弹层，超范围）。

## 功能范围

| # | 能力 | 后端改动 |
|---|------|---------|
| 1 | 文件夹内新建子文件夹 | 零改动（复用 mkdir 多级路径） |
| 2 | 拖放上传到指定文件夹 | 零改动（复用 upload directory 字段） |
| 3 | 批量拖拽上传（含整个文件夹，保留层级） | 零改动 |
| 4 | 文件/文件夹单层拖拽移动 + 拖回根目录 | 复用 /move + 新接口 |
| 5 | 文件夹重命名 / 移动（改前缀） | **新增 PATCH /api/files/folder-path** |
| 6 | 上传进度可视化（字节级，聊天框+抽屉两处） | 零改动 |
| 7 | 文件管理改为停靠式可伸缩侧边栏（非浮动抽屉） | 零改动 |

明确不做（YAGNI）：文件夹下载/打包、多选批量操作、回收站、聊天框选目录上传、路径 `..` 穿越防御增强（现状 `normalizeDirectory` 不处理点段且 key 恒在用户前缀内，维持并记录）。聊天输入框上传保持落根目录不变。

## 安全性确认（move 与解析/图谱的关系）

移动文件路径不影响已有结果：

- `/move` 只做 MinIO copy+remove 并更新 `documents.minio_key`，**docId 不变**；
  解析产物（chunks/fts/vec/extractions）与绑定（bindings、图谱 Document 节点/边）
  均以 docId 为锚。
- 图谱节点 sourceUri、绑定工作台「所在文件夹」均为展示元数据（后者实时从
  minio_key 解析），自动跟随新 key。
- 既有的 `documents.source_uri`（INGEST_ROOT 展平本地路径）不随 move 更新，
  本地副本仍在原地且内容一致，未来重解析读取不受影响——记录为已知无害细节。

## 后端设计

### 新增接口：PATCH /api/files/folder-path

服务「文件夹重命名」与「文件夹拖入另一文件夹」两个语义（move 本质是前缀替换）。
Body: `{ from: '合同', to: '合同2026' }` 或 `{ from: '合同', to: '发运/合同' }`。

守卫与语义：

1. 双端过 `normalizeDirectory`；`from` 为空 → 400；`to === from` 或
   `to.startsWith(from + '/')`（移入自己子树）→ 400。
2. 目标路径存在精确同名文件夹行（`file_folders.path === to`）→ 409。
3. 权限 `requireRole('admin', 'trader')`；所有权天然限定在用户前缀内。
4. 执行顺序（尽力而为，非严格事务）：
   - 收集该用户下 `path === from` 或以 `from + '/'` 开头的文件夹行；
   - 遍历 MinIO 前缀 `users/<uid>/<from>/` 下对象：copyObject 到替换后的新 key
     → removeObject 旧 key → 用现有 `findDocIdsByMinioKeys` +
     `setDocumentMinioKey` 回写 docId 关联；
   - 最后批量更新 `file_folders` 行路径（SQL 前缀替换更新）。
5. 中途失败：对已完成对象做反向 best-effort 回滚，响应 detail 如实报告进度；
   保证级别与现有单文件 `/move` 相同，不承诺跨存储原子性。

### Repository 层补充（SQLite + PG 双实现）

按现有 dual-backend 模式各补两个函数：按用户列某前缀的文件夹行；批量前缀改名
（`UPDATE ... SET path = ? || substr(path, ...)` 形式）。

### 零改动复用

- 拖放上传：`POST /api/files` 已支持 multipart `directory`。
- 子文件夹创建：`POST /api/files/mkdir` 已支持多级 path。

## 前端设计

### 结构拆分（FileDrawer.tsx 现 776 行）

- `FileDrawer.tsx` — 容器与状态编排
- `FileTree.tsx` — TreeNode/TreeFolder/FileRow 展示组件（纯搬移现有渲染逻辑）
- `useFileDnd.ts` — 拖拽状态机 hook（载荷分流、目标判定）
- `useFolderDropUpload.ts` — 上传队列 hook（收集、串行执行、进度汇总）
- `uploadWithProgress.ts` — 共享上传传输层（XHR + upload.onprogress）

### 停靠式可伸缩侧边栏

- **形态变更**：由「遮罩 + fixed 右侧浮动 aside」改为停靠在应用主布局右侧的侧边面板：打开时压缩主内容区宽度（flex 布局参与排版），不再有遮罩，主界面在侧边栏打开时仍可交互；关闭按钮保留。
- **伸缩**：左缘 4px 拖拽手柄（hover 显色），水平拖动实时改宽；范围 clamp 280px–560px（默认 360px）；宽度持久化 localStorage（key 如 `sca.filesPanelWidth`）。
- **挂载点**：从 App 根部的浮层改为布局容器内的兄弟节点（App.tsx 现有 chat 主列旁）；open=false 时完全不渲染主列不占位。Esc 关闭逻辑保留，移除点遮罩关闭。

### 上传进度

- **传输层**：`fetch` 不支持上传进度，共享助手 `uploadWithProgress(file, directory, onProgress)` 基于 XMLHttpRequest 的 `upload.onprogress` 事件实现字节级进度（loaded/total），错误/超时映射为 reject。聊天框与抽屉队列共用此助手。
- **抽屉批量队列**：单项显示百分比；底部汇总条显示聚合进度（已完成字节合计 / 总字节合计）+「n/m · 失败 k」，替代纯计数。
- **聊天输入框**：现有按钮转圈态（RealChatView.tsx:823-826）替换为内联细进度条+百分比文案；完成后恢复原成功提示。

### 交互

- **子文件夹创建**：文件夹行 hover 动作区在「删除」旁加「+」；头部「新建文件夹」保留（根目录语义）。点击后在对应缩进层出现行内输入（复用现有命名交互），Enter → `mkdir('父路径/新名')`。
- **拖放目标高亮**：抽屉内容区空白处与标题区为根目录落点（提示条文案区分“上传”或“移动到根目录”）；文件夹行 dragover 时整行高亮+左侧竖条；同一次 drop 按 payload 分流——OS 文件→上传到该文件夹，内部拖动行→移动/前缀变更。拖动中的行自身及其子树不可作为目标（前后端双重守卫）。
- **内部拖动**：HTML5 DnD，dataTransfer 自定义类型 `application/x-sca-file|folder`；外部 OS 拖入经 dragenter items 判别。文件拖动走既有 `/move`；文件夹拖动走新 `folder-path`。仅单行拖动，无多选。
- **批量上传（含文件夹）**：收集顺序 `webkitGetAsEntry()` 递归遍历保留层级 → 降级 `webkitRelativePath` → 再降级平铺；层级中缺失的文件夹自动 mkdir 补建；队列串行执行（避免并发压垮 fGetObject 落盘）；每项完成本地乐观插入，全部结束统一 `refresh()` 对账；底部汇总条「上传中 3/12 · 失败 1」，失败项可点看原因。

### 错误处理

| 场景 | 行为 |
|---|---|
| 上传单项失败（413/5xx） | 队列继续；记入失败列表，汇总条显示原因 |
| drop 到自己/子孙文件夹 | 前端忽略该 drop；后端 folder-path 400 兜底 |
| folder-path 目标同名 | 409 → toast「已存在同名文件夹」 |
| 移动/改名中途 MinIO 失败 | 后端 best-effort 反向回滚 + detail 报告；前端 refresh 对账展示真实状态，不做乐观猜测 |
| 同名文件传同一文件夹 | 维持现状：uuid 前缀不冲突，两份并列，不去重 |

## 测试策略（vitest，沿用仓库惯例）

- 单测：`normalizeDirectory` 边界（空串/冗余斜杠）；folder-path 守卫谓词抽纯函数测（自套娃、空 from、前缀替换正确性）。
- 路由测试：mkdir 多级路径；folder-path 400/409 分支；move 后 minio_key 关联可查。minioClient 按 files 路由现有测试的 stub 方式处理（写计划时核对具体模式）。
- 前端：hook 内载荷分流/层级重建逻辑抽纯函数覆盖；进度聚合（字节合计）抽纯函数测；不强求 e2e。

验证顺序：build → lint → test（仓库约定）。

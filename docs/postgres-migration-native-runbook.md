# Postgres 迁移运行手册（原生 Windows，无 Docker）

> DISK-GATED PREP（补充篇）。本篇为「不装 Docker」的轻量路径，与 `postgres-migration-runbook.md`（Docker 路径）二选一。
> 适用场景：C: 盘紧张（当前 ~5.8GB 可用，Docker Desktop 需 5-10GB 装不下）、不想装 Docker、或私有化交付机禁用容器。
> 数据与二进制全部放 D: 盘（273GB 可用），C: 仅留少量配置。

---

## 前置确认

- 已选 **方案 (b) 原生 Postgres**（用户确认）。如未确认，回到 `postgres-migration-runbook.md` 的 Docker 路径或方案 (c) 延期（SQLite 已提供完整召回，88 测试绿）。
- 本手册不动 SQLite 运行时；仅在 `DB_BACKEND=postgres` 时生效。回滚 = `DB_BACKEND=sqlite`（SQLite 数据原封不动）。

## Step 0：清理 C: 盘（可选，给系统留余量）

```bash
npm cache clean --force        # 历史上释放了 ~4.26GB
uv cache clean                 # uv 缓存在 D:，释放 D: 不释放 C:
# cleanmgr（图形）清理 Windows Update 缓存 / 旧安装 / 回收站
# 目标：C: 留 ≥3GB 系统余量（Postgres 二进制放 D: 不占 C:）
```

## Step 1：下载便携 Postgres 到 D:（不装系统服务）

下载 EnterpriseDB PostgreSQL Windows 二进制（zip 免安装版）到 D:：

```bash
# 示例：PostgreSQL 16.x Windows x86-64 zip（约 300MB）
# 官方下载页：https://www.enterprisedb.com/download-postgresql-binaries
# 解压到 D:\pgsql
mkdir -p /d/pgsql
# （手动下载 edb 并解压到 D:\pgsql，或用浏览器/curl 拉取 zip）
# 解压后结构：D:\pgsql\bin\initdb.exe, pg_ctl.exe, psql.exe ...
```

> 注意：EDB zip 是「免安装便携版」，不写注册表、不装 Windows 服务；所有数据放 D:。卸载 = 删 D:\pgsql 目录。

## Step 2：初始化数据目录（D:）并启动

```bash
# 一次性初始化
D:/pgsql/bin/initdb.exe -D D:/pgdata -U sca -W
# （-W 会提示输入密码，记为 sca_dev_password，与 docker-compose.yml 对齐）

# 启动（前台调试用 -l 日志；生产用 register
pg_ctl register 装 Windows 服务）
D:/pgsql/bin/pg_ctl.exe -D D:/pgdata -l D:/pgdata/log.txt -o "-p 5432" start
```

确认：`D:/pgsql/bin/psql.exe -U sca -d postgres -c "select version();"` 应返回 PostgreSQL 16.x。

## Step 3：安装 pgvector 扩展

pgvector 需单独装（EDB zip 不含）。Windows 二进制获取：

- 优先：从 https://github.com/pgvector/pgvector/releases 取对应 PG16 的 Windows 预编译 dll，放入 `D:/pgsql/share/extension/` + `D:/pgsql/lib/`。
- 备选：若有 MSVC 环境，`pgvector` 源码 `make && make install`（`PG_CONFIG=D:/pgsql/bin/pg_config.exe`）。
- 若取不到 Windows 预编译 pgvector：退回 Docker 路径（`pgvector/pgvector:pg16` 自带），或临时方案 (c) 延期。

启用：
```sql
-- 用 psql 连到 sca 库后执行
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname='vector';  -- 应非空
```

## Step 4：建库 + 应用 schema

```bash
D:/pgsql/bin/psql.exe -U sca -d postgres -c "CREATE DATABASE sca;"
```

生成并应用 Drizzle 迁移（schema 定义在 `server/src/pipeline/db/postgres-schema.ts`）：
```bash
cd server
DATABASE_URL="postgresql://sca:sca_dev_password@localhost:5432/sca" \
  npx drizzle-kit generate
# 再补 pgvector HNSW + tsvector GIN 的 raw SQL（Drizzle 表达不了这些 index 操作）
DATABASE_URL="postgresql://sca:sca_dev_password@localhost:5432/sca" \
  npx drizzle-kit migrate
```

## Step 5：切换后端（一行配置）

```bash
export DB_BACKEND=postgres
export DATABASE_URL="postgresql://sca:sca_dev_password@localhost:5432/sca"
# 接 `server/src/pipeline/db/dbBackend.ts` 的 getDbContext()：postgres 分支启用
# （仍需在 agent.ts 把 getHarnessDbContext → getDbContext 接通，见 postgres runbook Step 5）
```

## Step 6：端口仓储层（SQLite → Postgres）

与 Docker 路径相同的代码改动（见 `postgres-migration-runbook.md` Step 4）：
- `repositories.ts`：better-sqlite3 → node-postgres（`pg`）；JSON 列 → JSONB。
- `vecStore.ts`：sqlite-vec `MATCH`/`distance` → pgvector `<=>`（余弦）。
- FTS：SQLite FTS5 `bm25()` → Postgres `ts_rank`（或保留 tsvector GIN + `ts_rank_cd`）。
- 混合 RRF 逻辑（recall.ts）不变，仅替换两路召回的数据源。

## Step 7：验证

```bash
# 测试仍需 D: temp 重定向（C: 紧张）
TMPDIR=D:/tmp TMP=D:/tmp TEMP=D:/tmp npm_config_cache=D:/npm-cache \
  node node_modules/vitest/vitest.mjs run
# 期望：88 测试全绿（召回/压缩/契约/状态栏等），数据落 Postgres。
```

## Step 8（可选）：SQLite → Postgres 数据迁移

```bash
# 用 \copy 从 SQLite 导出的 CSV 灌入；file_hash 幂等去重
# 重新嵌入（embedder 对历史 chunk 补算 vector，存入 doc_chunk.embedding）
```

## 回滚

```bash
unset DB_BACKEND   # 或 export DB_BACKEND=sqlite
# SQLite pipeline.db 原封未动，运行时立即回 SQLite。
```

---

## 风险与决策提示

- **pgvector Windows 二进制是这条路径唯一不确定项**：EDB zip 不含，需找 PG16 对应预编译 dll 或自编译。若拿不到，本路径不可行，退回 Docker 路径或方案 (c) 延期。
- 当前 SQLite 召回（FTS5 + sqlite-vec + RRF）已 88 测试绿，**功能上 Postgres 非必需**；只有「更大规模 / SQL 级多租户权限 / 跨项目聚合」才真正需要 Postgres。建议在确认有上述诉求后再走本手册。

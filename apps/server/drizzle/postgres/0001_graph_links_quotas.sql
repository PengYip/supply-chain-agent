-- graph_links + quotas(spec 2026-08-25 方案A §3.1/§3.3)。
-- HAND-WRITTEN(非 drizzle-kit generate 产物): 旧快照 0000 含 Phase 4 已删除的
-- doc_contract/document_relation, generate 的 rename 交互提示在非 TTY 下不可
-- 用; 叠层手工 SQL 是 runbook 认可的方式(docs/postgres-migration-runbook.md)。
-- 全部 IF NOT EXISTS: 与运行时 migrateOnStartup 的幂等 DDL 互为兜底, 谁先跑
-- 都收敛到同一结构(列对列镜像 postgres-schema.ts graphLinks/quotas)。
CREATE TABLE IF NOT EXISTS "graph_links" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"src_kind" text NOT NULL,
	"src_key" text NOT NULL,
	"src_label" text DEFAULT '' NOT NULL,
	"dst_kind" text NOT NULL,
	"dst_key" text NOT NULL,
	"dst_label" text DEFAULT '' NOT NULL,
	"props" text DEFAULT '{}' NOT NULL,
	"confidence" numeric(5, 4) DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"confirmation_source" text,
	"created_by" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"graph_status" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_graph_links_triple" ON graph_links USING btree (kind, src_key, dst_key, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_graph_links_user" ON graph_links USING btree (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_graph_links_src" ON graph_links USING btree (src_kind, src_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotas" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_key" text NOT NULL,
	"owner_label" text DEFAULT '' NOT NULL,
	"limit_amount" double precision NOT NULL,
	"currency" text,
	"period" text,
	"used_amount" double precision DEFAULT 0 NOT NULL,
	"computed_at" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quotas_owner" ON quotas USING btree (scope, owner_key, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_quotas_user" ON quotas USING btree (user_id);

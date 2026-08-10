CREATE TABLE "bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"contract_no" text NOT NULL,
	"relation" text NOT NULL,
	"source_refs" jsonb NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"created_by" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_chunk" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"chunk_text" text NOT NULL,
	"chunk_index" integer,
	"embedding" vector(1024),
	"fts_vector" "tsvector",
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_contract" (
	"contract_no" text PRIMARY KEY NOT NULL,
	"amount" numeric(18, 2),
	"currency" text DEFAULT 'CNY',
	"sign_date" timestamp with time zone,
	"source_file" text,
	"source_page" integer,
	"voucher_no" text,
	"file_hash" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_relation" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_doc" text NOT NULL,
	"target_doc" text NOT NULL,
	"relation_type" text NOT NULL,
	"source_clause" text,
	"confidence" numeric(5, 4),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_relation_type_check" CHECK ("document_relation"."relation_type" IN ('补充协议', '验收单', '付款单', '发票', '关联交易'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_type" text NOT NULL,
	"modality" text NOT NULL,
	"source_uri" text NOT NULL,
	"block_model" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"doc_type" text NOT NULL,
	"fields" jsonb NOT NULL,
	"field_meta" jsonb NOT NULL,
	"overall_confidence" numeric(5, 4) NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bindings" ADD CONSTRAINT "bindings_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chunk" ADD CONSTRAINT "doc_chunk_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_relation" ADD CONSTRAINT "document_relation_source_doc_documents_id_fk" FOREIGN KEY ("source_doc") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_relation" ADD CONSTRAINT "document_relation_target_doc_documents_id_fk" FOREIGN KEY ("target_doc") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bindings_contract" ON "bindings" USING btree ("contract_no");--> statement-breakpoint
CREATE INDEX "idx_doc_chunk_doc" ON "doc_chunk" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_doc_contract_file_hash" ON "doc_contract" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "idx_document_relation_source" ON "document_relation" USING btree ("source_doc");--> statement-breakpoint
CREATE INDEX "idx_document_relation_target" ON "document_relation" USING btree ("target_doc");--> statement-breakpoint
CREATE INDEX "idx_extractions_doc" ON "extractions" USING btree ("document_id");
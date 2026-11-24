-- Extensions used by the schema (pgvector for embeddings, ltree for the NACE hierarchy).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SourceEventKind" AS ENUM ('started', 'completed', 'degraded', 'failed');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('identity', 'translated', 'embedded', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('relevant', 'borderline', 'not_relevant');

-- CreateTable
CREATE TABLE "source_event" (
    "id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "kind" "SourceEventKind" NOT NULL,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_checkpoint" (
    "id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "watermark" TIMESTAMPTZ(3) NOT NULL,
    "cursor" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_record" (
    "id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" UUID NOT NULL,
    "raw_record_id" UUID NOT NULL,
    "source_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "published_on" DATE NOT NULL,
    "deadline" DATE,
    "deadline_kind" TEXT,
    "event_date" DATE,
    "ref" TEXT,
    "ref_key" TEXT,
    "related_to" TEXT,
    "nace_tags_stated" BOOLEAN NOT NULL,
    "nace_tags" TEXT[],
    "topics" TEXT[],
    "url" TEXT,
    "action_points" JSONB NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "translation" (
    "id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "status" "StageStatus" NOT NULL,
    "source_language" TEXT NOT NULL,
    "title_en" TEXT,
    "summary_en" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embedding" (
    "id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "status" "StageStatus" NOT NULL,
    "dims" INTEGER,
    "vector" vector(1024),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_link" (
    "id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "target_group_key" TEXT,
    "rationale" TEXT NOT NULL,
    "trace" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_snapshot" (
    "id" UUID NOT NULL,
    "group_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "retired" BOOLEAN NOT NULL DEFAULT false,
    "engine" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_original" TEXT,
    "language" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "member_ids" UUID[],
    "nace_tags" TEXT[],
    "action_points" JSONB NOT NULL,
    "source_trail" JSONB NOT NULL,
    "latest_published" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "group_key" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "why_relevant" TEXT NOT NULL,
    "trace" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relevance_label" (
    "id" UUID NOT NULL,
    "classification_id" UUID NOT NULL,
    "country" TEXT NOT NULL,
    "nace_code" TEXT NOT NULL,
    "nace_path" ltree NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "score" DOUBLE PRECISION,
    "rationale" TEXT NOT NULL,

    CONSTRAINT "relevance_label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_profile" (
    "id" UUID NOT NULL,
    "countries" TEXT[],
    "nace_codes" TEXT[],
    "acknowledged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_cycle" (
    "id" UUID NOT NULL,
    "stats" JSONB NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_cycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_event_source_id_created_at_idx" ON "source_event"("source_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "source_checkpoint_source_id_created_at_idx" ON "source_checkpoint"("source_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "raw_record_content_hash_key" ON "raw_record"("content_hash");

-- CreateIndex
CREATE INDEX "raw_record_source_id_external_id_idx" ON "raw_record"("source_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "finding_raw_record_id_key" ON "finding"("raw_record_id");

-- CreateIndex
CREATE INDEX "finding_source_id_external_id_created_at_idx" ON "finding"("source_id", "external_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "finding_jurisdiction_published_on_idx" ON "finding"("jurisdiction", "published_on" DESC);

-- CreateIndex
CREATE INDEX "finding_ref_key_idx" ON "finding"("ref_key");

-- CreateIndex
CREATE INDEX "finding_created_at_idx" ON "finding"("created_at" DESC);

-- CreateIndex
CREATE INDEX "translation_finding_id_engine_created_at_idx" ON "translation"("finding_id", "engine", "created_at" DESC);

-- CreateIndex
CREATE INDEX "embedding_finding_id_engine_created_at_idx" ON "embedding"("finding_id", "engine", "created_at" DESC);

-- CreateIndex
CREATE INDEX "group_link_finding_id_engine_created_at_idx" ON "group_link"("finding_id", "engine", "created_at" DESC);

-- CreateIndex
CREATE INDEX "group_snapshot_group_key_created_at_idx" ON "group_snapshot"("group_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "classification_group_key_created_at_idx" ON "classification"("group_key", "created_at" DESC);

-- CreateIndex
CREATE INDEX "classification_snapshot_id_engine_idx" ON "classification"("snapshot_id", "engine");

-- CreateIndex
CREATE INDEX "relevance_label_classification_id_idx" ON "relevance_label"("classification_id");

-- CreateIndex
CREATE INDEX "operator_profile_created_at_idx" ON "operator_profile"("created_at" DESC);

-- CreateIndex
CREATE INDEX "pipeline_cycle_finished_at_idx" ON "pipeline_cycle"("finished_at" DESC);

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_raw_record_id_fkey" FOREIGN KEY ("raw_record_id") REFERENCES "raw_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "translation" ADD CONSTRAINT "translation_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_link" ADD CONSTRAINT "group_link_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification" ADD CONSTRAINT "classification_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "group_snapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relevance_label" ADD CONSTRAINT "relevance_label_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "classification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


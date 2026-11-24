-- Embeddings of the NACE Rev. 2.1 codes (English title + explanatory notes) for semantic code search.
-- One row per (engine, code, content hash): a restart with the same provider/model embeds nothing again;
-- another model or changed notes add new rows (append-only).
CREATE TABLE "nace_embedding" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "dims" INTEGER NOT NULL,
    "vector" vector NOT NULL,
    "compacted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "nace_embedding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT nace_embedding_dims_match CHECK (vector_dims("vector") = "dims")
);
CREATE UNIQUE INDEX "nace_embedding_engine_code_content_hash_key" ON "nace_embedding"("engine", "code", "content_hash");
CREATE INDEX nace_embedding_vector_1024_hnsw ON "nace_embedding" USING hnsw (("vector"::vector(1024)) vector_cosine_ops) WHERE "dims" = 1024;
CREATE INDEX nace_embedding_vector_3072_hnsw ON "nace_embedding" USING hnsw (("vector"::halfvec(3072)) halfvec_cosine_ops) WHERE "dims" = 3072;
GRANT SELECT ON "nace_embedding" TO radar_agent_reader;

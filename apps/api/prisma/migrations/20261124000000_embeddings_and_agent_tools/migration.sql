-- Embeddings of different providers have different sizes (mistral-embed 1024, text-embedding-3-large 3072).
-- The column becomes untyped; one partial HNSW index per size serves nearest-neighbour search
-- (pgvector indexes `vector` up to 2000 dimensions, so 3072 is indexed as halfvec).
DROP INDEX IF EXISTS embedding_vector_hnsw;
ALTER TABLE "embedding" ALTER COLUMN "vector" TYPE vector;
ALTER TABLE "embedding" ADD COLUMN "compacted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "embedding" ADD CONSTRAINT embedding_dims_match CHECK ("vector" IS NULL OR vector_dims("vector") = "dims");
CREATE INDEX embedding_vector_1024_hnsw ON "embedding" USING hnsw (("vector"::vector(1024)) vector_cosine_ops) WHERE "dims" = 1024;
CREATE INDEX embedding_vector_3072_hnsw ON "embedding" USING hnsw (("vector"::halfvec(3072)) halfvec_cosine_ops) WHERE "dims" = 3072;

-- Full-text search for the agents ('simple' configuration: no stemming, works for every language).
CREATE INDEX finding_fts ON "finding" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("ref", '')));
CREATE INDEX translation_fts ON "translation" USING gin (to_tsvector('simple', coalesce("title_en", '') || ' ' || coalesce("summary_en", '')));

-- Role for the agents' arbitrary SQL tool: no login, SELECT only (the tool also runs READ ONLY with a timeout).
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'radar_agent_reader') THEN
    CREATE ROLE radar_agent_reader NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO radar_agent_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO radar_agent_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO radar_agent_reader;

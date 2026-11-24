-- At most one finished (non-failed) translation and embedding per finding and engine, so two workers cannot
-- store the same result twice (inserts use ON CONFLICT DO NOTHING). Failed attempts stay separate rows.
-- Also serves the "already done" check of the pending query.
CREATE UNIQUE INDEX translation_finding_engine_done ON "translation" ("finding_id", "engine") WHERE "status" <> 'failed';
CREATE UNIQUE INDEX embedding_finding_engine_done ON "embedding" ("finding_id", "engine") WHERE "status" <> 'failed';

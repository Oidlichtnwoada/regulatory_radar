-- 1. Raw records are deduplicated against the LATEST version of their item (in the ingestion, under a per-source
--    advisory lock), not globally: an item that changes back to an earlier payload (A -> B -> A) becomes current
--    again. The hash stays indexed for lookups.
DROP INDEX "raw_record_content_hash_key";
CREATE INDEX "raw_record_content_hash_idx" ON "raw_record"("content_hash");

-- 2. Read models, corrected. Dropped in dependency order and recreated.
DROP FUNCTION refresh_read_models();
DROP MATERIALIZED VIEW radar_label_current;
DROP MATERIALIZED VIEW radar_group_current;
DROP MATERIALIZED VIEW finding_current;

-- Latest version of every source item, by stream order (all findings of one batch share created_at, so the
-- timestamp cannot order versions that arrive together).
CREATE MATERIALIZED VIEW finding_current AS
SELECT DISTINCT ON (f.source_id, f.external_id) f.id, f.source_id, f.external_id, f.jurisdiction, f.published_on,
       f.created_at
FROM finding f JOIN raw_record r ON r.id = f.raw_record_id
ORDER BY f.source_id, f.external_id, r.stream_seq DESC, f.id DESC;
CREATE UNIQUE INDEX finding_current_pk ON finding_current (id);
CREATE INDEX finding_current_order ON finding_current (published_on DESC, id);
CREATE INDEX finding_current_jurisdiction ON finding_current (jurisdiction, published_on DESC);
CREATE INDEX finding_current_source ON finding_current (source_id, published_on DESC);

-- Current procedure groups: latest non-retired snapshot + the classification of the NEWEST snapshot that has one
-- (a late result for an older snapshot can no longer replace the result for the current one) + first-seen time.
CREATE MATERIALIZED VIEW radar_group_current AS
WITH snap AS (
  SELECT DISTINCT ON (group_key) * FROM group_snapshot ORDER BY group_key, created_at DESC, id DESC
), first_seen AS (
  SELECT group_key, min(created_at) AS first_seen_at FROM group_snapshot GROUP BY group_key
), cls AS (
  SELECT DISTINCT ON (c.group_key) c.id, c.group_key, c.engine, c.why_relevant
  FROM classification c JOIN group_snapshot gs ON gs.id = c.snapshot_id
  ORDER BY c.group_key, gs.created_at DESC, gs.id DESC, c.created_at DESC, c.id DESC
)
SELECT s.group_key, s.id AS snapshot_id, s.title, s.title_original, s.language, s.jurisdiction, s.level, s.stage,
       s.member_ids, cardinality(s.member_ids) AS member_count, s.nace_tags, s.action_points, s.source_trail,
       s.latest_published, f.first_seen_at, c.id AS classification_id, c.engine AS classification_engine,
       c.why_relevant
FROM snap s JOIN first_seen f USING (group_key) LEFT JOIN cls c USING (group_key)
WHERE NOT s.retired;
CREATE UNIQUE INDEX radar_group_current_pk ON radar_group_current (group_key);
CREATE INDEX radar_group_current_scope ON radar_group_current (level, jurisdiction);
CREATE INDEX radar_group_current_members ON radar_group_current USING gin (member_ids);

-- Current relevance labels (relevant and borderline only), indexed on (country, NACE path) for lquery matching.
CREATE MATERIALIZED VIEW radar_label_current AS
SELECT g.group_key, l.country, l.nace_code, l.nace_path, l.verdict, verdict_rank(l.verdict) AS verdict_rank,
       l.score, l.rationale
FROM radar_group_current g JOIN relevance_label l ON l.classification_id = g.classification_id
WHERE l.verdict <> 'not_relevant';
CREATE UNIQUE INDEX radar_label_current_pk ON radar_label_current (group_key, country, nace_code);
CREATE INDEX radar_label_current_match ON radar_label_current USING gist (country, nace_path);

-- Ingestion only adds findings: it refreshes the findings view alone. The pipeline refreshes everything.
CREATE FUNCTION refresh_findings() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY finding_current;
END $$;

CREATE FUNCTION refresh_read_models() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY finding_current;
  REFRESH MATERIALIZED VIEW CONCURRENTLY radar_group_current;
  REFRESH MATERIALIZED VIEW CONCURRENTLY radar_label_current;
END $$;

-- The views are new objects: the agents' read-only role reads them like before.
GRANT SELECT ON finding_current, radar_group_current, radar_label_current TO radar_agent_reader;

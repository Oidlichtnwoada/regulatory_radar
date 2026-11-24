-- Read models and search indexes. Tables stay append-only; the materialized views below are the
-- derived "current" state and are refreshed by the pipeline (refresh_read_models()).

-- Nearest-neighbour search over embeddings (cosine distance).
CREATE INDEX embedding_vector_hnsw ON embedding USING hnsw (vector vector_cosine_ops) WHERE vector IS NOT NULL;
-- Fuzzy title search for the findings list.
CREATE INDEX finding_title_trgm ON finding USING gin (title gin_trgm_ops);
CREATE INDEX translation_title_trgm ON translation USING gin (title_en gin_trgm_ops);

-- Actionability: the ONLY definition of the ranking tiers (open window, upcoming vote, standstill,
-- ongoing procedure, adopted, information). Pure and immutable: same input, same output.
CREATE FUNCTION radar_actionability(points jsonb, stage text, as_of date,
  OUT rank int, OUT tier text, OUT action_date date, OUT action_kind text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH p AS (
    SELECT e->>'kind' AS kind, (e->>'date')::date AS d FROM jsonb_array_elements(coalesce(points, '[]'::jsonb)) e
  ), ranked AS (
    SELECT CASE
             WHEN kind IN ('consultation_deadline', 'feedback_deadline') AND d >= as_of THEN 1
             WHEN kind IN ('vote', 'amendment_deadline') AND d >= as_of THEN 2
             WHEN kind = 'standstill_end' AND d >= as_of THEN 3
           END AS r, d, kind
    FROM p
  ), best AS (
    SELECT r, d, kind FROM ranked WHERE r IS NOT NULL ORDER BY r, d, kind LIMIT 1
  )
  SELECT coalesce(b.r, f.r), coalesce(b.t, f.t), b.d, b.kind
  FROM (SELECT CASE WHEN stage = 'adopted' THEN 5 WHEN stage = 'information' THEN 6 ELSE 4 END AS r,
               CASE WHEN stage = 'adopted' THEN 'adopted' WHEN stage = 'information' THEN 'information'
                    ELSE 'in_procedure' END AS t) f
  LEFT JOIN (SELECT r, CASE r WHEN 1 THEN 'open_window' WHEN 2 THEN 'upcoming_vote' ELSE 'standstill' END AS t,
                    d, kind FROM best) b ON true
$$;

CREATE FUNCTION verdict_rank(v "Verdict") RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE v WHEN 'relevant' THEN 2 WHEN 'borderline' THEN 1 ELSE 0 END
$$;

-- Latest version of every source item.
CREATE MATERIALIZED VIEW finding_current AS
SELECT DISTINCT ON (source_id, external_id) id, source_id, external_id, jurisdiction, published_on, created_at
FROM finding ORDER BY source_id, external_id, created_at DESC, id DESC;
CREATE UNIQUE INDEX finding_current_pk ON finding_current (id);
CREATE INDEX finding_current_order ON finding_current (published_on DESC, id);
CREATE INDEX finding_current_jurisdiction ON finding_current (jurisdiction, published_on DESC);
CREATE INDEX finding_current_source ON finding_current (source_id, published_on DESC);

-- Current procedure groups: latest non-retired snapshot + latest classification + first-seen time.
CREATE MATERIALIZED VIEW radar_group_current AS
WITH snap AS (
  SELECT DISTINCT ON (group_key) * FROM group_snapshot ORDER BY group_key, created_at DESC, id DESC
), first_seen AS (
  SELECT group_key, min(created_at) AS first_seen_at FROM group_snapshot GROUP BY group_key
), cls AS (
  SELECT DISTINCT ON (group_key) id, group_key, engine, why_relevant
  FROM classification ORDER BY group_key, created_at DESC, id DESC
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

-- Current relevance labels, indexed on (country, NACE path) for hierarchical lquery matching.
CREATE MATERIALIZED VIEW radar_label_current AS
SELECT g.group_key, l.country, l.nace_code, l.nace_path, l.verdict, verdict_rank(l.verdict) AS verdict_rank,
       l.score, l.rationale
FROM radar_group_current g JOIN relevance_label l ON l.classification_id = g.classification_id;
CREATE UNIQUE INDEX radar_label_current_pk ON radar_label_current (group_key, country, nace_code);
CREATE INDEX radar_label_current_match ON radar_label_current USING gist (country, nace_path);

CREATE FUNCTION refresh_read_models() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY finding_current;
  REFRESH MATERIALIZED VIEW CONCURRENTLY radar_group_current;
  REFRESH MATERIALIZED VIEW CONCURRENTLY radar_label_current;
END $$;

-- Global ingestion order: every raw record gets the next number in the order the sources stream it
-- (file order for the seed file). A procedure group is named after its member that was streamed first.
ALTER TABLE "raw_record" ADD COLUMN "stream_seq" BIGSERIAL NOT NULL;
CREATE INDEX "raw_record_source_id_external_id_stream_seq_idx" ON "raw_record"("source_id", "external_id", "stream_seq");

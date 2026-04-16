-- Create enum for event lifecycle
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'READY', 'LIVE', 'ENDED', 'ARCHIVED');

-- Core events table
CREATE TABLE "events" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "source_language" TEXT NOT NULL,
  "target_languages" JSONB NOT NULL,
  "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Subtitle segments per event
CREATE TABLE "subtitle_segments" (
  "id" BIGSERIAL PRIMARY KEY,
  "event_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_text" TEXT NOT NULL,
  "translations" JSONB NOT NULL,
  "is_final" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "subtitle_segments_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "subtitle_segments_event_id_seq_key"
  ON "subtitle_segments"("event_id", "seq");

CREATE INDEX "subtitle_segments_event_id_ts_idx"
  ON "subtitle_segments"("event_id", "ts");

-- TLDW — D1 schema for cached video summaries.
--
-- One row per YouTube video. The Worker checks this table BEFORE calling
-- Supadata or the LLM, so a repeat request for the same video is free and
-- instant (this cache is the main cost saver).
--
-- Columns:
--   video_id      canonical 11-char YouTube id ([A-Za-z0-9_-]{11}) — primary key
--   summary_json  the full {tldr, keyPoints, cheatSheet} object stored as a JSON string
--   created_at    Unix epoch millis (Date.now()) when the summary was cached
--
-- Apply with:  wrangler d1 execute tldw-cache --file=schema.sql   (add --local for local dev)

CREATE TABLE IF NOT EXISTS summaries (
  video_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

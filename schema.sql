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

-- Daily global circuit breaker: one row per UTC day counting how many UNCACHED
-- summaries were generated that day. The Worker reads this after the cache
-- check and refuses new generations once the count hits DAILY_CAP (a gentle
-- app-wide backstop on top of the per-IP rate limiter). Cache hits never count.
--
-- Columns:
--   day    UTC date string "YYYY-MM-DD" (e.g. "2026-06-29") — primary key
--   count  number of freshly generated summaries on that day
CREATE TABLE IF NOT EXISTS daily_usage (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

ALTER TABLE contests ADD COLUMN judging_started_at TEXT;
ALTER TABLE submissions ADD COLUMN content_hash TEXT;
ALTER TABLE submissions ADD COLUMN duration_seconds REAL;

CREATE TABLE IF NOT EXISTS submission_hashes (
  content_hash TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  creator TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS submission_hashes_contest_idx ON submission_hashes(contest_id, created_at);

INSERT OR IGNORE INTO submission_hashes (content_hash,submission_id,contest_id,creator,version,created_at)
SELECT
  json_extract(payload_json,'$.contentHash'),
  json_extract(payload_json,'$.submissionId'),
  contest_id,
  actor,
  CAST(COALESCE(json_extract(payload_json,'$.version'),1) AS INTEGER),
  created_at
FROM events
WHERE event_type='SUBMISSION_UPLOADED'
  AND json_valid(payload_json)
  AND length(json_extract(payload_json,'$.contentHash'))=64;

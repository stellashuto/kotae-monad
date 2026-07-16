CREATE TABLE IF NOT EXISTS contests (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  title TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  brief TEXT NOT NULL,
  must_json TEXT NOT NULL DEFAULT '[]',
  avoid_json TEXT NOT NULL DEFAULT '[]',
  budget_micros INTEGER NOT NULL,
  valid_cap INTEGER NOT NULL,
  submission_deadline TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  tx_hash TEXT,
  winner_submission_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  contest_id TEXT NOT NULL REFERENCES contests(id),
  creator TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  file_key TEXT NOT NULL,
  preview_key TEXT,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  bond_micros INTEGER NOT NULL,
  eligibility TEXT NOT NULL DEFAULT 'CHECKING',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  ai_message TEXT,
  submitted_at TEXT NOT NULL,
  UNIQUE(contest_id, creator)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

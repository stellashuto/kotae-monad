ALTER TABLE contests ADD COLUMN chain_contest_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS contests_chain_id_idx ON contests(chain_contest_id) WHERE chain_contest_id IS NOT NULL;

ALTER TABLE submissions ADD COLUMN chain_submission_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_chain_id_idx ON submissions(chain_submission_id) WHERE chain_submission_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_challenges (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  origin TEXT NOT NULL,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_challenges_address_idx ON wallet_challenges(address, expires_at);

CREATE TABLE IF NOT EXISTS wallet_sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_sessions_address_idx ON wallet_sessions(address, expires_at);

CREATE TABLE IF NOT EXISTS chain_transactions (
  tx_hash TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  contest_id TEXT,
  block_number TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

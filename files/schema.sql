-- Neo-Sight AI / Saaf Nazar Initiative
-- D1 Database Schema

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  city TEXT,
  ip_hash TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_state ON submissions(state);
CREATE INDEX IF NOT EXISTS idx_created ON submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_dedup ON submissions(ip_hash, name, state);

-- Stats cache table (alternative to KV)
CREATE TABLE IF NOT EXISTS stats_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Additive: leaves the existing email waitlist and any legacy demo tables intact.
CREATE TABLE IF NOT EXISTS pledges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  dedup_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 50),
  state TEXT NOT NULL,
  city TEXT CHECK(city IS NULL OR length(city) <= 50),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS pledge_totals (
  state TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0)
);

CREATE TRIGGER IF NOT EXISTS pledges_count_insert AFTER INSERT ON pledges
BEGIN
  INSERT INTO pledge_totals (state, count) VALUES (NEW.state, 1)
  ON CONFLICT(state) DO UPDATE SET count = count + 1;
END;

CREATE TRIGGER IF NOT EXISTS pledges_count_delete AFTER DELETE ON pledges
BEGIN
  UPDATE pledge_totals SET count = count - 1 WHERE state = OLD.state;
END;

CREATE TABLE IF NOT EXISTS pledge_rate_limits (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pledge_rate_expiry ON pledge_rate_limits(window_start);

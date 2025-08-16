CREATE TABLE IF NOT EXISTS weight (
  uuid TEXT PRIMARY KEY,
  startDate TEXT NOT NULL,      -- ISO 8601 UTC
  endDate   TEXT NOT NULL,      -- ISO 8601 UTC
  kg        REAL NOT NULL,      -- canonical unit
  sourceBundleId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

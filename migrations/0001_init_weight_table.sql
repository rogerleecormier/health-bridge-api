-- migrations/0001_init_weight_table.sql
CREATE TABLE IF NOT EXISTS weight (
  uuid           TEXT PRIMARY KEY,
  startDate      TEXT NOT NULL,
  endDate        TEXT NOT NULL,
  kg             REAL NOT NULL,
  sourceBundleId TEXT NOT NULL,
  createdAt      TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt      TEXT NOT NULL DEFAULT (datetime('now'))
);

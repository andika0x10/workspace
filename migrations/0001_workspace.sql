CREATE TABLE workspaces (id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE boards (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id),
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX cards_board ON cards(board_id);
CREATE TABLE device_state (
  device_id TEXT NOT NULL, board_id TEXT NOT NULL, data TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(device_id, board_id)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_limits (
  ip_hash TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0, request_window INTEGER NOT NULL
);
CREATE TABLE mutation_receipts (
  id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL
);

export const schemaVersion = 1;

export const applicationSchema = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT,
    model TEXT, model_config TEXT, system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT,
    message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
    cwd TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
    title TEXT, api_call_count INTEGER DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT,
    tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
    timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT,
    reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT,
    platform_message_id TEXT, observed INTEGER DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS compression_locks (
    session_id TEXT PRIMARY KEY, holder TEXT NOT NULL,
    acquired_at REAL NOT NULL, expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_node_cache (
    content_hash TEXT NOT NULL,
    run_id       TEXT NOT NULL,
    node_id      TEXT NOT NULL,
    output_json  TEXT,
    status       TEXT NOT NULL,
    updated_at   REAL NOT NULL,
    PRIMARY KEY (run_id, content_hash)
);
CREATE TABLE IF NOT EXISTS workflow_node_cost (
    run_id       TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens   INTEGER DEFAULT 0,
    PRIMARY KEY (run_id, content_hash)
);
CREATE TABLE IF NOT EXISTS workflow_run_spend (
    run_id       TEXT PRIMARY KEY,
    token_budget INTEGER,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens   INTEGER DEFAULT 0,
    updated_at   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_run_state (
    run_id       TEXT PRIMARY KEY,
    name         TEXT,
    owner        TEXT,
    status       TEXT NOT NULL,
    pause_reason TEXT,
    pause_payload_json TEXT,
    spec_json    TEXT,
    args_json    TEXT,
    token_budget INTEGER,
    tainted      INTEGER NOT NULL DEFAULT 0,
    progress_json TEXT,
    audit_segment_id TEXT,
    updated_at   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_run_locks (
    run_id TEXT PRIMARY KEY, holder TEXT NOT NULL,
    acquired_at REAL NOT NULL, expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_run_fence (
    run_id TEXT PRIMARY KEY, fence INTEGER NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, active, id);
CREATE INDEX IF NOT EXISTS idx_wnc_content ON workflow_node_cache(content_hash);
CREATE INDEX IF NOT EXISTS idx_wnc_run ON workflow_node_cache(run_id);
CREATE INDEX IF NOT EXISTS idx_wrs_updated ON workflow_run_state(updated_at);
CREATE TABLE IF NOT EXISTS workflow_audit_order (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_value INTEGER NOT NULL
);
INSERT OR IGNORE INTO workflow_audit_order (singleton, next_value) VALUES (1, 1);
CREATE TABLE IF NOT EXISTS workflow_audit_state (
    run_id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 1,
    touch_order INTEGER NOT NULL, retained_events INTEGER NOT NULL DEFAULT 0,
    retention_dropped INTEGER NOT NULL DEFAULT 0, dropped_before_seq INTEGER,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_audit_tombstones (
    run_id TEXT PRIMARY KEY, reason TEXT NOT NULL,
    next_seq INTEGER NOT NULL, evicted_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_audit_events (
    run_id TEXT NOT NULL, seq INTEGER NOT NULL, segment_id TEXT, node_id TEXT,
    sub_id TEXT, attempt INTEGER, event_type TEXT NOT NULL, provenance TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at REAL NOT NULL,
    PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_was_updated ON workflow_audit_state(updated_at);
DROP INDEX IF EXISTS idx_wae_run_node;
DROP INDEX IF EXISTS idx_wae_run_sub;
`;

export const addedColumns = [
  ["sessions", "priced_call_count", "INTEGER"],
  ["workflow_run_state", "progress_json", "TEXT"],
  ["workflow_run_state", "audit_segment_id", "TEXT"],
  ["workflow_audit_events", "attempt", "INTEGER"],
  ["workflow_node_cost", "cache_read_tokens", "INTEGER DEFAULT 0"],
  ["workflow_node_cost", "cache_write_tokens", "INTEGER DEFAULT 0"],
  ["workflow_node_cost", "reasoning_tokens", "INTEGER DEFAULT 0"],
  ["workflow_run_spend", "cache_read_tokens", "INTEGER DEFAULT 0"],
  ["workflow_run_spend", "cache_write_tokens", "INTEGER DEFAULT 0"],
  ["workflow_run_spend", "reasoning_tokens", "INTEGER DEFAULT 0"],
] as const;

export const ftsSchema = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, session_id UNINDEXED, message_id UNINDEXED
);
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(content, session_id, message_id)
    VALUES (
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '') || ' '
            || COALESCE(new.tool_calls, ''),
        new.session_id, new.id
    );
END;
`;

export const ftsBackfill = `
INSERT INTO messages_fts(content, session_id, message_id)
SELECT COALESCE(content, '') || ' ' || COALESCE(tool_name, '') || ' '
           || COALESCE(tool_calls, ''),
       session_id, id
FROM messages;
`;

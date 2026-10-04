CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS events (
    project_id VARCHAR NOT NULL,
    event_id UUID NOT NULL,
    session_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name VARCHAR NOT NULL,
    screen VARCHAR,
    platform VARCHAR NOT NULL,
    app_version VARCHAR NOT NULL,
    properties JSON NOT NULL,
    payload_hash VARCHAR NOT NULL,
    PRIMARY KEY (project_id, event_id)
);

CREATE TABLE IF NOT EXISTS schema_version (
    id UInt8,
    version UInt32
) ENGINE = ReplacingMergeTree ORDER BY id;

CREATE TABLE IF NOT EXISTS events (
    project_id String,
    event_id UUID,
    session_id UUID,
    occurred_at DateTime64(3, 'UTC'),
    received_at DateTime64(3, 'UTC') DEFAULT now64(3),
    name LowCardinality(String),
    screen Nullable(String),
    platform LowCardinality(String),
    app_version String,
    properties String,
    payload_hash FixedString(64)
) ENGINE = ReplacingMergeTree
ORDER BY (project_id, event_id);

ALTER TABLE events ADD COLUMN IF NOT EXISTS category LowCardinality(String) DEFAULT 'uncategorized';

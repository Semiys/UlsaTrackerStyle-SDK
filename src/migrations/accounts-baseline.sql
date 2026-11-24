CREATE TABLE IF NOT EXISTS metadata_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
  csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL, platform TEXT NOT NULL, identifier TEXT NOT NULL, created_at INTEGER NOT NULL, deleting_at INTEGER);
CREATE TABLE IF NOT EXISTS ingest_keys (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id),
  hash TEXT NOT NULL UNIQUE, display TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS grafana_owners (owner_id TEXT PRIMARY KEY REFERENCES owners(id), org_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS apps_project ON applications(project_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

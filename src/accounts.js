import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createHmac, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { chmodSync, openSync, closeSync } from 'node:fs';
import { ApiError } from './errors.js';

const scrypt = promisify(scryptCallback);
export const digest = value => createHash('sha256').update(value).digest('hex');
const id = prefix => prefix + randomUUID().replaceAll('-', '');
const token = () => randomBytes(32).toString('base64url');
const publicUser = row => row && ({ id: row.id, name: row.name, email: row.email });
const text = (value, label, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new ApiError(400, 'invalid_input', `${label}: от 1 до ${max} символов.`);
  return value.trim();
};

export class AccountStore {
  constructor(path) {
    if (path !== ':memory:') { closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600); }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
        name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, platform TEXT NOT NULL, identifier TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_keys (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id),
        hash TEXT NOT NULL UNIQUE, display TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS grafana_owners (owner_id TEXT PRIMARY KEY REFERENCES owners(id), org_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
      CREATE INDEX IF NOT EXISTS apps_project ON applications(project_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
    const version = this.db.prepare('SELECT version FROM metadata_version').all();
    if (!version.length) this.db.prepare('INSERT INTO metadata_version VALUES (1)').run();
    else if (version.length !== 1 || version[0].version !== 1) { this.db.close(); throw new Error('Unsupported account database schema'); }
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('master_secret', token());
    this.secret = this.db.prepare('SELECT value FROM settings WHERE name=?').get('master_secret').value;
    this.passwordWork = 0;
    if (path !== ':memory:') chmodSync(path, 0o600);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  derive(label) { return createHmac('sha256', this.secret).update(label).digest('hex'); }
  async password(value, salt) {
    if (this.passwordWork >= 4) throw new ApiError(503, 'auth_busy', 'Вход временно занят. Повторите позже.');
    this.passwordWork++;
    try { return Buffer.from(await scrypt(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 })).toString('hex'); }
    finally { this.passwordWork--; }
  }

  async register({ name, email, password }) {
    name = text(name, 'Имя', 80);
    email = text(email, 'Электронная почта', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'invalid_email', 'Проверьте адрес электронной почты.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new ApiError(400, 'invalid_password', 'Пароль: от 12 до 128 символов.');
    const salt = token();
    const hash = await this.password(password, salt);
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM owners WHERE email=?').get(email)) throw new ApiError(409, 'account_exists', 'Не удалось создать учётную запись с этим адресом. Попробуйте войти.');
      if (this.db.prepare('SELECT count(*) AS n FROM owners').get().n >= 1000) throw new ApiError(429, 'account_limit', 'Лимит учётных записей этого стенда достигнут.');
      const owner = { id: id('u_'), name, email };
      this.db.prepare('INSERT INTO owners VALUES (?, ?, ?, ?, ?, ?)').run(owner.id, name, email, hash, salt, Date.now());
      return owner;
    });
  }

  async login(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 128) throw new ApiError(401, 'invalid_login', 'Неверная почта или пароль.');
    const owner = this.db.prepare('SELECT * FROM owners WHERE email=?').get(email.trim().toLowerCase());
    const hash = await this.password(password, owner?.salt ?? this.derive('dummy-salt'));
    if (!owner || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(owner.password_hash, 'hex'))) throw new ApiError(401, 'invalid_login', 'Неверная почта или пароль.');
    return publicUser(owner);
  }

  createSession(ownerId) {
    const raw = token(), csrf = token(), expires = Date.now() + 7 * 86400_000;
    return this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
      this.db.prepare('DELETE FROM sessions WHERE owner_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE owner_id=? ORDER BY expires_at DESC LIMIT 9)').run(ownerId, ownerId);
      this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(digest(raw), ownerId, csrf, expires);
      return { raw, csrf, expires };
    });
  }
  session(raw) {
    if (!/^[\w-]{43}$/.test(raw ?? '')) return null;
    const row = this.db.prepare(`SELECT s.csrf, s.expires_at, o.id, o.name, o.email FROM sessions s
      JOIN owners o ON o.id=s.owner_id WHERE s.hash=? AND s.expires_at>?`).get(digest(raw), Date.now());
    return row ? { user: publicUser(row), csrf: row.csrf } : null;
  }
  logout(raw) { if (raw) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(raw)); }

  projects(ownerId) {
    return this.db.prepare(`SELECT p.*, (SELECT count(*) FROM applications a WHERE a.project_id=p.id) AS applications
      FROM projects p WHERE owner_id=? ORDER BY created_at DESC, id`).all(ownerId);
  }
  project(ownerId, projectId) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').get(projectId, ownerId);
    if (!row) throw new ApiError(404, 'not_found', 'Проект не найден.');
    return row;
  }
  createProject(ownerId, name) {
    name = text(name, 'Название проекта');
    return this.transaction(() => {
      if (this.projects(ownerId).length >= 30) throw new ApiError(429, 'project_limit', 'На стенде доступно до 30 проектов владельца.');
      const projectId = id('p_');
      this.db.prepare('INSERT INTO projects (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(projectId, ownerId, name, Date.now());
      return this.project(ownerId, projectId);
    });
  }
  updateProject(ownerId, projectId, name, archived) {
    this.project(ownerId, projectId);
    this.db.prepare('UPDATE projects SET name=?, archived=? WHERE id=? AND owner_id=?').run(text(name, 'Название проекта'), archived ? 1 : 0, projectId, ownerId);
    return this.project(ownerId, projectId);
  }
  applications(ownerId, projectId) {
    this.project(ownerId, projectId);
    return this.db.prepare('SELECT * FROM applications WHERE project_id=? ORDER BY created_at, id').all(projectId);
  }
  ownerApplications(ownerId) {
    return this.db.prepare(`SELECT a.*, p.archived, p.owner_id, p.name AS project_name FROM applications a
      JOIN projects p ON p.id=a.project_id WHERE p.owner_id=? ORDER BY a.created_at`).all(ownerId);
  }
  application(ownerId, appId) {
    const row = this.db.prepare(`SELECT a.*, p.owner_id, p.archived, p.name AS project_name FROM applications a
      JOIN projects p ON p.id=a.project_id WHERE a.id=? AND p.owner_id=?`).get(appId, ownerId);
    if (!row) throw new ApiError(404, 'not_found', 'Приложение не найдено.');
    return row;
  }
  createApplication(ownerId, projectId, { name, platform, identifier }) {
    const project = this.project(ownerId, projectId);
    if (project.archived) throw new ApiError(409, 'project_archived', 'Сначала восстановите проект из архива.');
    name = text(name, 'Название приложения'); identifier = text(identifier, 'Идентификатор приложения', 200);
    if (!['android', 'ios', 'web'].includes(platform)) throw new ApiError(400, 'invalid_platform', 'Выберите Android, Web или iOS.');
    if (platform === 'web') {
      try {
        const url = new URL(identifier);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
        identifier = url.origin;
      } catch { throw new ApiError(400, 'invalid_origin', 'Для сайта укажите origin без пути: https://example.com или http://localhost:8080.'); }
    } else if (!/^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/.test(identifier)) throw new ApiError(400, 'invalid_identifier', 'Укажите package name или bundle ID, например com.example.app.');
    return this.transaction(() => {
      if (this.applications(ownerId, projectId).length >= 20) throw new ApiError(429, 'app_limit', 'На стенде доступно до 20 приложений проекта.');
      const appId = id('a_');
      this.db.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?)').run(appId, projectId, name, platform, identifier, Date.now());
      return { application: this.application(ownerId, appId), key: this.issueKey(appId) };
    });
  }
  keys(ownerId, appId) {
    this.application(ownerId, appId);
    return this.db.prepare('SELECT id, display, created_at, revoked_at FROM ingest_keys WHERE app_id=? ORDER BY created_at DESC, id').all(appId);
  }
  issueKey(appId) {
    const raw = 'ulsa_' + randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO ingest_keys (id, app_id, hash, display, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id('k_'), appId, digest(raw), raw.slice(0, 12) + '…' + raw.slice(-4), Date.now());
    return raw;
  }
  rotateKey(ownerId, appId) {
    const app = this.application(ownerId, appId);
    if (app.archived) throw new ApiError(409, 'project_archived', 'Сначала восстановите проект.');
    return this.transaction(() => {
      this.db.prepare('UPDATE ingest_keys SET revoked_at=? WHERE app_id=? AND revoked_at IS NULL').run(Date.now(), appId);
      return this.issueKey(appId);
    });
  }
  revokeKey(ownerId, appId, keyId) {
    this.application(ownerId, appId);
    this.db.prepare('UPDATE ingest_keys SET revoked_at=? WHERE id=? AND app_id=? AND revoked_at IS NULL').run(Date.now(), keyId, appId);
  }
  resolveKey(raw) {
    if (typeof raw !== 'string' || !/^ulsa_[a-f0-9]{64}$/.test(raw)) return null;
    return this.db.prepare(`SELECT a.*, k.id AS key_id, p.owner_id FROM ingest_keys k
      JOIN applications a ON a.id=k.app_id JOIN projects p ON p.id=a.project_id
      WHERE k.hash=? AND k.revoked_at IS NULL AND p.archived=0`).get(digest(raw)) ?? null;
  }
  hasWebOrigin(origin) {
    return !!this.db.prepare(`SELECT 1 FROM applications a JOIN projects p ON p.id=a.project_id
      JOIN ingest_keys k ON k.app_id=a.id WHERE a.platform='web' AND a.identifier=? AND p.archived=0 AND k.revoked_at IS NULL LIMIT 1`).get(origin);
  }
  grafanaOwner(ownerId) { return this.db.prepare('SELECT * FROM grafana_owners WHERE owner_id=?').get(ownerId); }
  setGrafanaOwner(ownerId, orgId, userId) {
    this.db.prepare('INSERT OR REPLACE INTO grafana_owners VALUES (?, ?, ?)').run(ownerId, orgId, userId);
  }
  close() { this.db.close(); }
}

export class WindowLimiter {
  constructor(limit, windowMs, maxEntries = 5000) { Object.assign(this, { limit, windowMs, maxEntries }); this.entries = new Map(); }
  take(key, now = Date.now()) {
    if (this.entries.size >= this.maxEntries) {
      for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
      if (!this.entries.has(key) && this.entries.size >= this.maxEntries) return 60;
    }
    let value = this.entries.get(key);
    if (!value || value.until <= now) { value = { count: 0, until: now + this.windowMs }; this.entries.set(key, value); }
    value.count++;
    return value.count > this.limit ? Math.max(1, Math.ceil((value.until - now) / 1000)) : 0;
  }
}

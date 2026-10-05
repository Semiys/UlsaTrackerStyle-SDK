import { open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { validateBatch } from './events.js';

const MAX_EVENTS = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
const keyOf = (projectId, eventId) => JSON.stringify([projectId, eventId]);
const compare = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : Buffer.compare(Buffer.from(a), Buffer.from(b));

export class JsonAnalyticsStore {
  static async open(path) {
    let rows = [];
    try {
      if ((await stat(path)).size > MAX_BYTES) throw new Error('JSON storage exceeds the teaching limit');
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (data.schemaVersion !== 1 || !Array.isArray(data.events) || data.events.length > MAX_EVENTS) throw new Error('Unsupported JSON storage format');
      rows = data.events.map(row => {
        const { projectId, receivedAt, payloadHash, ...source } = row;
        if (typeof projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId)
            || typeof receivedAt !== 'string' || !Number.isFinite(Date.parse(receivedAt))) throw new Error('Invalid stored event');
        // Age limits apply to incoming packets, not to data already saved on disk.
        const [event] = validateBatch({ schemaVersion: 1, events: [source] }, Date.parse(source.occurredAt));
        if (event.payloadHash !== payloadHash) throw new Error('Stored event checksum does not match');
        return { projectId, receivedAt, ...event };
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const records = new Map(rows.map(row => [keyOf(row.projectId, row.eventId), row]));
    if (records.size !== rows.length) throw new Error('Duplicate IDs in JSON storage');
    return new JsonAnalyticsStore(path, records);
  }

  constructor(path, records) {
    this.path = path;
    this.records = records;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.closed = false;
  }

  execute(operation) {
    if (this.closed || this.pending >= 32) return Promise.reject(new ApiError(503, 'server_busy', 'Сервер занят. Повторите пакет позже.'));
    this.pending++;
    const result = this.tail.then(operation).finally(() => this.pending--);
    this.tail = result.catch(() => {});
    return result;
  }

  async persist(records) {
    const json = JSON.stringify({ schemaVersion: 1, events: [...records.values()] }) + '\n';
    if (records.size > MAX_EVENTS || Buffer.byteLength(json) > MAX_BYTES) {
      throw new ApiError(507, 'storage_limit', 'Учебное JSON-хранилище заполнено. Предел: 10 000 событий или 16 МиБ.');
    }
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporaryPath, 'wx', 0o600);
      await file.writeFile(json, 'utf8');
      await file.sync();
      await file.close(); file = null;
      await rename(temporaryPath, this.path);
      // The image runs on Linux; sync the directory entry before acknowledging.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      if (file) await file.close();
      await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  ingest(projectId, events) {
    return this.execute(async () => {
      const unique = [...new Map(events.map(event => [event.eventId, event])).values()];
      for (const event of unique) {
        const saved = this.records.get(keyOf(projectId, event.eventId));
        if (saved && saved.payloadHash !== event.payloadHash) throw new ApiError(409, 'event_id_conflict', 'eventId уже сохранён с другим содержимым. Весь пакет отклонён.');
      }
      const next = new Map(this.records);
      const receivedAt = new Date().toISOString();
      let accepted = 0;
      for (const event of unique) {
        const key = keyOf(projectId, event.eventId);
        if (!next.has(key)) { next.set(key, { projectId, receivedAt, ...structuredClone(event) }); accepted++; }
      }
      if (accepted) {
        await this.persist(next);
        this.records = next;
      }
      return { accepted, duplicates: events.length - accepted, acknowledgedEventIds: unique.map(event => event.eventId) };
    });
  }

  stats(projectId, days, now = new Date()) {
    return this.execute(() => {
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const from = new Date(today - (days - 1) * 86_400_000).toISOString();
      const until = new Date(today + 86_400_000).toISOString();
      const rows = [...this.records.values()].filter(row => row.projectId === projectId && row.occurredAt >= from && row.occurredAt < until);
      const groups = (events, keys) => {
        const map = new Map();
        for (const row of events) {
          const values = keys.map(key => {
            if (key !== 'button' && key !== 'action') return row[key];
            const value = row.properties[key];
            return typeof value === 'string' ? value.trim() || null : null;
          });
          const id = JSON.stringify(values);
          const group = map.get(id) ?? { ...Object.fromEntries(keys.map((key, i) => [key, values[i]])), count: 0 };
          group.count++; map.set(id, group);
        }
        return [...map.values()].sort((a, b) => {
          if (a.count !== b.count) return b.count - a.count;
          for (const key of keys) { const result = compare(a[key], b[key]); if (result) return result; }
          return 0;
        });
      };
      const views = rows.filter(row => row.name === 'screen_view');
      const buttons = rows.filter(row => row.name === 'button_click');
      const actions = rows.filter(row => row.name === 'action_success');
      const breakdowns = {
        byName: groups(rows, ['name']), byScreen: groups(rows.filter(row => row.screen !== null), ['screen']),
        byScreenViews: groups(views, ['screen']), byButton: groups(buttons, ['button', 'screen']), byAction: groups(actions, ['action', 'screen']),
      };
      const counts = new Map();
      for (const row of rows) { const date = row.occurredAt.slice(0, 10); counts.set(date, (counts.get(date) ?? 0) + 1); }
      const breakdownLimit = 100;
      return {
        days, timezone: 'UTC', from, until,
        totals: { events: rows.length, sessions: new Set(rows.map(row => row.sessionId)).size,
          screenViews: views.length, buttonClicks: buttons.length, successfulActions: actions.length },
        breakdownLimit,
        truncated: Object.fromEntries(Object.entries(breakdowns).map(([name, values]) => [name, values.length > breakdownLimit])),
        ...Object.fromEntries(Object.entries(breakdowns).map(([name, values]) => [name, values.slice(0, breakdownLimit)])),
        daily: Array.from({ length: days }, (_, i) => {
          const date = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
          return { date, count: counts.get(date) ?? 0 };
        }),
      };
    });
  }

  recent(projectId, limit = 50) {
    return this.execute(() => [...this.records.values()].filter(row => row.projectId === projectId)
      .sort((a, b) => compare(b.receivedAt, a.receivedAt) || compare(a.eventId, b.eventId)).slice(0, limit)
      .map(({ projectId: _, payloadHash, ...event }) => structuredClone(event)));
  }

  async close() { this.closed = true; await this.tail; }
}

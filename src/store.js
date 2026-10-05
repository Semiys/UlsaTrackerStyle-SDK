import { readFile } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import { ApiError } from './errors.js';

export class AnalyticsStore {
  static async open(path) {
    const instance = await DuckDBInstance.create(path, { threads: '2', memory_limit: '128MB' });
    const connection = await instance.connect();
    try {
      await connection.run("SET TimeZone = 'UTC'");
      const existing = (await connection.runAndReadAll("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = 'schema_version'")).getRows();
      if (existing[0][0] > 0) {
        const version = (await connection.runAndReadAll('SELECT version FROM schema_version')).getRows();
        if (version.length !== 1 || version[0][0] !== 1) throw new Error('Unsupported analytics database schema');
      }
      await connection.run(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      const version = (await connection.runAndReadAll('SELECT version FROM schema_version')).getRows();
      if (version.length !== 1 || version[0][0] !== 1) throw new Error('Unsupported analytics database schema');
      return new AnalyticsStore(instance, connection);
    } catch (error) {
      connection.closeSync();
      instance.closeSync();
      throw error;
    }
  }

  constructor(instance, connection) {
    this.instance = instance;
    this.connection = connection;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.closed = false;
  }

  // A single connection owns transactions; batches must not interleave on it.
  execute(operation) {
    if (this.closed || this.pending >= 32) return Promise.reject(new ApiError(503, 'server_busy', 'Сервер занят. Повторите пакет позже.'));
    this.pending++;
    const result = this.tail.then(operation).finally(() => this.pending--);
    this.tail = result.catch(() => {});
    return result;
  }

  ingest(projectId, events) {
    return this.execute(async () => {
      const unique = [...new Map(events.map(e => [e.eventId, e])).values()];
      const parameters = { project: projectId };
      const types = ['UUID', 'UUID', 'TIMESTAMPTZ', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'VARCHAR', 'JSON', 'VARCHAR'];
      const tuples = unique.map((e, i) => {
        const values = [e.eventId, e.sessionId, e.occurredAt, e.name, e.screen, e.platform, e.appVersion, JSON.stringify(e.properties), e.payloadHash];
        return '(' + values.map((value, j) => {
          const key = `p${i}_${j}`;
          parameters[key] = value;
          return `$${key}::${types[j]}`;
        }).join(', ') + ')';
      });
      const incoming = `WITH incoming(event_id, session_id, occurred_at, name, screen, platform, app_version, properties, payload_hash) AS (VALUES ${tuples.join(', ')})`;
      await this.connection.run('BEGIN TRANSACTION');
      try {
        const conflict = await this.connection.runAndReadAll(`${incoming}
          SELECT incoming.event_id FROM incoming JOIN events USING (event_id)
          WHERE events.project_id = $project AND events.payload_hash <> incoming.payload_hash LIMIT 1`, parameters);
        if (conflict.getRows().length) throw new ApiError(409, 'event_id_conflict', 'eventId уже сохранён с другим содержимым. Весь пакет отклонён.');
        const inserted = await this.connection.runAndReadAll(`${incoming}
          INSERT INTO events(project_id, event_id, session_id, occurred_at, name, screen, platform, app_version, properties, payload_hash)
          SELECT $project, * FROM incoming ON CONFLICT DO NOTHING RETURNING event_id`, parameters);
        const accepted = inserted.getRows().length;
        await this.connection.run('COMMIT');
        return { accepted, duplicates: events.length - accepted, acknowledgedEventIds: unique.map(e => e.eventId) };
      } catch (error) {
        await this.connection.run('ROLLBACK');
        throw error;
      }
    });
  }

  stats(projectId, days, now = new Date()) {
    return this.execute(async () => {
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const from = new Date(today - (days - 1) * 86_400_000).toISOString();
      const until = new Date(today + 86_400_000).toISOString();
      const parameters = { project: projectId, from, until };
      const filter = 'WHERE project_id = $project AND occurred_at >= $from::TIMESTAMPTZ AND occurred_at < $until::TIMESTAMPTZ';
      const rows = async sql => (await this.connection.runAndReadAll(sql, parameters)).getRowObjects();
      const breakdownLimit = 100;
      const [totals] = await rows(`SELECT count(*) AS events, count(DISTINCT session_id) AS sessions,
        count(*) FILTER (WHERE name = 'screen_view') AS screen_views,
        count(*) FILTER (WHERE name = 'button_click') AS button_clicks,
        count(*) FILTER (WHERE name = 'action_success') AS successful_actions
        FROM events ${filter}`);
      const byName = await rows(`SELECT name, count(*) AS count FROM events ${filter} GROUP BY name ORDER BY count DESC, name LIMIT 101`);
      const byScreen = await rows(`SELECT screen, count(*) AS count FROM events ${filter} AND screen IS NOT NULL GROUP BY screen ORDER BY count DESC, screen LIMIT 101`);
      const byScreenViews = await rows(`SELECT screen, count(*) AS count FROM events ${filter}
        AND name = 'screen_view' GROUP BY screen ORDER BY count DESC, screen NULLS LAST LIMIT 101`);
      // Only strings identify a button/action; missing or wrongly typed properties stay visible as null.
      const byButton = await rows(`SELECT
        CASE WHEN json_type(properties, '$.button') = 'VARCHAR'
          THEN nullif(trim(json_extract_string(properties, '$.button')), '') END AS button,
        screen, count(*) AS count FROM events ${filter} AND name = 'button_click'
        GROUP BY button, screen ORDER BY count DESC, button NULLS LAST, screen NULLS LAST LIMIT 101`);
      const byAction = await rows(`SELECT
        CASE WHEN json_type(properties, '$.action') = 'VARCHAR'
          THEN nullif(trim(json_extract_string(properties, '$.action')), '') END AS action,
        screen, count(*) AS count FROM events ${filter} AND name = 'action_success'
        GROUP BY action, screen ORDER BY count DESC, action NULLS LAST, screen NULLS LAST LIMIT 101`);
      const buckets = await rows(`SELECT strftime(occurred_at, '%Y-%m-%d') AS date, count(*) AS count FROM events ${filter} GROUP BY date ORDER BY date`);
      const number = value => {
        const result = Number(value);
        if (!Number.isSafeInteger(result)) throw new Error('Analytics count exceeds JSON integer precision');
        return result;
      };
      const counts = new Map(buckets.map(row => [row.date, number(row.count)]));
      const groups = { byName, byScreen, byScreenViews, byButton, byAction };
      return {
        days, timezone: 'UTC', from, until,
        totals: {
          events: number(totals.events), sessions: number(totals.sessions),
          screenViews: number(totals.screen_views), buttonClicks: number(totals.button_clicks),
          successfulActions: number(totals.successful_actions),
        },
        breakdownLimit,
        truncated: Object.fromEntries(Object.entries(groups).map(([name, values]) => [name, values.length > breakdownLimit])),
        ...Object.fromEntries(Object.entries(groups).map(([name, values]) => [
          name, values.slice(0, breakdownLimit).map(row => ({ ...row, count: number(row.count) })),
        ])),
        daily: Array.from({ length: days }, (_, i) => {
          const date = new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
          return { date, count: counts.get(date) ?? 0 };
        }),
      };
    });
  }

  recent(projectId, limit = 50) {
    return this.execute(async () => {
      const result = await this.connection.runAndReadAll(`SELECT event_id, session_id, occurred_at, received_at,
        name, screen, platform, app_version, properties FROM events WHERE project_id = $project
        ORDER BY received_at DESC, event_id LIMIT $limit`, { project: projectId, limit });
      return result.getRowObjects().map(row => ({
        eventId: String(row.event_id), sessionId: String(row.session_id),
        occurredAt: new Date(row.occurred_at.toString()).toISOString(), receivedAt: new Date(row.received_at.toString()).toISOString(),
        name: row.name, screen: row.screen, platform: row.platform, appVersion: row.app_version,
        properties: JSON.parse(row.properties),
      }));
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    try { await this.connection.run('CHECKPOINT'); }
    finally {
      this.connection.closeSync();
      this.instance.closeSync();
    }
  }
}

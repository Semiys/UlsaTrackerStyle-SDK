import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
import { ApiError } from './errors.js';

const integer = value => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Analytics count exceeds JSON integer precision');
  return result;
};

export class ClickHouseAnalyticsStore {
  static async open(options) {
    const client = createClient({ ...options, request_timeout: 10_000, max_open_connections: 1,
      clickhouse_settings: { max_threads: 2, date_time_input_format: 'best_effort', async_insert: 0 } });
    const store = new ClickHouseAnalyticsStore(client);
    try {
      const schema = await readFile(new URL('./clickhouse-schema.sql', import.meta.url), 'utf8');
      for (const query of schema.split(';').map(s => s.trim()).filter(Boolean)) await client.command({ query });
      const versions = await store.rows('SELECT version FROM schema_version FINAL');
      if (!versions.length) await client.insert({ table: 'schema_version', values: [{ id: 1, version: 1 }], format: 'JSONEachRow' });
      else if (versions.length !== 1 || Number(versions[0].version) !== 1) throw new Error('Unsupported analytics database schema');
      return store;
    } catch (error) { await client.close(); throw error; }
  }

  constructor(client) {
    this.client = client;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.closed = false;
  }

  // One application process owns ingestion in Lab 3. This is not a distributed lock.
  execute(operation) {
    if (this.closed || this.pending >= 32) return Promise.reject(new ApiError(503, 'server_busy', 'Сервер занят. Повторите пакет позже.'));
    this.pending++;
    const result = this.tail.then(operation).finally(() => this.pending--);
    this.tail = result.catch(() => {});
    return result;
  }

  async rows(query, query_params = {}) {
    const result = await this.client.query({ query, query_params, format: 'JSONEachRow' });
    return result.json();
  }

  ingest(projectId, events) {
    return this.execute(async () => {
      const unique = [...new Map(events.map(event => [event.eventId, event])).values()];
      const existing = await this.rows(`SELECT toString(event_id) AS eventId, payload_hash AS payloadHash
        FROM events FINAL WHERE project_id = {project:String} AND event_id IN {ids:Array(UUID)}`,
      { project: projectId, ids: unique.map(event => event.eventId) });
      const hashes = new Map(existing.map(event => [event.eventId, event.payloadHash]));
      if (unique.some(event => hashes.has(event.eventId) && hashes.get(event.eventId) !== event.payloadHash)) {
        throw new ApiError(409, 'event_id_conflict', 'eventId уже сохранён с другим содержимым. Весь пакет отклонён.');
      }
      const fresh = unique.filter(event => !hashes.has(event.eventId));
      if (fresh.length) {
        await this.client.insert({ table: 'events', format: 'JSONEachRow',
          values: fresh.map(event => ({ project_id: projectId, event_id: event.eventId, session_id: event.sessionId,
            occurred_at: event.occurredAt, name: event.name, screen: event.screen, platform: event.platform,
            app_version: event.appVersion, properties: JSON.stringify(event.properties), payload_hash: event.payloadHash })),
          clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 0, max_insert_block_size: 100 },
        });
      }
      return { accepted: fresh.length, duplicates: events.length - fresh.length,
        acknowledgedEventIds: unique.map(event => event.eventId) };
    });
  }

  stats(projectId, days, now = new Date()) {
    return this.execute(async () => {
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const from = new Date(today - (days - 1) * 86_400_000).toISOString();
      const until = new Date(today + 86_400_000).toISOString();
      const parameters = { project: projectId, from, until };
      const filter = `WHERE project_id = {project:String}
        AND occurred_at >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
        AND occurred_at < parseDateTime64BestEffort({until:String}, 3, 'UTC')`;
      const query = sql => this.rows(sql, parameters);
      const [totals] = await query(`SELECT count() AS events, uniqExact(session_id) AS sessions,
        countIf(name = 'screen_view') AS screenViews, countIf(name = 'button_click') AS buttonClicks,
        countIf(name = 'action_success') AS successfulActions FROM events FINAL ${filter}`);
      const byName = await query(`SELECT name, count() AS count FROM events FINAL ${filter}
        GROUP BY name ORDER BY count DESC, name LIMIT 101`);
      const byScreen = await query(`SELECT screen, count() AS count FROM events FINAL ${filter} AND screen IS NOT NULL
        GROUP BY screen ORDER BY count DESC, screen LIMIT 101`);
      const byScreenViews = await query(`SELECT screen, count() AS count FROM events FINAL ${filter} AND name = 'screen_view'
        GROUP BY screen ORDER BY count DESC, screen NULLS LAST LIMIT 101`);
      const byButton = await query(`SELECT if(JSONType(properties, 'button') = 'String',
        nullIf(trimBoth(JSONExtractString(properties, 'button')), ''), NULL) AS button, screen, count() AS count
        FROM events FINAL ${filter} AND name = 'button_click'
        GROUP BY button, screen ORDER BY count DESC, button NULLS LAST, screen NULLS LAST LIMIT 101`);
      const byAction = await query(`SELECT if(JSONType(properties, 'action') = 'String',
        nullIf(trimBoth(JSONExtractString(properties, 'action')), ''), NULL) AS action, screen, count() AS count
        FROM events FINAL ${filter} AND name = 'action_success'
        GROUP BY action, screen ORDER BY count DESC, action NULLS LAST, screen NULLS LAST LIMIT 101`);
      const buckets = await query(`SELECT toString(toDate(occurred_at, 'UTC')) AS date, count() AS count
        FROM events FINAL ${filter} GROUP BY date ORDER BY date`);
      const counts = new Map(buckets.map(row => [row.date, integer(row.count)]));
      const groups = { byName, byScreen, byScreenViews, byButton, byAction };
      return { days, timezone: 'UTC', from, until,
        totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, integer(value)])),
        breakdownLimit: 100,
        truncated: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.length > 100])),
        ...Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.slice(0, 100).map(row => ({ ...row, count: integer(row.count) }))])),
        daily: Array.from({ length: days }, (_, index) => {
          const date = new Date(today - (days - 1 - index) * 86_400_000).toISOString().slice(0, 10);
          return { date, count: counts.get(date) ?? 0 };
        }),
      };
    });
  }

  recent(projectId, limit = 50) {
    return this.execute(async () => {
      const rows = await this.rows(`SELECT toString(event_id) AS eventId, toString(session_id) AS sessionId,
        toUnixTimestamp64Milli(occurred_at) AS occurredMs, toUnixTimestamp64Milli(received_at) AS receivedMs,
        name, screen, platform, app_version AS appVersion, properties FROM events FINAL
        WHERE project_id = {project:String} ORDER BY received_at DESC, event_id LIMIT {limit:UInt32}`,
      { project: projectId, limit });
      return rows.map(({ occurredMs, receivedMs, properties, ...event }) => ({ ...event,
        occurredAt: new Date(Number(occurredMs)).toISOString(), receivedAt: new Date(Number(receivedMs)).toISOString(),
        properties: JSON.parse(properties) }));
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.client.close();
  }
}

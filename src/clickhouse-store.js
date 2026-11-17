import { readFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { createClient } from '@clickhouse/client';
import { ApiError } from './errors.js';
import { CSV_ROW_LIMIT, CSV_BYTE_LIMIT } from './analytics-export.js';

const statisticsQuery = await readFile(new URL('./clickhouse-statistics.sql', import.meta.url), 'utf8');

const MAX_PENDING_INGEST_REQUESTS = 64;

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
    this.pendingIngest = 0;
    this.ingestGroup = null;
    this.closed = false;
  }

  // One application process owns ingestion in Lab 3. This is not a distributed lock.
  execute(operation) {
    this.ingestGroup = null; // Reads and deletions fence later coalescing.
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
    if (this.closed || this.pendingIngest >= MAX_PENDING_INGEST_REQUESTS) {
      return Promise.reject(new ApiError(503, 'server_busy', 'Сервер занят. Повторите пакет позже.'));
    }
    this.pendingIngest++;
    const result = new Promise((resolve, reject) => {
      const job = { events, resolve, reject };
      let group = this.ingestGroup;
      if (group && !group.started && group.projectId === projectId
          && group.eventCount + events.length <= 1000) {
        group.jobs.push(job);
        group.eventCount += events.length;
        return;
      }
      group = { projectId, jobs: [job], eventCount: events.length, started: false };
      const operation = this.execute(async () => {
        await wait(5);
        group.started = true;
        if (this.ingestGroup === group) this.ingestGroup = null;
        return this.writeIngestGroup(projectId, group.jobs);
      });
      // execute fences older groups; publish this group only after it is queued.
      this.ingestGroup = group;
      operation.then(
        replies => group.jobs.forEach((item, i) => {
          if (replies[i].error) item.reject(replies[i].error);
          else item.resolve(replies[i].value);
        }),
        error => {
          // Admission can fail before the operation starts. Never leave a
          // rejected, joinable group for the next request after recovery.
          group.started = true;
          if (this.ingestGroup === group) this.ingestGroup = null;
          group.jobs.forEach(item => item.reject(error));
        },
      );
    });
    return result.finally(() => this.pendingIngest--);
  }

  async writeIngestGroup(projectId, jobs) {
    const packets = jobs.map(job => ({
      events: job.events,
      unique: [...new Map(job.events.map(event => [event.eventId, event])).values()],
    }));
    const candidates = [...new Map(packets.flatMap(packet => packet.unique).map(event => [event.eventId, event])).values()];
    const existing = candidates.length ? await this.rows(
      'SELECT toString(event_id) AS eventId, payload_hash AS payloadHash, name AS eventName,' +
      ' toUnixTimestamp64Milli(received_at) AS receivedMs FROM events FINAL' +
      ' WHERE project_id = {project:String} AND event_id IN {ids:Array(UUID)}',
      { project: projectId, ids: candidates.map(event => event.eventId) }) : [];
    const hashes = new Map(existing.map(event => [event.eventId, event.payloadHash]));
    const facts = new Map(existing.map(event => [event.eventId, {
      name: event.eventName, receivedAt: new Date(Number(event.receivedMs)).toISOString(),
    }]));
    const receivedAt = new Date().toISOString();
    const fresh = [], acknowledged = new Set(), replies = [];
    for (const packet of packets) {
      if (packet.unique.some(event => hashes.has(event.eventId) && hashes.get(event.eventId) !== event.payloadHash)) {
        replies.push({ error: new ApiError(409, 'event_id_conflict',
          'eventId уже сохранён с другим содержимым. Весь пакет отклонён.') });
        continue;
      }
      const added = packet.unique.filter(event => !hashes.has(event.eventId));
      for (const event of added) {
        hashes.set(event.eventId, event.payloadHash); fresh.push(event);
        facts.set(event.eventId, { name: event.name, receivedAt });
      }
      for (const event of packet.unique) acknowledged.add(event.eventId);
      replies.push({ value: { accepted: added.length, duplicates: packet.events.length - added.length,
        acknowledgedEventIds: packet.unique.map(event => event.eventId) } });
    }
    if (fresh.length) {
      await this.client.insert({ table: 'events', format: 'JSONEachRow',
        values: fresh.map(event => ({ project_id: projectId, event_id: event.eventId, session_id: event.sessionId,
          occurred_at: event.occurredAt, name: event.name, screen: event.screen, platform: event.platform,
          app_version: event.appVersion, properties: JSON.stringify(event.properties), payload_hash: event.payloadHash, received_at: facts.get(event.eventId).receivedAt })),
        clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 0, max_insert_block_size: 1000 },
      });
    }
    // Replies are released only after both writes. A storage failure rejects
    // the whole group; retry fills absent receipts for already persisted IDs.
    if (acknowledged.size) {
      // Fresh UUIDs cannot have a receipt. Avoid a random-ID FINAL scan of
      // growing tables for every new batch; only retries need a repair read.
      const oldIds = existing.map(event => event.eventId).filter(id => acknowledged.has(id));
      const present = oldIds.length ? await this.rows(
        'SELECT toString(event_id) AS eventId FROM ingestion_receipts FINAL' +
        ' WHERE project_id = {project:String} AND event_id IN {ids:Array(UUID)}',
        { project: projectId, ids: oldIds }) : [];
      const complete = new Set(present.map(event => event.eventId));
      const receipts = [...acknowledged].filter(id => !complete.has(id)).map(id => ({
        project_id: projectId, event_id: id, event_name: facts.get(id).name,
        observed_at: facts.get(id).receivedAt, status: 'stored',
      }));
      if (receipts.length) await this.client.insert({ table: 'ingestion_receipts', format: 'JSONEachRow',
        values: receipts,
        clickhouse_settings: { async_insert: 0, input_format_parallel_parsing: 0, max_insert_block_size: 1000 },
      });
    }
    return replies;
  }


  deleteProjectEvents(projectId) {
    // Queue after already accepted writes and wait until deletion is visible.
    return this.execute(async () => {
      for (const table of ['events', 'ingestion_receipts']) await this.client.command({
        query: `ALTER TABLE ${table} DELETE WHERE project_id = {project:String}`,
        query_params: { project: projectId }, clickhouse_settings: { mutations_sync: 2 },
      });
    });
  }

  operationalState(projectId) {
    return this.execute(async () => {
      const params = { project: projectId };
      const probe = async query => {
        const result = await this.client.query({ query, query_params: params, format: 'JSONEachRow',
          abort_signal: AbortSignal.timeout(2500),
          clickhouse_settings: { max_execution_time: 2, max_threads: 2, max_memory_usage: 67108864 } });
        return result.json();
      };
      const [count] = await probe('SELECT count() AS total FROM ingestion_receipts FINAL WHERE project_id = {project:String}');
      const [last] = await probe(`SELECT toString(event_id) AS eventId, event_name AS eventName,
        toUnixTimestamp64Milli(observed_at) AS observedMs, status FROM ingestion_receipts FINAL
        WHERE project_id = {project:String} ORDER BY observed_at DESC, event_id DESC LIMIT 1`);
      return { total: integer(count.total), lastEvent: last ? { eventId: last.eventId, eventName: last.eventName,
        observedAt: new Date(Number(last.observedMs)).toISOString(), status: last.status } : null };
    });
  }

  exportRows(projectId, { kind, from, to }) {
    return this.execute(async () => {
      const parameters = { project: projectId, to, limit: CSV_ROW_LIMIT + 1, ...(from !== null ? { from } : {}) };
      const filter = `WHERE project_id = {project:String} AND occurred_at <= fromUnixTimestamp64Milli({to:Int64})
        ${from !== null ? 'AND occurred_at >= fromUnixTimestamp64Milli({from:Int64})' : ''}`;
      const query = kind === 'summary' ? `SELECT name AS eventType, ifNull(screen, '') AS screen,
        if(name = 'button_click', JSONExtractString(properties, 'button'), '') AS button,
        if(name = 'action_success', JSONExtractString(properties, 'action'), '') AS action,
        platform, app_version AS appVersion, count() AS eventCount, uniqExact(session_id) AS sessionCount
        FROM events FINAL ${filter} GROUP BY name, screen, button, action, platform, app_version
        ORDER BY eventCount DESC, name, screen, button, action, platform, app_version LIMIT {limit:UInt32}`
        : `SELECT toString(event_id) AS eventId, toString(session_id) AS sessionId, name AS eventType,
          ifNull(screen, '') AS screen, platform, app_version AS appVersion,
          toUnixTimestamp64Milli(occurred_at) AS occurredMs, toUnixTimestamp64Milli(received_at) AS receivedMs, properties
          FROM events FINAL ${filter} ORDER BY occurred_at, event_id LIMIT {limit:UInt32}`;
      const result = await this.client.query({ query, query_params: parameters, format: 'JSONEachRow',
        clickhouse_settings: { max_threads: 2, max_execution_time: 8, max_memory_usage: 134217728,
          max_result_bytes: CSV_BYTE_LIMIT, result_overflow_mode: 'throw' } });
      const rows = await result.json();
      if (rows.length > CSV_ROW_LIMIT) throw new ApiError(413, 'export_too_many_rows', 'В выгрузке больше 10 000 записей. Выберите более короткий период. Файл не обрезан.');
      return kind === 'summary' ? rows.map(row => ({ ...row, eventCount: integer(row.eventCount), sessionCount: integer(row.sessionCount) })) : rows;
    });
  }

  firstEventAt(projectId) {
    return this.execute(async () => {
      const [row] = await this.rows(`SELECT count() AS count, toUnixTimestamp64Milli(min(occurred_at)) AS first
        FROM events WHERE project_id = {project:String} AND occurred_at <= now64(3, 'UTC')`, { project: projectId });
      return Number(row.count) ? Number(row.first) : null;
    });
  }

  stats(projectId, days, now = new Date()) {
    return this.execute(async () => {
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const from = new Date(today - (days - 1) * 86_400_000).toISOString();
      const until = new Date(today + 86_400_000).toISOString();
      // One scan and one database read keep totals and breakdowns consistent.
      const values = await this.rows(statisticsQuery, { project: projectId, from, until });
      const total = values.find(row => row.kind === 'totals');
      const totals = { events: integer(total?.count ?? 0), sessions: integer(total?.sessions ?? 0),
        screenViews: integer(total?.screenViews ?? 0), buttonClicks: integer(total?.buttonClicks ?? 0),
        successfulActions: integer(total?.successfulActions ?? 0) };
      const select = kind => values.filter(row => row.kind === kind);
      const groups = {
        byName: select('byName').map(row => ({ name: row.label, count: integer(row.count) })),
        byScreen: select('byScreen').map(row => ({ screen: row.label, count: integer(row.count) })),
        byScreenViews: select('byScreenViews').map(row => ({ screen: row.label, count: integer(row.count) })),
        byButton: select('byButton').map(row => ({ button: row.label, screen: row.screen, count: integer(row.count) })),
        byAction: select('byAction').map(row => ({ action: row.label, screen: row.screen, count: integer(row.count) })),
      };
      const counts = new Map(select('daily').map(row => [row.label, integer(row.count)]));
      return { days, timezone: 'UTC', from, until, totals, breakdownLimit: 100,
        truncated: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.length > 100])),
        ...Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.slice(0, 100)])),
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

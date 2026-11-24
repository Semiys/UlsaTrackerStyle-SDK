import { readFile } from 'node:fs/promises';
import { Umzug } from 'umzug';

const migrationNames = ['001-lab5-baseline', '002-event-category'];

async function rows(client, query) {
  return (await client.query({ query, format: 'JSONEachRow' })).json();
}

// This journal is copied with application data. The original schema_version
// remains compatible with the baseline database layout.
export async function migrateClickHouse(client) {
  await client.command({ query: `CREATE TABLE IF NOT EXISTS schema_migrations (
    name String
  ) ENGINE = ReplacingMergeTree ORDER BY name` });

  const storage = {
    async executed() {
      const applied = (await rows(client, 'SELECT name FROM schema_migrations FINAL ORDER BY name')).map(row => row.name);
      if (applied.some((name, index) => name !== migrationNames[index])) {
        throw new Error('Unsupported ClickHouse migration history');
      }
      return applied;
    },
    async logMigration({ name }) {
      await client.insert({ table: 'schema_migrations', values: [{ name }], format: 'JSONEachRow' });
    },
    async unlogMigration() {
      throw new Error('Roll back the ClickHouse schema by restoring the pre-release backup');
    },
  };
  const migrator = new Umzug({
    context: client,
    storage,
    logger: undefined,
    migrations: migrationNames.map(name => ({
      name,
      async up({ context }) {
        const sql = await readFile(new URL(`./${name}.sql`, import.meta.url), 'utf8');
        for (const query of sql.split(';').map(part => part.trim()).filter(Boolean)) {
          await context.command({ query });
        }
        if (name === migrationNames[0]) {
          const versions = await rows(context, 'SELECT version FROM schema_version FINAL');
          if (versions.length !== 1 || Number(versions[0].version) !== 1) {
            throw new Error('Unsupported analytics database baseline');
          }
          await rows(context, 'SELECT project_id, event_id, session_id, occurred_at, received_at, name, screen, platform, app_version, properties, payload_hash FROM events LIMIT 0');
          await rows(context, 'SELECT project_id, event_id, event_name, observed_at, status FROM ingestion_receipts LIMIT 0');
        }
      },
    })),
  });
  const applied = await migrator.up();
  if (applied.length) console.info('ClickHouse migrations:', applied.map(({ name }) => name).join(', '));
}

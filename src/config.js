import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEMO_INGEST_KEY, DEMO_READ_KEY } from './demo.js';

export async function loadConfig(env = process.env) {
  const storageBackend = env.STORAGE_BACKEND ?? 'json';
  if (!['json', 'duckdb', 'clickhouse'].includes(storageBackend)) throw new Error('STORAGE_BACKEND must be json or duckdb or clickhouse');
  if (env.DEMO_MODE !== undefined && !['0', '1'].includes(env.DEMO_MODE)) throw new Error('DEMO_MODE must be 0 or 1');
  const demoMode = env.DEMO_MODE === '1';
  if (env.CONSOLE_ENABLED !== undefined && !['0', '1'].includes(env.CONSOLE_ENABLED)) throw new Error('CONSOLE_ENABLED must be 0 or 1');
  const consoleEnabled = env.CONSOLE_ENABLED === '1';
  const publicUrl = new URL(env.PUBLIC_URL ?? 'http://localhost:8080');
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('Invalid PUBLIC_URL');
  if (demoMode && storageBackend === 'duckdb') throw new Error('The lab demo requires JSON or ClickHouse storage');
  const dashboardProvider = env.DASHBOARD_PROVIDER ?? 'tables';
  if (!['tables', 'grafana'].includes(dashboardProvider)) throw new Error('Invalid DASHBOARD_PROVIDER');
  if (dashboardProvider === 'grafana' && ((!demoMode && !consoleEnabled) || storageBackend !== 'clickhouse')) {
    throw new Error('Anonymous Grafana is available only for the local ClickHouse demo');
  }
  let dashboardUrl = null;
  if (dashboardProvider === 'grafana') {
    const url = new URL(env.DASHBOARD_PUBLIC_URL ?? 'http://localhost:3000');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid DASHBOARD_PUBLIC_URL');
    dashboardUrl = new URL(consoleEnabled ? '/grafana/d/ulsatracker/events' : '/d/ulsatracker/events', url).href;
  }
  let clickhouse;
  if (storageBackend === 'clickhouse') {
    const url = new URL(env.DATABASE_URL ?? 'http://db:8123');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid DATABASE_URL');
    if (!env.DATABASE_USER || !env.DATABASE_PASSWORD || !/^[a-z][a-z0-9_]{0,63}$/.test(env.DATABASE_NAME ?? '')) throw new Error('DATABASE_USER, DATABASE_PASSWORD and DATABASE_NAME are required');
    clickhouse = { url: url.href, username: env.DATABASE_USER, password: env.DATABASE_PASSWORD, database: env.DATABASE_NAME };
  }
  const demoProject = storageBackend === 'clickhouse' ? 'lab3-demo' : 'lab2-demo';
  const demoName = storageBackend === 'clickhouse' ? 'ЛР3 · Дом Коллекционера' : 'ЛР2 · Дом Коллекционера';
  const dataDir = resolve(env.DATA_DIR ?? './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const accessPath = join(dataDir, 'access.json');
  let access;
  try {
    access = JSON.parse(await readFile(accessPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    access = {
      projectId: env.PROJECT_ID ?? (demoMode ? demoProject : 'dom-collection'),
      projectName: env.PROJECT_NAME ?? (demoMode ? demoName : 'Дом Коллекционера'),
      ingestKey: demoMode ? DEMO_INGEST_KEY : randomBytes(32).toString('hex'),
      readKey: demoMode ? DEMO_READ_KEY : randomBytes(32).toString('hex'),
    };
    try {
      await writeFile(accessPath, JSON.stringify(access, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      access = JSON.parse(await readFile(accessPath, 'utf8'));
    }
  }
  if (typeof access.projectId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(access.projectId)
      || typeof access.projectName !== 'string' || access.projectName.length < 1 || access.projectName.length > 100
      || !/^[a-zA-Z0-9_-]{32,128}$/.test(access.ingestKey)
      || !/^[a-zA-Z0-9_-]{32,128}$/.test(access.readKey)
      || access.ingestKey === access.readKey) {
    throw new Error('Invalid data/access.json configuration');
  }
  if (demoMode && (access.ingestKey !== DEMO_INGEST_KEY || access.readKey !== DEMO_READ_KEY || access.projectId !== demoProject)) {
    throw new Error('Use a separate empty volume for the teaching demo');
  }
  const grafanaInternal = new URL(env.GRAFANA_INTERNAL_URL ?? 'http://dashboard:3000');
  if (!['http:', 'https:'].includes(grafanaInternal.protocol) || grafanaInternal.username || grafanaInternal.password
      || grafanaInternal.pathname !== '/' || grafanaInternal.search || grafanaInternal.hash) throw new Error('Invalid GRAFANA_INTERNAL_URL');
  return { ...access, demoMode, storageBackend, dataDir, clickhouse, dashboardProvider, dashboardUrl,
    consoleEnabled, publicUrl: publicUrl.origin, secureCookies: publicUrl.protocol === 'https:',
    accountsPath: join(dataDir, 'accounts.sqlite'), grafanaInternalUrl: grafanaInternal.origin,
    grafanaAdminUser: env.GRAFANA_ADMIN_USER ?? 'app', grafanaAdminPassword: env.GRAFANA_ADMIN_PASSWORD ?? 'app',
    jsonPath: join(dataDir, 'events.json'), databasePath: join(dataDir, 'analytics.duckdb') };
}

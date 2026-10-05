import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEMO_INGEST_KEY, DEMO_READ_KEY } from './demo.js';

export async function loadConfig(env = process.env) {
  const storageBackend = env.STORAGE_BACKEND ?? 'json';
  if (!['json', 'duckdb'].includes(storageBackend)) throw new Error('STORAGE_BACKEND must be json or duckdb');
  if (env.DEMO_MODE !== undefined && !['0', '1'].includes(env.DEMO_MODE)) throw new Error('DEMO_MODE must be 0 or 1');
  const demoMode = env.DEMO_MODE === '1';
  if (demoMode && storageBackend !== 'json') throw new Error('The lab demo requires JSON storage');
  const dataDir = resolve(env.DATA_DIR ?? './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const accessPath = join(dataDir, 'access.json');
  let access;
  try {
    access = JSON.parse(await readFile(accessPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    access = {
      projectId: env.PROJECT_ID ?? (demoMode ? 'lab2-demo' : 'dom-collection'),
      projectName: env.PROJECT_NAME ?? (demoMode ? 'ЛР2 · Дом Коллекционера' : 'Дом Коллекционера'),
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
  if (demoMode && (access.ingestKey !== DEMO_INGEST_KEY || access.readKey !== DEMO_READ_KEY || access.projectId !== 'lab2-demo')) {
    throw new Error('Use a separate empty volume for the teaching demo');
  }
  return { ...access, demoMode, storageBackend, dataDir,
    jsonPath: join(dataDir, 'events.json'), databasePath: join(dataDir, 'analytics.duckdb') };
}

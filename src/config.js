import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function loadConfig(env = process.env) {
  const dataDir = resolve(env.DATA_DIR ?? './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const accessPath = join(dataDir, 'access.json');
  let access;
  try {
    access = JSON.parse(await readFile(accessPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    access = {
      projectId: env.PROJECT_ID ?? 'dom-collection',
      projectName: env.PROJECT_NAME ?? 'Дом Коллекционера',
      ingestKey: randomBytes(32).toString('hex'),
      readKey: randomBytes(32).toString('hex'),
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
  return { ...access, dataDir, databasePath: join(dataDir, 'analytics.duckdb') };
}

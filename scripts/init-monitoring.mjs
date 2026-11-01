import { mkdir, open, chmod, chown } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const base = resolve('.monitoring-secrets');
await mkdir(base, { recursive: true, mode: 0o700 });
for (const name of ['operator-password', 'dashboard-password']) {
  const path = resolve(base, name);
  try { const file = await open(path, 'wx', 0o600); await file.writeFile(randomBytes(32).toString('base64url') + '\n'); await file.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Dedicated non-privileged container group, never world-readable.
  await chown(path, 0, 65530);
  await chmod(path, 0o440);
}
console.log('Monitoring secrets are ready in .monitoring-secrets/ (existing passwords preserved).');

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';

// This command explicitly creates a diagnostic event; startup never seeds data.
const mode = process.argv[2];
if (!['--new', '--repeat'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node src/send-test-event.js --new | --repeat');
  process.exit(1);
}
const config = await loadConfig();
const path = join(config.dataDir, 'manual-test-event.json');
let packet;
if (mode === '--new') {
  packet = { schemaVersion: 1, events: [{
    eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString(),
    name: 'button_click', screen: 'sdk_check', platform: 'web', appVersion: '0.1.0',
    properties: { button: 'test_event', source: 'manual_check' },
  }] };
  await writeFile(path, JSON.stringify(packet, null, 2) + '\n', { mode: 0o600 });
} else {
  try { packet = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      console.error('First send a diagnostic event with --new.');
      process.exit(1);
    }
    throw error;
  }
}
const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/api/v1/events`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.ingestKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(packet), signal: AbortSignal.timeout(10_000),
});
const result = await response.json();
console.log(JSON.stringify({ status: response.status, ...result }, null, 2));
if (!response.ok) process.exitCode = 1;

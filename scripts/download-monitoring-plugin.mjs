import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const architecture = process.argv[2];
const hashes = {
  amd64: 'd642d141fc9058f9a1d9950796be9bd348c924046a580f900ad871c885d0681e',
  arm64: 'aee0416a0fedffc769e325188d142c2e4b2cf8b1837c96968cbae603f3ba7114',
};
if (!hashes[architecture]) throw new Error('Unsupported Grafana plugin architecture');
const version = '4.23.4';
const url = `https://grafana.com/api/plugins/grafana-clickhouse-datasource/versions/${version}/download?os=linux&arch=${architecture}`;
const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
if (!response.ok) throw new Error(`Plugin download failed: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== hashes[architecture]) throw new Error('Grafana plugin checksum mismatch');
await mkdir('/bundle', { recursive: true });
await writeFile('/tmp/plugin.zip', archive);
execFileSync('unzip', ['-q', '/tmp/plugin.zip', '-d', '/bundle']);
const base = '/bundle/grafana-clickhouse-datasource';
const plugin = JSON.parse(await readFile(base + '/plugin.json', 'utf8'));
if (plugin.id !== 'grafana-clickhouse-datasource' || plugin.info.version !== version) throw new Error('Unexpected Grafana plugin');
await chmod(`${base}/gpx_clickhouse_linux_${architecture}`, 0o755);
console.log(`Verified ClickHouse plugin ${version} for linux/${architecture}`);

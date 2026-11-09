import test from 'node:test';
import assert from 'node:assert/strict';
const enabled = { skip: !process.env.PROMETHEUS_TEST_URL };
test('Prometheus scrapes the private listener and operator dashboards reject anonymous data access', enabled, async () => {
  const base = process.env.PROMETHEUS_TEST_URL;
  let found;
  for (let attempt = 0; attempt < 30; attempt++) {
    const data = await (await fetch(base + '/api/v1/query?query=' + encodeURIComponent('up{job="ulsa-api"}'))).json();
    found = data.data?.result?.[0]; if (found?.value?.[1] === '1') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(found?.value?.[1], '1');
  const db = await (await fetch(base + '/api/v1/query?query=' + encodeURIComponent('up{job="clickhouse"}'))).json();
  assert.equal(db.data.result[0]?.value?.[1], '1');
  const memory = await (await fetch(base + '/api/v1/query?query=ClickHouseAsyncMetrics_MemoryResident')).json();
  assert.ok(Number(memory.data.result[0]?.value?.[1]) > 0);
  const metrics = await (await fetch('http://app:9100/metrics')).text();
  assert.match(metrics, /ulsa_http_requests_total/); assert.match(metrics, /ulsa_process_resident_memory_bytes/);
  assert.match(metrics, /ulsa_storage_available 1/);
  assert.equal((await fetch('http://monitoring-dashboard:3000/api/search')).status, 401);
  assert.equal((await fetch(process.env.APP_TEST_URL + '/metrics')).status, 404);
  const rules = await (await fetch(base + '/api/v1/rules')).json();
  assert.ok(rules.data.groups.some(g => g.rules.some(r => r.name === 'UlsaApiDown')));
});

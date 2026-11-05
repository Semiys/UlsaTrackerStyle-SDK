import client from '@prometheus-io/client';
import { SERVER_VERSION } from './version.js';

const routes = [
  /^\/(?:health|login|register|logout|dashboard|guide|events\/new|error)$/,
  /^\/api\/v1\/(?:events|stats|events\/recent)$/,
  /^\/console(?:\/projects)?$/,
];
export function metricRoute(req) {
  const path = (req.originalUrl ?? req.path ?? req.url ?? '').split('?')[0].toLowerCase();
  if (/^\/api\/console(?:\/|$)/.test(path)) {
    if (/^\/api\/console\/(?:session|guide|register|login|logout|projects)$/.test(path)) return path;
    if (/^\/api\/console\/projects\/[^/]+(?:\/(?:apps|settings))?$/.test(path)) return path.replace(/^\/api\/console\/projects\/[^/]+/, '/api/console/projects/:projectId');
    if (/^\/api\/console\/apps\/[^/]+(?:\/(?:statistics|test|delete|keys\/rotate))?$/.test(path)) return path.replace(/^\/api\/console\/apps\/[^/]+/, '/api/console/apps/:appId');
    if (/^\/api\/console\/apps\/[^/]+\/keys\/[^/]+\/revoke$/.test(path)) return '/api/console/apps/:appId/keys/:keyId/revoke';
    return 'other';
  }
  if (path.startsWith('/grafana/')) return '/grafana/*';
  if (/^\/console\/apps\/[^/]+(?:\/(?:stats|data|range|test|export\.(?:csv|json)|keys\/rotate))?$/.test(path))
    return path.replace(/^\/console\/apps\/[^/]+/, '/console/apps/:appId');
  if (/^\/console\/apps\/[^/]+\/keys\/[^/]+\/revoke$/.test(path)) return '/console/apps/:appId/keys/:keyId/revoke';
  if (/^\/console\/projects\/[^/]+(?:\/(?:apps|settings))?$/.test(path))
    return path.replace(/^\/console\/projects\/[^/]+/, '/console/projects/:projectId');
  return routes.some(pattern => pattern.test(path)) ? path : 'other';
}

export class ServiceMetrics {
  constructor(store, { grafanaUrl, frontendUrl } = {}) {
    this.store = store;
    this.registry = new client.Registry();
    client.collectDefaultMetrics({ register: this.registry, prefix: 'ulsa_' });
    const registers = [this.registry];
    this.http = new client.Counter({ name: 'ulsa_http_requests_total', help: 'Completed HTTP requests; fixed route templates only.', labelNames: ['method', 'route', 'status_code'], registers });
    this.duration = new client.Histogram({ name: 'ulsa_http_request_duration_seconds', help: 'HTTP response duration.', labelNames: ['method', 'route'], buckets: [.005, .025, .1, .5, 1, 3, 10, 30], registers });
    this.events = new client.Counter({ name: 'ulsa_ingest_events_total', help: 'Events acknowledged by storage, including duplicate acknowledgements.', labelNames: ['result'], registers });
    for (const result of ['accepted', 'duplicate']) this.events.labels(result).inc(0);
    this.batches = new client.Counter({ name: 'ulsa_ingest_batches_total', help: 'Ingestion request outcomes.', labelNames: ['outcome'], registers });
    new client.Gauge({ name: 'ulsa_build_info', help: 'Running application version.', labelNames: ['version'], registers }).set({ version: SERVER_VERSION }, 1);
    const owner = this;
    new client.Gauge({ name: 'ulsa_storage_pending_operations', help: 'Operations queued or running in this API process.', registers,
      collect() { this.set(Number.isFinite(store.pending) ? store.pending : 0); } });
    new client.Gauge({ name: 'ulsa_storage_available', help: 'Storage read probe; 1 is available, 0 is failed.', registers,
      async collect() {
        try {
          if (store.closed) throw new Error('closed');
          if (store.client) {
            const response = await store.client.query({ query: 'SELECT 1', format: 'JSONEachRow', abort_signal: AbortSignal.timeout(2000) });
            await response.json();
          }
          this.set(1);
        } catch { this.set(0); }
      } });
    if (grafanaUrl) new client.Gauge({ name: 'ulsa_grafana_available', help: 'Product dashboard health probe.', registers,
      async collect() {
        try {
          const response = await fetch(new URL('/grafana/api/health', grafanaUrl), { signal: AbortSignal.timeout(2000), redirect: 'error' });
          this.set(response.ok && (await response.json()).database === 'ok' ? 1 : 0);
        } catch { this.set(0); }
      } });
    if (frontendUrl) new client.Gauge({ name: 'ulsa_frontend_available', help: 'Static frontend health probe; does not replace API/storage probes.', registers,
      async collect() {
        try {
          const response = await fetch(new URL('/frontend-health', frontendUrl), { signal: AbortSignal.timeout(2000), redirect: 'error' });
          this.set(response.ok && (await response.json()).status === 'ok' ? 1 : 0);
        } catch { this.set(0); }
      } });
    this.observeHttp = (req, res, next) => {
      const start = process.hrtime.bigint();
      let recorded = false;
      const observe = () => {
        if (recorded) return; recorded = true;
        const method = ['GET','POST','HEAD','OPTIONS','PUT','PATCH','DELETE'].includes(req.method) ? req.method : 'OTHER';
        const route = metricRoute(req), code = res.writableFinished ? res.statusCode : 499;
        owner.http.inc({ method, route, status_code: String(code) });
        owner.duration.observe({ method, route }, Number(process.hrtime.bigint() - start) / 1e9);
        if (method === 'POST' && route === '/api/v1/events') owner.batches.inc({ outcome: code === 200 ? 'acknowledged' : code < 500 ? 'rejected' : 'unavailable' });
      };
      res.once('finish', observe); res.once('close', observe); next();
    };
    this.handler = async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url !== '/metrics') { res.writeHead(404); return res.end(); }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); return res.end(); }
      try {
        const body = await this.registry.metrics();
        res.writeHead(200, { 'Content-Type': this.registry.contentType }); res.end(body);
      } catch { res.writeHead(503); res.end('Metrics unavailable\n'); }
    };
  }
  ingested(result) {
    if (result.accepted > 0) this.events.labels('accepted').inc(result.accepted);
    if (result.duplicates > 0) this.events.labels('duplicate').inc(result.duplicates);
  }
  close() { this.registry.clear(); }
}

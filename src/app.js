import express from 'express';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { validateBatch } from './events.js';
import { ApiError } from './errors.js';
import { demoApiRouter } from './demo-api.js';
import { pageRouter } from './pages.js';
import { SERVER_VERSION, LAB_IMAGE_VERSION } from './version.js';
import { consoleRouter } from './console-pages.js';
import { consoleApiRouter } from './console-api.js';
import { WindowLimiter } from './accounts.js';
import { authLimiter } from './console-security.js';
import { sessionMiddleware } from './console-security.js';
import { ingestAccess, ingestPreflight } from './ingest-access.js';

function authorize(key) {
  const expected = createHash('sha256').update(key).digest();
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const header = req.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const actual = createHash('sha256').update(token).digest();
    if (!token || !timingSafeEqual(expected, actual)) return next(new ApiError(401, 'unauthorized', 'Нужен действующий ключ доступа.'));
    next();
  };
}

export function createApp({ config, store, accounts = null, grafana = null, metrics = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.reverseProxyHops === 1) app.set('trust proxy', 1);
  const consoleLimits = accounts ? { auth: authLimiter(), mutations: new WindowLimiter(60, 60_000) } : null;
  if (metrics) app.use(metrics.observeHttp);
  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('../views/', import.meta.url)));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    const frames = config.dashboardUrl ? new URL(config.dashboardUrl).origin + " 'self'" : "'none'";
    const connection = config.consoleEnabled ? ` 'self' ${new URL(config.publicUrl).origin}` : " 'self'";
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src${connection}; frame-src ${frames}; frame-ancestors 'none'; base-uri 'none'`);
    next();
  });
  app.use((req, res, next) => {
    Object.assign(res.locals, { product: 'UlsaTrackerStyle SDK', serverVersion: SERVER_VERSION,
      labImageVersion: LAB_IMAGE_VERSION, demoMode: config.demoMode === true,
      storageName: ({ duckdb: 'DuckDB', json: 'JSON', clickhouse: 'ClickHouse' })[config.storageBackend],
      dashboardProvider: config.dashboardProvider ?? 'tables', consoleEnabled: !!accounts, currentUser: null });
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok', version: SERVER_VERSION,
    storage: config.storageBackend ?? 'duckdb', demoMode: config.demoMode ?? false,
    ...(config.demoMode ? { labImageVersion: LAB_IMAGE_VERSION } : {}) }));
  if (accounts) app.options('/api/v1/events', ingestPreflight({ accounts, config }));
  app.post('/api/v1/events', ingestAccess({ config, accounts }), (req, res, next) => {
    if (!req.is('application/json')) return next(new ApiError(415, 'unsupported_media_type', 'Требуется Content-Type: application/json.'));
    next();
  }, express.json({ limit: '64kb', strict: true }), async (req, res) => {
    if (req.analyticsApplication && !accounts.resolveKey(req.get('Authorization').slice(7))) throw new ApiError(401, 'unauthorized', 'Нужен действующий ключ отправки.');
    const events = validateBatch(req.body);
    if (req.analyticsApplication && events.some(event => event.platform !== req.analyticsApplication.platform)) throw new ApiError(400, 'platform_mismatch', 'Платформа событий не совпадает с настройкой приложения.');
    const result = await store.ingest(req.analyticsApplication?.id ?? config.projectId, events);
    metrics?.ingested(result);
    res.status(200).json({ schemaVersion: 1, ...result });
  });
  app.get('/api/v1/stats', authorize(config.readKey), async (req, res) => {
    const raw = req.query.days ?? '7';
    if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 90) throw new ApiError(400, 'invalid_days', 'days должен быть целым числом от 1 до 90.');
    const result = await store.stats(config.projectId, Number(raw));
    res.json({ project: { id: config.projectId, name: config.projectName }, ...result });
  });
  app.get('/api/v1/events/recent', authorize(config.readKey), async (req, res) => {
    res.json({ events: await store.recent(config.projectId), limit: 50 });
  });
  app.use('/api/demo', demoApiRouter({ config, store, metrics }));
  if (accounts) app.use('/api/console', sessionMiddleware(accounts, config), consoleApiRouter({ config, accounts, store, grafana, limits: consoleLimits, metrics }));
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Маршрут не найден.' } }));
  if (accounts) {
    app.use(sessionMiddleware(accounts, config));
    // Grafana resolves root-relative dashboard links under its configured /grafana subpath.
    // Keep these two exits on the current host, with normal owner checks.
    app.get(['/grafana/console', '/grafana/console/apps/:appId'], (req, res) => {
      if (!req.accountSession) return res.redirect(303, '/login');
      const appId = req.params.appId;
      if (appId) accounts.application(req.accountSession.user.id, appId);
      res.redirect(303, appId ? '/console/apps/' + appId : '/console');
    });
    if (grafana) app.use('/grafana', express.raw({ type: () => true, limit: '64kb' }), grafana.proxy());
    app.use(consoleRouter({ config, accounts, store, grafana, limits: consoleLimits }));
    app.use('/sdk', (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
  }
  app.use(pageRouter({ config, store, metrics }));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: false }));
  app.use((req, res, next) => next(new ApiError(404, 'not_found', 'Страница не найдена. Перейдите к доступным действиям через меню.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') error = new ApiError(413, 'payload_too_large', req.path.startsWith('/api/console/') ? 'Форма превышает 12 КиБ.' : (req.path === '/events' || req.path.startsWith('/api/demo/')) ? 'Форма превышает 8 КиБ.' : 'Пакет превышает 64 КиБ.');
    if (error.type === 'entity.parse.failed') error = new ApiError(400, 'invalid_json', 'Некорректный JSON.');
    if (error.code === 'server_busy') res.set('Retry-After', '1');
    if (!(error instanceof ApiError)) console.error('Analytics operation failed:', error.name);
    if (!req.path.startsWith('/api/') && req.path !== '/api') {
      return res.status(error instanceof ApiError ? error.status : 500).render('error', {
        active: 'error', status: error instanceof ApiError ? error.status : 500,
        actor: 'Пользователь веб-интерфейса', operation: req.method === 'POST' ? 'Отправить форму' : 'Открыть страницу',
        reason: error instanceof ApiError ? error.message : 'Сервер не смог завершить операцию. Повторите позже.',
        field: error.field ?? null, example: false,
      });
    }
    res.status(error instanceof ApiError ? error.status : 500).json({ error: {
      code: error instanceof ApiError ? error.code : 'internal_error',
      message: error instanceof ApiError ? error.message : 'Сервер не смог завершить операцию.',
      ...(error.field ? { field: error.field } : {}),
    } });
  });
  return app;
}

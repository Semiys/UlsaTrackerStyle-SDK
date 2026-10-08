import express from 'express';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { validateBatch } from './events.js';
import { ApiError } from './errors.js';
import { pageRouter } from './pages.js';
import { SERVER_VERSION, LAB_IMAGE_VERSION } from './version.js';

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

export function createApp({ config, store }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', fileURLToPath(new URL('../views/', import.meta.url)));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok', version: SERVER_VERSION,
    storage: config.storageBackend ?? 'duckdb', demoMode: config.demoMode ?? false,
    ...(config.demoMode ? { labImageVersion: LAB_IMAGE_VERSION } : {}) }));
  app.post('/api/v1/events', authorize(config.ingestKey), (req, res, next) => {
    if (!req.is('application/json')) return next(new ApiError(415, 'unsupported_media_type', 'Требуется Content-Type: application/json.'));
    next();
  }, express.json({ limit: '64kb', strict: true }), async (req, res) => {
    const events = validateBatch(req.body);
    const result = await store.ingest(config.projectId, events);
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
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Маршрут не найден.' } }));
  app.use(pageRouter({ config, store }));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: false }));
  app.use((req, res, next) => next(new ApiError(404, 'not_found', 'Страница не найдена. Перейдите к доступным действиям через меню.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') error = new ApiError(413, 'payload_too_large', req.path === '/events' ? 'Форма превышает 8 КиБ.' : 'Пакет превышает 64 КиБ.');
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

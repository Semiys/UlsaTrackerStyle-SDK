import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { Router, urlencoded } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { validateBatch } from './events.js';
import { ApiError } from './errors.js';
import { SERVER_VERSION, LAB_IMAGE_VERSION } from './version.js';

const knownNames = new Map([['screen_view', 'Открытие экрана'], ['button_click', 'Нажатие кнопки'], ['action_success', 'Успешное действие']]);

export function pageRouter({ config, store }) {
  const router = Router();
  const formSecret = randomBytes(32);
  const signForm = ({ eventId, sessionId, occurredAt }) => createHmac('sha256', formSecret)
    .update(JSON.stringify([eventId, sessionId, occurredAt])).digest('hex');
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.locals.product = 'UlsaTrackerStyle SDK';
    res.locals.serverVersion = SERVER_VERSION;
    res.locals.labImageVersion = LAB_IMAGE_VERSION;
    res.locals.demoMode = config.demoMode === true;
    res.locals.storageName = config.storageBackend === 'duckdb' ? 'DuckDB' : 'JSON';
    res.locals.eventLabel = value => knownNames.get(value) ?? value;
    res.locals.dateLabel = value => new Date(value).toLocaleString('ru-RU', { timeZone: 'UTC' });
    next();
  });
  router.get('/', (req, res) => res.render('index', { active: 'home' }));
  router.get('/events/new', (req, res) => {
    const invalidExample = req.query.example === 'invalid';
    const identity = { eventId: randomUUID(), sessionId: randomUUID(), occurredAt: new Date().toISOString() };
    res.render('event-form', { active: 'form', invalidExample, ...identity, csrfToken: signForm(identity),
      demoIngestKey: config.demoMode ? config.ingestKey : '' });
  });
  router.post('/events', urlencoded({ extended: false, limit: '8kb', parameterLimit: 12 }), async (req, res) => {
    const scalar = key => typeof req.body?.[key] === 'string' ? req.body[key] : '';
    try {
      // A signed form token works through local browser proxies without trusting forwarded Host headers.
      const csrfToken = scalar('csrfToken');
      const expected = signForm({ eventId: scalar('eventId'), sessionId: scalar('sessionId'), occurredAt: scalar('occurredAt') });
      if (!/^[a-f0-9]{64}$/.test(csrfToken) || !timingSafeEqual(Buffer.from(csrfToken), Buffer.from(expected))) {
        throw new ApiError(403, 'invalid_form', 'Форма устарела или проверка формы не пройдена. Откройте её заново. Событие не сохранено.');
      }
      const provided = scalar('ingestKey').trim();
      const hash = value => createHash('sha256').update(value).digest();
      if (!provided || !timingSafeEqual(hash(provided), hash(config.ingestKey))) throw new ApiError(401, 'unauthorized', 'Ключ отправки неверен. Событие не сохранено.');
      const name = scalar('name').trim();
      const detail = scalar('detail').trim();
      const properties = detail ? { [name === 'button_click' ? 'button' : name === 'action_success' ? 'action' : 'detail']: detail } : {};
      const events = validateBatch({ schemaVersion: 1, events: [{
        eventId: scalar('eventId'), sessionId: scalar('sessionId'), occurredAt: scalar('occurredAt'),
        name, screen: scalar('screen').trim() || null, platform: 'web', appVersion: SERVER_VERSION, properties,
      }] });
      await store.ingest(config.projectId, events);
      res.redirect(303, `/dashboard?saved=${events[0].eventId}`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      res.status(error.status).render('error', { active: 'error', status: error.status,
        actor: 'Пользователь веб-формы', operation: 'Сохранить аналитическое событие',
        reason: error.message, field: error.field ?? null, example: false });
    }
  });
  router.get('/dashboard', async (req, res) => {
    const initialStats = config.demoMode ? await store.stats(config.projectId, 7) : null;
    const recentEvents = config.demoMode ? await store.recent(config.projectId) : [];
    const savedId = typeof req.query.saved === 'string' ? req.query.saved : '';
    res.render('dashboard', { active: 'dashboard', initialStats, recentEvents,
      saved: recentEvents.some(event => event.eventId === savedId),
      projectName: config.projectName, demoReadKey: config.demoMode ? config.readKey : '' });
  });
  router.get('/error', (req, res) => {
    // The directly addressable example uses the real validation rule and never writes.
    let reason;
    try {
      validateBatch({ schemaVersion: 1, events: [{ eventId: randomUUID(), sessionId: randomUUID(),
        occurredAt: new Date().toISOString(), name: '', screen: 'collection', platform: 'web', appVersion: SERVER_VERSION }] });
    } catch (error) { if (!(error instanceof ApiError)) throw error; reason = error.message; }
    res.render('error', { active: 'error', status: 400, actor: 'Пользователь демонстрации',
      operation: 'Сохранить событие с пустым названием', reason, field: 'events[0].name', example: true });
  });
  return router;
}

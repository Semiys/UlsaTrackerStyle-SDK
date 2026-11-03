import { Router, json } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { requireCsrf } from './console-security.js';
import { validateBatch } from './events.js';
import { SERVER_VERSION } from './version.js';
import { guideExamples } from './guide-examples.js';

const field = (req, name) => typeof req.body?.[name] === 'string' ? req.body[name] : '';
const projectView = ({ id, name, archived, created_at, applications }) => ({ id, name, archived: !!archived, created_at, ...(applications !== undefined ? { applications } : {}) });
const applicationView = ({ id, project_id, project_name, name, platform, identifier, archived, created_at }) => ({ id, project_id, project_name, name, platform, identifier, archived: !!archived, created_at });

export function consoleApiRouter({ config, accounts, store, grafana, limits, metrics }) {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.method === 'GET') return next();
    if (req.method !== 'POST') return next(new ApiError(405, 'method_not_allowed', 'Метод не поддерживается.'));
    if (!req.is('application/json')) return next(new ApiError(415, 'unsupported_media_type', 'Требуется Content-Type: application/json.'));
    next();
  });
  router.use(json({ limit: '12kb', strict: true }));
  router.get('/session', (req, res) => res.json({
    user: req.accountSession?.user ?? null, csrfToken: res.locals.consoleCsrf,
    endpoint: config.publicUrl, version: SERVER_VERSION, demoMode: config.demoMode === true, grafanaAvailable: !!grafana,
  }));
  router.get('/guide', (req, res) => res.json({ endpoint: config.publicUrl, examples: guideExamples(config.publicUrl) }));
  for (const mode of ['register', 'login']) router.post('/' + mode, requireCsrf, limits.auth, async (req, res) => {
    const user = mode === 'register'
      ? await accounts.register({ name: field(req, 'name'), email: field(req, 'email'), password: field(req, 'password') })
      : await accounts.login(field(req, 'email'), field(req, 'password'));
    accounts.logout(req.sessionToken);
    const session = accounts.createSession(user.id);
    res.cookie('ulsa_session', session.raw, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: 7 * 86400_000 });
    res.json({ user, csrfToken: session.csrf });
  });
  router.use((req, res, next) => req.accountSession ? next() : next(new ApiError(401, 'session_required', 'Сеанс завершён. Войдите в кабинет.')));
  router.use((req, res, next) => {
    if (req.method === 'GET') return next();
    const wait = limits.mutations.take(req.accountSession.user.id);
    if (wait) { res.set('Retry-After', String(wait)); return next(new ApiError(429, 'console_rate_limit', 'Слишком много изменений. Повторите позже.')); }
    requireCsrf(req, res, next);
  });
  router.post('/logout', (req, res) => {
    accounts.logout(req.sessionToken);
    res.clearCookie('ulsa_session', { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' });
    res.json({ ok: true });
  });
  router.get('/projects', (req, res) => res.json({ projects: accounts.projects(req.accountSession.user.id).map(projectView) }));
  router.post('/projects', (req, res) => res.status(201).json({ project: projectView(accounts.createProject(req.accountSession.user.id, field(req, 'name'))) }));
  router.get('/projects/:projectId', (req, res) => {
    const owner = req.accountSession.user.id, project = accounts.project(owner, req.params.projectId);
    res.json({ project: projectView(project), applications: accounts.applications(owner, project.id).map(applicationView) });
  });
  router.post('/projects/:projectId/settings', (req, res) => {
    if (typeof req.body.archived !== 'boolean') throw new ApiError(400, 'invalid_input', 'Укажите состояние архива.');
    const owner = req.accountSession.user.id;
    const project = accounts.updateProject(owner, req.params.projectId, field(req, 'name'), req.body.archived);
    grafana?.invalidate(owner);
    res.json({ project: projectView(project) });
  });
  const sendApplication = (req, res, application, rawKey, status = 200) => res.status(status).json({
    application: applicationView(application), keys: accounts.keys(req.accountSession.user.id, application.id),
    ...(rawKey ? { rawKey } : {}),
  });
  router.post('/projects/:projectId/apps', (req, res) => {
    const owner = req.accountSession.user.id;
    const result = accounts.createApplication(owner, req.params.projectId, {
      name: field(req, 'name'), platform: field(req, 'platform'), identifier: field(req, 'identifier'),
    });
    grafana?.invalidate(owner);
    sendApplication(req, res, result.application, result.key, 201);
  });
  router.get('/apps/:appId', (req, res) => sendApplication(req, res, accounts.application(req.accountSession.user.id, req.params.appId)));
  router.post('/apps/:appId/keys/rotate', (req, res) => {
    const owner = req.accountSession.user.id, rawKey = accounts.rotateKey(owner, req.params.appId);
    sendApplication(req, res, accounts.application(owner, req.params.appId), rawKey);
  });
  router.post('/apps/:appId/keys/:keyId/revoke', (req, res) => {
    accounts.revokeKey(req.accountSession.user.id, req.params.appId, req.params.keyId);
    sendApplication(req, res, accounts.application(req.accountSession.user.id, req.params.appId));
  });
  router.get('/apps/:appId/statistics', (req, res) => {
    const application = accounts.application(req.accountSession.user.id, req.params.appId);
    if (!grafana) throw new ApiError(503, 'grafana_unavailable', 'Панель статистики временно недоступна.');
    res.json({ application: applicationView(application), dashboardUrl: '/grafana/d/' + application.id + '/events' });
  });
  router.post('/apps/:appId/test', async (req, res) => {
    const application = accounts.application(req.accountSession.user.id, req.params.appId);
    if (application.archived) throw new ApiError(409, 'project_archived', 'Сначала восстановите проект.');
    const events = validateBatch({ schemaVersion: 1, events: [{ eventId: randomUUID(), sessionId: randomUUID(),
      occurredAt: new Date().toISOString(), name: field(req, 'name'), screen: field(req, 'screen') || null,
      platform: application.platform, appVersion: SERVER_VERSION, properties: { source: 'console_test' } }] });
    const result = await store.ingest(application.id, events);
    metrics?.ingested(result);
    res.json({ ok: true, ...result });
  });
  router.use((req, res, next) => next(new ApiError(404, 'not_found', 'Маршрут кабинета не найден.')));
  return router;
}

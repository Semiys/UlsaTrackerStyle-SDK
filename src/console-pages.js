import { Router, urlencoded } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { requireOwner, requireCsrf, authLimiter } from './console-security.js';
import { validateBatch } from './events.js';
import { SERVER_VERSION } from './version.js';
import { WindowLimiter } from './accounts.js';

const field = (req, name) => typeof req.body?.[name] === 'string' ? req.body[name] : '';

export function consoleRouter({ config, accounts, store, grafana }) {
  const router = Router();
  const parse = urlencoded({ extended: false, limit: '12kb', parameterLimit: 20 });
  const limit = authLimiter();
  const mutations = new WindowLimiter(60, 60_000);
  const sessionCookie = (res, raw) => res.cookie('ulsa_session', raw, {
    httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: 7 * 86400_000,
  });
  const authPage = (res, mode, error = '', values = {}, status = 200) => res.status(status).render('console/auth', {
    active: 'console', mode, error, values,
  });
  for (const mode of ['login', 'register']) {
    router.get('/' + mode, (req, res) => req.accountSession ? res.redirect(303, '/console') : authPage(res, mode));
    router.post('/' + mode, parse, requireCsrf, limit, async (req, res) => {
      try {
        const values = { email: field(req, 'email'), password: field(req, 'password'), name: field(req, 'name') };
        const user = mode === 'register' ? await accounts.register(values) : await accounts.login(values.email, values.password);
        accounts.logout(req.sessionToken);
        const session = accounts.createSession(user.id);
        sessionCookie(res, session.raw);
        res.redirect(303, '/console');
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        authPage(res, mode, error.message, { email: field(req, 'email'), name: field(req, 'name') }, error.status);
      }
    });
  }
  router.post('/logout', parse, requireOwner, requireCsrf, (req, res) => {
    accounts.logout(req.sessionToken);
    res.clearCookie('ulsa_session', { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/' });
    res.redirect(303, '/login');
  });
  router.use('/console', requireOwner);
  router.use('/console', (req, res, next) => {
    const wait = req.method === 'POST' ? mutations.take(req.accountSession.user.id) : 0;
    if (wait) { res.set('Retry-After', String(wait)); return next(new ApiError(429, 'console_rate_limit', 'Слишком много изменений. Повторите позже.')); }
    next();
  });
  router.get('/console', (req, res) => res.render('console/projects', {
    active: 'console', projects: accounts.projects(req.accountSession.user.id),
  }));
  router.post('/console/projects', parse, requireCsrf, (req, res) => {
    const project = accounts.createProject(req.accountSession.user.id, field(req, 'name'));
    res.redirect(303, `/console/projects/${project.id}`);
  });
  router.get('/console/projects/:projectId', (req, res) => {
    const owner = req.accountSession.user;
    const project = accounts.project(owner.id, req.params.projectId);
    res.render('console/project', { active: 'console', project, applications: accounts.applications(owner.id, project.id) });
  });
  router.post('/console/projects/:projectId/settings', parse, requireCsrf, (req, res) => {
    const owner = req.accountSession.user;
    accounts.updateProject(owner.id, req.params.projectId, field(req, 'name'), field(req, 'archived') === '1');
    grafana?.invalidate(owner.id);
    res.redirect(303, `/console/projects/${req.params.projectId}`);
  });
  const applicationPage = (req, res, app, rawKey = '') => res.render('console/application', {
    active: 'console', application: app, keys: accounts.keys(req.accountSession.user.id, app.id),
    rawKey, endpoint: config.publicUrl, grafanaAvailable: !!grafana,
  });
  router.post('/console/projects/:projectId/apps', parse, requireCsrf, (req, res) => {
    const owner = req.accountSession.user;
    const result = accounts.createApplication(owner.id, req.params.projectId, {
      name: field(req, 'name'), platform: field(req, 'platform'), identifier: field(req, 'identifier'),
    });
    grafana?.invalidate(owner.id);
    // Full sending keys are shown once in this response, never in a URL or persistent browser storage.
    applicationPage(req, res, result.application, result.key);
  });
  router.get('/console/apps/:appId', (req, res) => {
    applicationPage(req, res, accounts.application(req.accountSession.user.id, req.params.appId));
  });
  router.post('/console/apps/:appId/keys/rotate', parse, requireCsrf, (req, res) => {
    const ownerId = req.accountSession.user.id;
    const raw = accounts.rotateKey(ownerId, req.params.appId);
    applicationPage(req, res, accounts.application(ownerId, req.params.appId), raw);
  });
  router.post('/console/apps/:appId/keys/:keyId/revoke', parse, requireCsrf, (req, res) => {
    accounts.revokeKey(req.accountSession.user.id, req.params.appId, req.params.keyId);
    res.redirect(303, `/console/apps/${req.params.appId}`);
  });
  router.get('/console/apps/:appId/stats', (req, res) => {
    const application = accounts.application(req.accountSession.user.id, req.params.appId);
    if (!grafana) throw new ApiError(503, 'grafana_unavailable', 'Запустите стенд с Grafana для просмотра графиков.');
    res.render('console/statistics', { active: 'console', application, dashboardProvider: 'grafana',
      privateDashboardUrl: `/grafana/d/${application.id}/events`,
    });
  });
  router.get('/console/apps/:appId/data', async (req, res) => {
    const application = accounts.application(req.accountSession.user.id, req.params.appId);
    const raw = req.query.days ?? '7';
    if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 90) throw new ApiError(400, 'invalid_days', 'Период: от 1 до 90 дней.');
    res.json({ application: { id: application.id, name: application.name },
      ...await store.stats(application.id, Number(raw)), recent: await store.recent(application.id),
    });
  });
  router.get('/sdk-demo', (req, res) => res.render('console/sdk-demo', { active: 'console', endpoint: config.publicUrl }));
  router.get('/console/apps/:appId/test', (req, res) => {
    const application = accounts.application(req.accountSession.user.id, req.params.appId);
    res.render('console/test', { active: 'console', application });
  });
  router.post('/console/apps/:appId/test', parse, requireCsrf, async (req, res) => {
    const application = accounts.application(req.accountSession.user.id, req.params.appId);
    if (application.archived) throw new ApiError(409, 'project_archived', 'Сначала восстановите проект.');
    const events = validateBatch({ schemaVersion: 1, events: [{ eventId: randomUUID(), sessionId: randomUUID(),
      occurredAt: new Date().toISOString(), name: field(req, 'name'), screen: field(req, 'screen') || null,
      platform: application.platform, appVersion: SERVER_VERSION, properties: { source: 'console_test' } }] });
    await store.ingest(application.id, events);
    res.redirect(303, `/console/apps/${application.id}/stats`);
  });
  return router;
}

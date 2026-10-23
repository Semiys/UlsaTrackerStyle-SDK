import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WindowLimiter } from './accounts.js';
import { ApiError } from './errors.js';
import { LAB_IMAGE_VERSION } from './version.js';

export class GrafanaCabinet {
  constructor({ config, accounts, store }) {
    Object.assign(this, { config, accounts, store });
    this.inFlight = new Map();
    this.ready = new Map();
    this.queryRate = new WindowLimiter(180, 60_000);
  }
  credentials(ownerId) {
    return { login: ownerId, password: this.accounts.derive('grafana-user:' + ownerId) };
  }
  async api(path, { method = 'GET', body, orgId, allowMissing = false } = {}) {
    const response = await fetch(new URL('/grafana' + path, this.config.grafanaInternalUrl), {
      method, headers: { Authorization: 'Basic ' + Buffer.from(`${this.config.grafanaAdminUser}:${this.config.grafanaAdminPassword}`).toString('base64'),
        ...(orgId ? { 'X-Grafana-Org-Id': String(orgId) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Grafana provisioning failed (${response.status})`);
    return response.json();
  }
  async prepare(owner) {
    if (!this.store.client) throw new ApiError(503, 'grafana_unavailable', 'Панель доступна на стенде с ClickHouse.');
    if (this.inFlight.has(owner.id)) return this.inFlight.get(owner.id);
    const operation = this.prepareOwner(owner).finally(() => this.inFlight.delete(owner.id));
    this.inFlight.set(owner.id, operation);
    return operation;
  }
  async prepareOwner(owner) {
    const applications = this.accounts.ownerApplications(owner.id);
    const signature = applications.map(a => `${a.id}:${a.name}`).join('|');
    const cached = this.ready.get(owner.id);
    if (cached?.signature === signature && cached.until > Date.now()) return cached.identity;
    const orgName = 'UlsaTracker ' + owner.id;
    let org = await this.api('/api/orgs/name/' + encodeURIComponent(orgName), { allowMissing: true });
    if (!org) org = { id: (await this.api('/api/orgs', { method: 'POST', body: { name: orgName } })).orgId };
    const credentials = this.credentials(owner.id);
    let user = await this.api('/api/users/lookup?loginOrEmail=' + encodeURIComponent(credentials.login), { allowMissing: true });
    if (!user) user = await this.api('/api/admin/users', { method: 'POST', body: { name: owner.name, login: credentials.login,
      email: `${owner.id}@sdk.invalid`, password: credentials.password, OrgId: org.id } });
    const orgUsers = await this.api(`/api/orgs/${org.id}/users`);
    if (!orgUsers.some(x => Number(x.userId) === Number(user.id))) {
      await this.api(`/api/orgs/${org.id}/users`, { method: 'POST', body: { loginOrEmail: credentials.login, role: 'Viewer' } });
    } else {
      await this.api(`/api/orgs/${org.id}/users/${user.id}`, { method: 'PATCH', body: { role: 'Viewer' } });
    }
    // A private reader has one organization; the public demo remains separate.
    const memberships = await this.api(`/api/users/${user.id}/orgs`);
    if (memberships.some(x => Number(x.orgId) === 1) && Number(org.id) !== 1) {
      await this.api(`/api/orgs/1/users/${user.id}`, { method: 'DELETE' });
    }
    const suffix = owner.id.replace(/^u_/, '');
    if (!/^[a-f0-9]{32}$/.test(suffix) || applications.some(a => !/^a_[a-f0-9]{32}$/.test(a.id))) throw new Error('Invalid internal identity');
    const reader = 'owner_' + suffix;
    const password = this.accounts.derive('clickhouse-reader:' + owner.id);
    const allowed = applications.length ? `project_id IN (${applications.map(a => `'${a.id}'`).join(',')})` : '0';
    await this.store.client.command({ query: `CREATE USER IF NOT EXISTS ${reader} IDENTIFIED WITH sha256_password BY '${password}' SETTINGS PROFILE 'grafana_readonly'` });
    await this.store.client.command({ query: `GRANT SELECT ON ${this.config.clickhouse.database}.events TO ${reader}` });
    await this.store.client.command({ query: `CREATE ROW POLICY IF NOT EXISTS ${reader} ON ${this.config.clickhouse.database}.events FOR SELECT USING ${allowed} TO ${reader}` });
    await this.store.client.command({ query: `ALTER ROW POLICY ${reader} ON ${this.config.clickhouse.database}.events FOR SELECT USING ${allowed} TO ${reader}` });
    const source = { uid: 'owner-events', name: 'ClickHouse · мои приложения', type: 'grafana-clickhouse-datasource', access: 'proxy', isDefault: true,
      jsonData: { host: 'db', port: 8123, protocol: 'http', secure: false, username: reader,
        defaultDatabase: this.config.clickhouse.database, dialTimeout: '10', queryTimeout: '30' }, secureJsonData: { password } };
    const exists = await this.api('/api/datasources/uid/owner-events', { orgId: org.id, allowMissing: true });
    await this.api(exists ? '/api/datasources/uid/owner-events' : '/api/datasources', { orgId: org.id, method: exists ? 'PUT' : 'POST', body: source });
    const template = JSON.parse(await readFile(new URL('../grafana/provisioning/dashboards/ulsatracker.json', import.meta.url), 'utf8'));
    for (const application of applications) {
      const dashboard = JSON.parse(JSON.stringify(template).replaceAll('ulsatracker-clickhouse', 'owner-events').replaceAll("'lab3-demo'", `'${application.id}'`));
      dashboard.id = null; dashboard.uid = application.id; dashboard.title = `${application.name} · ${LAB_IMAGE_VERSION}`;
      dashboard.tags = ['UlsaTrackerStyle', 'application']; dashboard.links = [
        { title: 'Мой кабинет', type: 'link', url: `${this.config.publicUrl}/console`, targetBlank: true },
        { title: 'Подключение приложения', type: 'link', url: `${this.config.publicUrl}/console/apps/${application.id}`, targetBlank: true },
      ];
      await this.api('/api/dashboards/db', { orgId: org.id, method: 'POST', body: { dashboard, overwrite: true } });
    }
    const identity = { orgId: Number(org.id), userId: Number(user.id), ...credentials };
    this.accounts.setGrafanaOwner(owner.id, identity.orgId, identity.userId);
    this.ready.set(owner.id, { signature, identity, until: Date.now() + 30_000 });
    if (this.ready.size > 1000) this.ready.delete(this.ready.keys().next().value);
    return identity;
  }
  invalidate(ownerId) { this.ready.delete(ownerId); }
  proxy() {
    return async (req, res, next) => {
      try {
        const incoming = new URL(req.originalUrl, 'http://gateway.invalid');
        if (!incoming.pathname.startsWith('/grafana/')) return res.redirect(302, '/grafana/');
        const path = incoming.pathname.slice('/grafana'.length);
        const allowedGet = /^\/(?:$|public\/|d\/|dashboards(?:\/|$)|api\/(?:frontend\/settings|health|search|dashboards\/uid\/|datasources(?:\/|$)|plugins\/|user(?:\/preferences)?$|org$|folders(?:\/|$)|annotations$|prometheus\/grafana\/api\/v1\/rules$|ruler\/grafana\/api\/v1\/rules$|access-control\/user\/permissions$))/.test(path);
        const allowedPost = path === '/api/ds/query';
        if (!(req.method === 'GET' && allowedGet) && !(req.method === 'POST' && allowedPost)) {
          if (req.method === 'POST' && path === '/api/frontend-metrics') return res.sendStatus(204);
          return res.status(403).json({ message: 'Доступен только просмотр аналитики.' });
        }
        const headers = { accept: req.headers.accept ?? '*/*', 'accept-encoding': 'identity' };
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
        if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
        if (req.headers['content-length'] && Number(req.headers['content-length']) > 65536) return res.sendStatus(413);
        if (req.method === 'POST') {
          const wait = this.queryRate.take(req.accountSession?.user.id ?? req.socket.remoteAddress);
          if (wait) { res.set('Retry-After', String(wait)); return res.sendStatus(429); }
        }
        const selectedDemo = this.config.demoMode && (incoming.searchParams.get('orgId') === '1'
          || req.get('X-Grafana-Org-Id') === '1' || path.startsWith('/d/ulsatracker/'));
        if (req.accountSession && !selectedDemo) {
          const identity = await this.prepare(req.accountSession.user);
          headers.Authorization = 'Basic ' + Buffer.from(`${identity.login}:${identity.password}`).toString('base64');
          headers['X-Grafana-Org-Id'] = String(identity.orgId);
          incoming.searchParams.set('orgId', String(identity.orgId));
        } else {
          if (!this.config.demoMode) return res.sendStatus(401);
          incoming.searchParams.set('orgId', '1');
        }
        const target = new URL(incoming.pathname + incoming.search, this.config.grafanaInternalUrl);
        const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: req.method, headers, timeout: 30_000 }, upstream => {
          res.status(upstream.statusCode ?? 502);
          for (const key of ['content-type', 'content-length', 'content-encoding', 'etag', 'last-modified']) {
            if (upstream.headers[key]) res.set(key, upstream.headers[key]);
          }
          if (upstream.headers.location) {
            const location = new URL(upstream.headers.location, target);
            if (location.origin !== target.origin || !location.pathname.startsWith('/grafana/')) { upstream.resume(); return res.sendStatus(502); }
            res.set('Location', location.pathname + location.search);
          }
          // Grafana cookies/credentials are never exposed through the gateway.
          res.set('Cache-Control', 'private, no-store');
          res.removeHeader('Content-Security-Policy');
          res.set('Content-Security-Policy', `frame-ancestors 'self' ${new URL(this.config.publicUrl).origin}`);
          upstream.on('error', () => res.destroy());
          upstream.pipe(res);
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => { if (!res.headersSent) res.status(502).send('Панель временно недоступна. Повторите позже.'); else res.destroy(); });
        req.on('aborted', () => request.destroy());
        res.on('close', () => { if (!res.writableEnded) request.destroy(); });
        request.end(Buffer.isBuffer(req.body) ? req.body : undefined);
      } catch (error) { next(new ApiError(503, 'grafana_unavailable', 'Не удалось подготовить панель. Повторите позже.')); }
    };
  }
}

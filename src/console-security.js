import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
import { WindowLimiter } from './accounts.js';
import { randomBytes } from 'node:crypto';

export function cookieValue(req, name) {
  const item = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  try { return item ? decodeURIComponent(item.slice(name.length + 1)) : ''; } catch { return ''; }
}
export function sessionMiddleware(accounts, config) {
  return (req, res, next) => {
    const raw = cookieValue(req, 'ulsa_session');
    req.accountSession = accounts.session(raw);
    req.sessionToken = raw;
    res.locals.consoleEnabled = true;
    res.locals.currentUser = req.accountSession?.user ?? null;
    let nonce = cookieValue(req, 'ulsa_form');
    if (!/^[\w-]{43}$/.test(nonce)) {
      nonce = randomBytes(32).toString('base64url');
      res.cookie('ulsa_form', nonce, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: 3600_000 });
    }
    res.locals.consoleCsrf = req.accountSession?.csrf ?? createHmac('sha256', accounts.secret).update('form:' + nonce).digest('hex');
    next();
  };
}
export function requireOwner(req, res, next) {
  if (!req.accountSession) return res.redirect(303, '/login');
  next();
}
export function requireCsrf(req, res, next) {
  const value = req.body?.csrfToken;
  const expected = res.locals.consoleCsrf;
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/.test(value) || typeof expected !== 'string' || value.length !== expected.length
      || !timingSafeEqual(Buffer.from(value), Buffer.from(expected))) return next(new ApiError(403, 'invalid_form', 'Проверка формы не пройдена. Откройте страницу заново.'));
  next();
}
export function authLimiter() {
  const addresses = new WindowLimiter(40, 15 * 60_000);
  const emails = new WindowLimiter(12, 15 * 60_000);
  return (req, res, next) => {
    const ipWait = addresses.take(req.socket.remoteAddress ?? 'unknown');
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    const wait = Math.max(ipWait, email ? emails.take(email) : 0);
    if (wait) { res.set('Retry-After', String(wait)); return next(new ApiError(429, 'auth_rate_limit', 'Слишком много попыток. Попробуйте позже.')); }
    next();
  };
}

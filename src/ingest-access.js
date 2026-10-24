import { createHash, timingSafeEqual } from 'node:crypto';
import { WindowLimiter } from './accounts.js';
import { ApiError } from './errors.js';

export function ingestAccess({ config, accounts }) {
  const rate = new WindowLimiter(120, 60_000);
  const expected = createHash('sha256').update(config.ingestKey).digest();
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const authorization = req.get('Authorization') ?? '';
    const raw = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const hash = createHash('sha256').update(raw).digest();
    let application = null;
    if (!raw || !timingSafeEqual(expected, hash)) {
      application = accounts?.resolveKey(raw);
      if (!application) return next(new ApiError(401, 'unauthorized', 'Нужен действующий ключ отправки.'));
    }
    const origin = req.get('Origin');
    if (origin) {
      const allowed = application?.platform === 'web' ? application.identifier : (config.demoMode && !application ? new URL(config.publicUrl ?? 'http://localhost:8080').origin : null);
      if (origin !== allowed) return next(new ApiError(403, 'origin_denied', 'Origin сайта не совпадает с настройкой приложения.'));
      res.set('Access-Control-Allow-Origin', origin); res.vary('Origin');
    }
    const wait = rate.take(hash.toString('hex'));
    if (wait) { res.set('Retry-After', String(wait)); return next(new ApiError(429, 'rate_limit', 'Лимит отправки: повторите пакет позже.')); }
    req.analyticsApplication = application;
    next();
  };
}
export function ingestPreflight({ accounts, config }) {
  return (req, res) => {
    const origin = req.get('Origin');
    const allowed = origin && (accounts?.hasWebOrigin(origin) || (config.demoMode && origin === new URL(config.publicUrl).origin));
    if (!allowed || req.get('Access-Control-Request-Method') !== 'POST') return res.sendStatus(403);
    res.set('Access-Control-Allow-Origin', origin); res.vary('Origin');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '600'); res.sendStatus(204);
  };
}

(function (root) {
  'use strict';
  const VERSION = '0.1.0';
  const NAME = /^[a-z][a-z0-9_]{0,63}$/;
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const uuid = () => {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const value = root.crypto.getRandomValues(new Uint8Array(16));
    value[6] = (value[6] & 15) | 64; value[8] = (value[8] & 63) | 128;
    const s = Array.from(value, v => v.toString(16).padStart(2, '0')).join('');
    return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
  };
  function normalize(name, screen, properties) {
    if (typeof name !== 'string' || !NAME.test(name) || (screen != null && (typeof screen !== 'string' || !NAME.test(screen)))) return null;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 16) return null;
    const result = {};
    for (const key of Object.keys(properties).sort()) {
      const value = properties[key];
      if (!NAME.test(key) || ['__proto__','constructor','prototype'].includes(key)) return null;
      if (!(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 256))) return null;
      result[key] = value;
    }
    return bytes(result) <= 4096 ? { name, screen: screen ?? null, properties: result } : null;
  }
  function create(options) {
    if (!options || !root.crypto?.getRandomValues) throw new Error('UlsaTracker requires Web Crypto. Use a modern browser and HTTPS.');
    const endpoint = new URL(options.endpoint);
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && options.allowHttp === true)) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Invalid SDK endpoint');
    if (typeof options.ingestKey !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(options.ingestKey)) throw new Error('Invalid sending key');
    const appVersion = options.appVersion ?? '1.0.0';
    if (typeof appVersion !== 'string' || appVersion.length < 1 || appVersion.length > 32) throw new Error('Invalid app version');
    const request = options.fetch ?? root.fetch?.bind(root);
    if (!request) throw new Error('Fetch API is unavailable');
    const namespace = `ulsa-tracker:${endpoint.origin}:${options.ingestKey}`;
    let storage;
    try { storage = options.storage ?? root.localStorage; } catch { storage = null; }
    const read = key => { try { return storage?.getItem(namespace + key); } catch { return null; } };
    const write = (key, value) => { try { storage?.setItem(namespace + key, value); return !!storage; } catch { return false; } };
    const remove = key => { try { storage?.removeItem(namespace + key); } catch {} };
    const maxQueue = Math.max(1, Math.min(1000, Math.trunc(options.maxQueue ?? 500) || 500));
    const interval = Math.max(1000, Math.min(300000, options.flushIntervalMs ?? 30000));
    let batchSize = 20, queue = [], enabled = read(':enabled') !== '0' && options.enabled !== false;
    let closed = false, inFlight = null, abort = null, retryTimer = null, generation = 0;
    let notBefore = 0, cycleAt = 0, attempts = 0, paused = '', accepted = 0, dropped = 0, rejected = 0, failures = 0, lastStatus = '';
    let sessionId = uuid(), lastActivity = Date.now();
    try {
      const saved = JSON.parse(root.sessionStorage?.getItem(namespace + ':session') ?? 'null');
      if (saved && /^[a-f0-9-]{36}$/.test(saved.id) && Date.now() - saved.at < 1800000) { sessionId = saved.id; lastActivity = saved.at; }
    } catch {}
    const persist = () => {
      if (options.persist === true && enabled) write(':outbox', JSON.stringify({ version: 1, queue, notBefore }));
      else remove(':outbox');
    };
    const prune = () => {
      const now = Date.now();
      const next = queue.filter(e => now - Date.parse(e.occurredAt) <= 7 * 86400000 && Date.parse(e.occurredAt) <= now + 300000);
      dropped += queue.length - next.length; queue = next;
      if (queue.length > maxQueue) { dropped += queue.length - maxQueue; queue = queue.slice(-maxQueue); }
    };
    if (options.persist === true && enabled) {
      try {
        const saved = JSON.parse(read(':outbox') ?? 'null');
        if (saved?.version === 1 && Array.isArray(saved.queue) && saved.queue.length <= 1000) {
          queue = saved.queue.filter(e => e && e.platform === 'web' && /^[a-f0-9-]{36}$/.test(e.eventId) && /^[a-f0-9-]{36}$/.test(e.sessionId)
            && Number.isFinite(Date.parse(e.occurredAt)) && typeof e.appVersion === 'string' && e.appVersion.length <= 32 && normalize(e.name, e.screen, e.properties));
          notBefore = Number.isFinite(saved.notBefore) ? Math.min(saved.notBefore, Date.now() + 86400000) : 0;
          prune();
        }
      } catch { lastStatus = 'storage_unreadable'; }
    } else remove(':outbox');
    const status = () => ({ version: VERSION, queued: queue.length, enabled, closed, paused, accepted, dropped, rejected, failures, lastStatus, nextRetryAt: Math.max(notBefore, cycleAt) });
    const later = delay => {
      if (closed || !enabled || paused || retryTimer) return;
      retryTimer = root.setTimeout(() => { retryTimer = null; void flush(); }, delay);
      retryTimer?.unref?.();
    };
    const fail = (response, reason) => {
      failures++; lastStatus = reason; attempts++;
      const header = response?.headers?.get?.('Retry-After');
      let delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 0;
      if (!Number.isFinite(delay) || delay <= 0) delay = Math.min(30000, 1000 * (2 ** (attempts - 1))) + Math.floor(Math.random() * 500);
      delay = Math.max(1000, Math.min(86400000, delay));
      notBefore = Date.now() + delay;
      if (attempts >= 3) cycleAt = Math.max(notBefore, Date.now() + interval);
      else later(delay);
      persist();
    };
    async function send() {
      prune(); if (!queue.length) return status();
      const sent = [];
      for (const event of queue.slice(0, batchSize)) {
        sent.push(event); if (bytes({ schemaVersion: 1, events: sent }) > 60000) { sent.pop(); break; }
      }
      if (!sent.length) { queue.shift(); rejected++; persist(); return status(); }
      const currentGeneration = generation;
      abort = new AbortController();
      const deadline = root.setTimeout(() => abort?.abort(), 10000); deadline?.unref?.();
      try {
        const response = await request(new URL('/api/v1/events', endpoint).href, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + options.ingestKey },
          body: JSON.stringify({ schemaVersion: 1, events: sent }), mode: 'cors', credentials: 'omit',
          redirect: 'error', cache: 'no-store', signal: abort.signal, keepalive: true,
        });
        if (generation !== currentGeneration || closed || !enabled) return status();
        if (response.status === 401 || response.status === 403) { paused = 'unauthorized'; lastStatus = 'unauthorized'; return status(); }
        if (response.status === 413) {
          if (sent.length > 1) batchSize = Math.max(1, Math.floor(sent.length / 2));
          else { queue = queue.filter(e => e.eventId !== sent[0].eventId); rejected++; }
          lastStatus = 'payload_too_large'; persist(); later(1000); return status();
        }
        if (response.status === 400 || response.status === 409) {
          let body; try { body = await response.json(); } catch {}
          const match = body?.error?.field?.match(/^events\[(\d+)\]/);
          const bad = match && sent[Number(match[1])] ? [sent[Number(match[1])]] : sent;
          const ids = new Set(bad.map(e => e.eventId)); queue = queue.filter(e => !ids.has(e.eventId)); rejected += bad.length;
          lastStatus = 'invalid_event'; persist(); later(1000); return status();
        }
        if (response.status !== 200) { fail(response, 'http_' + response.status); return status(); }
        let reply; try { const body = await response.text(); if (body.length <= 8192) reply = JSON.parse(body); } catch {}
        const ids = sent.map(e => e.eventId), ack = reply?.acknowledgedEventIds;
        if (reply?.schemaVersion !== 1 || !Number.isInteger(reply.accepted) || !Number.isInteger(reply.duplicates)
            || reply.accepted < 0 || reply.duplicates < 0 || reply.accepted + reply.duplicates !== sent.length
            || !Array.isArray(ack) || ack.length !== ids.length || new Set(ack).size !== ids.length || !ids.every(v => ack.includes(v))) {
          fail(null, 'invalid_ack'); return status();
        }
        const acknowledged = new Set(ack); queue = queue.filter(e => !acknowledged.has(e.eventId));
        accepted += sent.length; attempts = 0; cycleAt = 0; notBefore = 0; lastStatus = 'ok'; persist();
        if (queue.length) later(0);
        return status();
      } catch {
        if (generation === currentGeneration && !closed && enabled) fail(null, 'network_error');
        return status();
      } finally { root.clearTimeout(deadline); abort = null; }
    }
    function flush() {
      if (inFlight) return inFlight;
      if (closed || !enabled || paused || Date.now() < Math.max(notBefore, cycleAt)) return Promise.resolve(status());
      if (attempts >= 3) { attempts = 0; cycleAt = 0; }
      inFlight = send().finally(() => { inFlight = null; });
      return inFlight;
    }
    const track = (name, options = {}) => {
      if (closed || !enabled) return false;
      const event = normalize(name, options.screen, options.properties ?? {}); if (!event) { rejected++; return false; }
      const now = Date.now(); if (now - lastActivity >= 1800000) sessionId = uuid(); lastActivity = now;
      try { root.sessionStorage?.setItem(namespace + ':session', JSON.stringify({ id: sessionId, at: now })); } catch {}
      queue.push({ eventId: uuid(), sessionId, occurredAt: new Date(now).toISOString(), ...event, platform: 'web', appVersion });
      prune(); persist(); if (queue.length >= batchSize) void flush(); return true;
    };
    const visibility = () => { if (root.document?.visibilityState === 'hidden') void flush(); };
    const online = () => { void flush(); };
    root.document?.addEventListener('visibilitychange', visibility); root.addEventListener?.('online', online);
    const timer = root.setInterval(() => { void flush(); }, interval); timer?.unref?.();
    return {
      track, screen: name => track('screen_view', { screen: name }), click: (button, screen = null) => track('button_click', { screen, properties: { button } }),
      flush, getStatus: status,
      setCollectionEnabled(value) {
        enabled = value === true; generation++; abort?.abort(); root.clearTimeout(retryTimer); retryTimer = null;
        write(':enabled', enabled ? '1' : '0');
        if (!enabled) { queue = []; remove(':outbox'); }
        else { paused = ''; attempts = 0; notBefore = 0; cycleAt = 0; }
      },
      close() { closed = true; generation++; abort?.abort(); root.clearInterval(timer); root.clearTimeout(retryTimer);
        root.document?.removeEventListener('visibilitychange', visibility); root.removeEventListener?.('online', online); },
    };
  }
  root.UlsaTracker = Object.freeze({ version: VERSION, create });
})(globalThis);

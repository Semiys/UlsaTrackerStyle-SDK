import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2' };
export function createFrontendServer({ apiUrl, distDir, publicUrl = 'http://localhost:8080' }) {
  const upstream = new URL(apiUrl), origin = new URL(publicUrl), root = resolve(distDir);
  if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.pathname !== '/') throw new Error('Invalid API upstream');
  if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/') throw new Error('Invalid public origin');
  return createServer(async (req, res) => {
    let path; try { path = new URL(req.url, 'http://frontend').pathname; } catch { res.writeHead(400); return res.end(); }
    const proxy = /^\/(?:api(?:\/|$)|grafana(?:\/|$)|sdk(?:\/|$)|health$|dashboard(?:\/|$)|events(?:\/|$)|error$|sdk-demo$)/.test(path)
      || /^\/console\/apps\/[^/]+\/(?:range|data|export\.(?:csv|json))$/.test(path)
      || /^\/[a-zA-Z0-9-]+\.(?:css|js|mjs)$/.test(path) && path !== '/theme-init.js';
    if (proxy) {
      const headers = { ...req.headers };
      for (const name of ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','connection','proxy-authorization','proxy-connection','keep-alive','te','trailer','transfer-encoding','upgrade']) delete headers[name];
      // One explicit, private reverse-proxy hop; never append caller-supplied identity.
      headers.host = req.headers.host ?? origin.host;
      headers['x-forwarded-for'] = req.socket.remoteAddress ?? '';
      headers['x-forwarded-host'] = origin.host; headers['x-forwarded-proto'] = origin.protocol.slice(0,-1);
      const target = httpRequest({ hostname:upstream.hostname,port:upstream.port || 80,method:req.method,path:req.url,headers }, response => {
        const responseHeaders = { ...response.headers }; delete responseHeaders.connection; delete responseHeaders['transfer-encoding'];
        res.writeHead(response.statusCode ?? 502,responseHeaders); response.pipe(res);
        response.on('error', () => res.destroy());
      });
      target.setTimeout(65000, () => target.destroy());
      target.on('error', () => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502,{ 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' });
        res.end(JSON.stringify({ error:{ code:'api_unavailable',message:'Сервис временно недоступен. Повторите подключение позже.' } }));
      });
      req.on('aborted', () => target.destroy());
      res.on('close', () => { if (!res.writableEnded) target.destroy(); });
      req.pipe(target); return;
    }
    const security = { 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    };
    if (path === '/frontend-health') { res.writeHead(200,{ ...security,'Content-Type':'application/json','Cache-Control':'no-store' }); return res.end('{"status":"ok"}'); }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405,{ ...security,Allow:'GET, HEAD' }); return res.end(); }
    const spa = ['/', '/guide','/login','/register','/console'].includes(path) || /^\/console\/(?:projects|apps)\/[^/]+(?:\/(?:test|stats))?$/.test(path);
    let decoded; try { decoded = decodeURIComponent(path); } catch { res.writeHead(400,security); return res.end(); }
    const filename = spa ? resolve(root,'index.html') : resolve(root,'.' + decoded);
    if (!filename.startsWith(root + sep) || decoded.includes('\\') || decoded.split('/').some(x => x.startsWith('.'))) { res.writeHead(404,security); return res.end(); }
    try {
      const info = await stat(filename); if (!info.isFile()) throw new Error();
      res.writeHead(200,{ ...security,'Content-Type':types[extname(filename)] ?? 'application/octet-stream','Content-Length':info.size,
        'Cache-Control':path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(filename).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404,{ ...security,'Content-Type':'text/plain; charset=utf-8' }); res.end('Страница не найдена.'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid frontend port');
  const server = createFrontendServer({ apiUrl:process.env.API_UPSTREAM ?? 'http://app:8080',distDir:fileURLToPath(new URL('./dist/',import.meta.url)),publicUrl:process.env.PUBLIC_URL ?? 'http://localhost:8080' });
  server.listen(port,'0.0.0.0', () => console.log('UlsaTrackerStyle frontend on port ' + port));
  for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1),10000).unref(); });
}

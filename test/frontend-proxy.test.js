import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrontendServer } from '../frontend/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'ulsa-static-'));
  await mkdir(join(root,'assets')); await writeFile(join(root,'index.html'),'<div id="root">React</div>'); await writeFile(join(root,'assets','app.js'),'export const frontend=true;');
  const backend = createServer((req,res) => {
    if (req.url === '/grafana/api/test') { res.writeHead(200,{ 'Content-Security-Policy':"script-src 'nonce-upstream'; frame-ancestors 'self'",'Set-Cookie':'upstream=ok; HttpOnly; SameSite=Lax' }); return res.end('Grafana'); }
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ path:req.url,headers:req.headers }));
  }).listen(0,'127.0.0.1'); await once(backend,'listening');
  const server = createFrontendServer({ apiUrl:'http://127.0.0.1:' + backend.address().port,distDir:root,publicUrl:'https://analytics.example.test' }).listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>backend.close(r))]); await rm(root,{recursive:true,force:true}); });
  return { base:'http://127.0.0.1:'+server.address().port, backend };
}
test('production frontend serves deep links with strict CSP and assets without a development server', async t => {
  const {base}=await fixture(t);
  for (const path of ['/','/login','/register','/guide','/console','/console/projects/p_123','/console/apps/a_123/stats']) {
    const response=await fetch(base+path); assert.equal(response.status,200); assert.equal(await response.text(),'<div id="root">React</div>');
    assert.equal(response.headers.get('cache-control'),'no-store'); assert.match(response.headers.get('content-security-policy'),/script-src 'self'/); assert.doesNotMatch(response.headers.get('content-security-policy'),/unsafe-inline|unsafe-eval/);
  }
  const asset=await fetch(base+'/assets/app.js'); assert.equal(asset.status,200); assert.match(asset.headers.get('cache-control'),/immutable/);
  assert.equal((await fetch(base+'/assets/app.js',{method:'HEAD'})).headers.get('content-length'),'27');
});
test('frontend proxy overwrites spoofed forwarding identity and preserves cookies, origin, auth and Grafana CSP', async t => {
  const {base}=await fixture(t);
  const r=await fetch(base+'/api/console/session?x=1',{headers:{'X-Forwarded-For':'203.0.113.42','X-Forwarded-Host':'evil.test','X-Forwarded-Proto':'http',Forwarded:'for=evil',Origin:'https://site.test',Authorization:'Bearer SDK-key',Cookie:'ulsa_session=opaque'}});
  const data=await r.json(); assert.equal(data.path,'/api/console/session?x=1'); assert.equal(data.headers['x-forwarded-for'],'127.0.0.1'); assert.equal(data.headers['x-forwarded-host'],'analytics.example.test'); assert.equal(data.headers['x-forwarded-proto'],'https'); assert.equal(data.headers.forwarded,undefined);
  assert.equal(data.headers.authorization,'Bearer SDK-key'); assert.equal(data.headers.cookie,'ulsa_session=opaque'); assert.equal(data.headers.origin,'https://site.test');
  const panel=await fetch(base+'/grafana/api/test'); assert.match(panel.headers.get('content-security-policy'),/nonce-upstream/); assert.match(panel.headers.get('set-cookie'),/HttpOnly/);
});
test('frontend refuses filesystem traversal, hidden files and unsupported static mutations', async t => {
  const {base}=await fixture(t);
  for(const path of ['/.env','/../accounts.sqlite','/%2e%2e%2fprivate','/assets/%5c..%5c.env','/metrics','/unknown']) assert.equal((await fetch(base+path)).status,404,path);
  assert.equal((await fetch(base+'/console',{method:'POST',body:'x'})).status,405);
  const health=await fetch(base+'/frontend-health'); assert.deepEqual(await health.json(),{status:'ok'});
});
test('frontend reports unavailable API as JSON without falling back to the SPA', async t => {
  const {base,backend}=await fixture(t); backend.closeAllConnections(); await new Promise(r=>backend.close(r));
  const response=await fetch(base+'/api/console/session'); assert.equal(response.status,502); assert.equal((await response.json()).error.code,'api_unavailable');
});

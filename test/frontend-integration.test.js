import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browserClient } from './helpers/browser-client.mjs';
import { createTracker } from '../sdk/js/index.mjs';
const base=process.env.FRONTEND_TEST_URL;
const integration={skip:!base};
function jsonClient() {
  const c=browserClient(base); let csrf='';
  const api=(path,body)=>c.request('/api/console'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,csrfToken:csrf})});
  const register=async()=>{
    csrf=(await(await api('/session')).json()).csrfToken;
    const response=await api('/register',{name:'React verification',email:randomUUID()+'@example.test',password:'isolated-react-test-password'});
    assert.equal(response.status,200);csrf=(await response.json()).csrfToken;
  };
  return {...c,api,register};
}
test('React production routes, assets, direct links and API errors work through the frontend container',integration,async()=>{
  for(const path of ['/','/login','/register','/guide','/console','/console/apps/a_unknown/stats']) {
    const response=await fetch(base+path);const html=await response.text();assert.equal(response.status,200);assert.match(html,/<div id="root">/);assert.match(html,/type="module"/);assert.doesNotMatch(html,/@vite\/client/);
    assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    for(const asset of [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m=>m[1]))assert.equal((await fetch(base+asset)).status,200);
  }
  const missing=await fetch(base+'/api/console/not-real');assert.equal(missing.status,401);assert.match(missing.headers.get('content-type'),/json/);
  assert.equal((await fetch(base+'/metrics')).status,404);
});
test('React API, Web SDK, Grafana and exports retain isolation and ACK deduplication through the public gateway',integration,async()=>{
  const a=jsonClient(),b=jsonClient();await a.register();await b.register();
  const session=await(await a.api('/session')).json(),origin=session.endpoint;
  const created=await a.api('/projects',{name:'React <verification>'});const project=(await created.json()).project;
  const made=await a.api('/projects/'+project.id+'/apps',{name:'React Web SDK',platform:'web',identifier:origin});
  const {application:app,rawKey}=await made.json();assert.ok(rawKey);
  let batch;
  const tracker=createTracker({endpoint:base,ingestKey:rawKey,allowHttp:true,appVersion:'react-gateway',fetch:async(url,init)=>{
    batch=JSON.parse(init.body);return fetch(url,{...init,headers:{...init.headers,Origin:origin}});
  }});
  try {tracker.screen('react_home');tracker.click('verify','react_home');await tracker.flush();assert.equal(tracker.getStatus().queued,0);}finally{tracker.close();}
  const retry=await fetch(base+'/api/v1/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+rawKey,Origin:origin},body:JSON.stringify(batch)});
  assert.equal((await retry.json()).duplicates,2);
  assert.equal((await(await a.request('/console/apps/'+app.id+'/data')).json()).totals.events,2);
  assert.equal((await b.api('/apps/'+app.id)).status,404);
  assert.equal((await b.request('/grafana/api/dashboards/uid/'+app.id)).status,404);
  const panel=await a.request('/grafana/api/dashboards/uid/'+app.id);assert.equal(panel.status,200);assert.equal((await panel.json()).dashboard.uid,app.id);
  for(const format of ['csv','json']) {
    const url='/console/apps/'+app.id+'/export.'+format+'?kind=events&period=all&to='+Date.now()+'&timezone=Europe%2FAstrakhan';
    const own=await a.request(url);assert.equal(own.status,200);assert.equal(own.headers.get('x-export-rows'),'2');
    assert.equal((await b.request(url)).status,404);
    if(format==='json')assert.equal((await own.json()).row_count,2);
  }
  const html=await a.request('/grafana/d/'+app.id+'/events');assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/script-src/);

  const sibling = await (await a.api('/projects/'+project.id+'/apps',{name:'Current Android',platform:'android',identifier:'ru.semius.domcollection'})).json();
  assert.equal((await a.api('/apps/'+sibling.application.id+'/test',{name:'screen_view',screen:'new_android'})).status,200);
  { const panel=await a.request('/grafana/api/dashboards/uid/'+sibling.application.id); assert.equal(panel.status,200,await panel.text()); }
  assert.equal((await a.api('/apps/'+app.id+'/delete',{confirmation:sibling.application.identifier})).status,400);
  const deletion=await a.api('/apps/'+app.id+'/delete',{confirmation:app.identifier});assert.equal(deletion.status,200,await deletion.clone().text());
  assert.ok([403,404].includes((await a.request('/grafana/api/dashboards/uid/'+app.id)).status));
  const panels=await(await a.request('/grafana/api/search?type=dash-db')).json(); assert.equal(panels.some(panel=>panel.uid===app.id),false); assert.ok(panels.some(panel=>panel.uid===sibling.application.id));
  assert.equal((await a.api('/apps/'+app.id)).status,404);
  const obsolete=await fetch(base+'/api/v1/events',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+rawKey,Origin:origin},body:JSON.stringify(batch)});
  assert.equal(obsolete.status,401);
  { const panel=await a.request('/grafana/api/dashboards/uid/'+sibling.application.id); assert.equal(panel.status,200,await panel.text()); }
  const remaining=await(await a.api('/projects/'+project.id)).json();assert.deepEqual(remaining.applications.map(x=>x.id),[sibling.application.id]);
  assert.equal((await(await a.request('/console/apps/'+sibling.application.id+'/data')).json()).totals.events,1);
  assert.equal((await a.api('/logout',{})).status,200);assert.equal((await a.api('/projects')).status,401);
});

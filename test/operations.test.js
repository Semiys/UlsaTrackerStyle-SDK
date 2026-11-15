import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { ClickHouseAnalyticsStore } from '../src/clickhouse-store.js';
import { createApp } from '../src/app.js';
import { validateBatch } from '../src/events.js';
import { ServiceMetrics } from '../src/metrics.js';

const integration = { skip: process.env.STORAGE_BACKEND !== 'clickhouse' || !process.env.DATABASE_URL };
const packet = (patch={}) => validateBatch({schemaVersion:1,events:[{eventId:randomUUID(),sessionId:randomUUID(),occurredAt:new Date().toISOString(),name:'button_click',screen:'receipt_check',platform:'web',appVersion:'qa',properties:{button:'verify'},...patch}]});
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'ulsa-operations-'));
  const config=await loadConfig({...process.env,DEMO_MODE:'0',CONSOLE_ENABLED:'0',DASHBOARD_PROVIDER:'tables',DATA_DIR:directory,PROJECT_ID:'qa_'+randomUUID().replaceAll('-','')});
  const store=await ClickHouseAnalyticsStore.open(config.clickhouse);
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  return {config,store};
}
async function listen(t, config, store, metrics=null) {
  const server=createApp({config,store,metrics}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}

test('operational receipts start empty, retain exact source IDs, deduplicate and survive reopening',integration,async t=>{
  const {config,store}=await fixture(t),events=packet();
  assert.deepEqual(await store.operationalState(config.projectId),{total:0,lastEvent:null});
  await store.ingest(config.projectId,events);
  const state=await store.operationalState(config.projectId);
  assert.equal(state.total,1);assert.equal(state.lastEvent.eventId,events[0].eventId);assert.equal(state.lastEvent.eventName,'button_click');assert.equal(state.lastEvent.status,'stored');
  assert.equal(state.lastEvent.observedAt,(await store.recent(config.projectId))[0].receivedAt);
  assert.equal((await store.ingest(config.projectId,events)).duplicates,1);
  assert.deepEqual(await store.operationalState(config.projectId),state);
  const reopened=await ClickHouseAnalyticsStore.open(config.clickhouse);
  try{assert.deepEqual(await reopened.operationalState(config.projectId),state);}finally{await reopened.close();}
});

test('a receipt failure sends no ACK and retry repairs the trace without duplicating its source',integration,async t=>{
  const {config,store}=await fixture(t),events=packet(),command=store.client.command.bind(store.client);
  store.client.command=async args=>{if(args.query.startsWith('INSERT INTO ingestion_receipts'))throw new Error('controlled receipt failure');return command(args);};
  await assert.rejects(store.ingest(config.projectId,events),/controlled receipt failure/);
  assert.equal((await store.stats(config.projectId,1)).totals.events,1);
  assert.deepEqual(await store.operationalState(config.projectId),{total:0,lastEvent:null});
  store.client.command=command;
  const reply=await store.ingest(config.projectId,events);assert.equal(reply.accepted,0);assert.equal(reply.duplicates,1);
  assert.deepEqual(reply.acknowledgedEventIds,[events[0].eventId]);
  assert.equal((await store.operationalState(config.projectId)).total,1);
  assert.equal((await store.stats(config.projectId,1)).totals.events,1);
});

test('a conflicting packet creates neither another source row nor another operational receipt',integration,async t=>{
  const {config,store}=await fixture(t),first=packet();await store.ingest(config.projectId,first);
  const changed=validateBatch({schemaVersion:1,events:[...packet(),first[0]].map(({payloadHash,...event},index)=>index===1?{...event,name:'screen_view'}:event)});
  await assert.rejects(store.ingest(config.projectId,changed),{code:'event_id_conflict'});
  assert.equal((await store.operationalState(config.projectId)).total,1);assert.equal((await store.stats(config.projectId,1)).totals.events,1);
});

test('receipts remain isolated by project and are removed along with deleted application events',integration,async t=>{
  const {config,store}=await fixture(t),other=config.projectId+'_other';
  const a=packet(),b=packet();await store.ingest(config.projectId,a);await store.ingest(other,b);
  assert.equal((await store.operationalState(config.projectId)).lastEvent.eventId,a[0].eventId);
  assert.equal((await store.operationalState(other)).lastEvent.eventId,b[0].eventId);
  await store.deleteProjectEvents(config.projectId);
  assert.deepEqual(await store.operationalState(config.projectId),{total:0,lastEvent:null});
  assert.equal((await store.recent(config.projectId)).length,0);assert.equal((await store.operationalState(other)).total,1);
});

test('the React form API updates the persistent state and metric once; invalid input creates no receipt',integration,async t=>{
  const {config,store}=await fixture(t),metrics=new ServiceMetrics(store);t.after(()=>metrics.close());
  const base=await listen(t,{...config,demoMode:true},store,metrics);
  const before=await(await fetch(base+'/api/demo/state')).json();assert.equal(before.lastEvent,null);assert.equal(before.total,0);
  const identity=await(await fetch(base+'/api/demo/form')).json(),values={...identity,name:'button_click',screen:'receipt_form',detail:'verify'};
  const post=body=>fetch(base+'/api/demo/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post(values)).status,200);assert.equal((await post(values)).status,200);
  const state=await(await fetch(base+'/api/demo/state?project=foreign')).json();assert.equal(state.total,1);assert.equal(state.lastEvent.eventId,values.eventId);
  assert.match(await metrics.registry.metrics(),/ulsa_ingest_events_total\{result="accepted"\} 1(?:\n|$)/);
  assert.equal((await post({...values,name:''})).status,400);
  assert.equal((await post({...values,eventId:randomUUID()})).status,403);
  assert.equal((await post({...values,csrfToken:''})).status,403);
  assert.equal((await(await fetch(base+'/api/demo/state')).json()).total,1);
  const recent=await(await fetch(base+'/api/demo/recent')).json();assert.equal(recent.events[0].eventId,values.eventId);
  assert.equal((await(await fetch(base+'/api/demo/refusal-example')).json()).status,400);
});

test('the operational screen reports database failure honestly and is not public in private mode',async t=>{
  const store={operationalState:async()=>{throw new Error('private database detail');}};
  const config={demoMode:true,storageBackend:'clickhouse',projectId:'test',ingestKey:'a'.repeat(32),readKey:'b'.repeat(32)};
  const base=await listen(t,config,store);
  const data=await fetch(base+'/api/demo/state');assert.equal(data.status,503);const state=await data.json();assert.equal(state.applicationAvailable,true);assert.equal(state.databaseAvailable,false);assert.equal(state.total,null);assert.equal(state.lastEvent,null);assert.ok(Number.isFinite(Date.parse(state.checkedAt)));
  const html=await fetch(base+'/api/demo/state');assert.equal(html.status,503);assert.doesNotMatch(await html.text(),/private database detail/);
  const privateBase=await listen(t,{...config,demoMode:false},store);
  for(const path of ['/api/demo/form','/api/demo/events','/api/demo/state','/api/demo/recent'])assert.equal((await fetch(privateBase+path)).status,404);
});

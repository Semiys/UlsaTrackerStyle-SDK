// Run only against a disposable QA project. Creates its own owner, app and events.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const base=process.env.FRONTEND_TEST_URL;
if(!base || process.env.DISPOSABLE_QA !== '1') throw new Error('A disposable QA URL and DISPOSABLE_QA=1 are required');
const jar=new Map();let csrf='';
async function call(path,body) {
  const r=await fetch(base+path,{redirect:'manual',headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(body?{'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify({...body,csrfToken:csrf})}:{})});
  for(const cookie of r.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');jar.set(pair.slice(0,at),pair.slice(at+1));}
  assert.equal(r.status<400,true,'HTTP '+r.status+' '+path);
  return r.json();
}
csrf=(await call('/api/console/session')).csrfToken;
csrf=(await call('/api/console/register',{name:'Load verification',email:randomUUID()+'@example.test',password:'isolated-load-verification-2026'})).csrfToken;
const {project}=await call('/api/console/projects',{name:'Bounded concurrency'});
const {application,rawKey}=await call('/api/console/projects/'+project.id+'/apps',{name:'Android load fixture',platform:'android',identifier:'com.example.load'});
const sessionId=randomUUID(),now=new Date().toISOString();
const packets=Array.from({length:20},()=>({schemaVersion:1,events:Array.from({length:10},()=>({eventId:randomUUID(),sessionId,occurredAt:now,name:'button_click',screen:'load',platform:'android',appVersion:'qa-0.11.0',properties:{button:'verify'}}))}));
const times=[];let accepted=0,duplicates=0;
async function send(packet) {
  const start=performance.now(),response=await fetch(base+'/api/v1/events',{method:'POST',headers:{Authorization:'Bearer '+rawKey,'Content-Type':'application/json'},body:JSON.stringify(packet)});
  times.push(performance.now()-start);assert.equal(response.status,200);
  const result=await response.json();accepted+=result.accepted;duplicates+=result.duplicates;
}
async function wave(){let next=0;await Promise.all(Array.from({length:4},async()=>{while(next<packets.length){const i=next++;await send(packets[i]);}}));}
const started=performance.now();await wave();await wave();
const totals=await call('/console/apps/'+application.id+'/data');
assert.equal(accepted,200);assert.equal(duplicates,200);assert.equal(totals.totals.events,200);
times.sort((a,b)=>a-b);
const summary={requests:40,concurrency:4,accepted,duplicates,stored:totals.totals.events,elapsed_ms:Math.round(performance.now()-started),p50_ms:Math.round(times[Math.floor(times.length*.5)]),p95_ms:Math.round(times[Math.floor(times.length*.95)]),appId:application.id};
console.log(JSON.stringify(summary,null,2));

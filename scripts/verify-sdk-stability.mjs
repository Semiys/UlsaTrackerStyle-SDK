// Bounded SDK/failure verification. This intentionally stops only the restored QA API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createTracker } from '../sdk/js/index.mjs';

const base = process.env.FRONTEND_TEST_URL;
assert.equal(process.env.DISPOSABLE_QA, '1', 'Explicit disposable QA opt-in required');
assert.equal(base, 'http://127.0.0.1:18088', 'Only the isolated recovery stand is supported');
const directory = process.env.RECOVERY_QA_DIRECTORY;
const output = process.env.QA_OUTPUT_DIRECTORY;
assert.ok(directory && output, 'Private stand and output directories are required');
const docker = process.env.DOCKER_BIN || 'docker';
const exec = promisify(execFile);
async function command(args) {
  try { return (await exec(docker, args, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error('QA Docker command failed: ' + args.slice(0, 2).join(' ')); }
}
const names = (await command(['ps', '-aq', '--filter', 'label=com.docker.compose.project=ulsa-recovery-proof'])).split(/\s+/).filter(Boolean);
const containers = JSON.parse(await command(['inspect', ...names]));
assert.equal(containers.length, 6);
for (const c of containers) {
  assert.equal(c.Config.Labels['com.docker.compose.project'], 'ulsa-recovery-proof');
  assert.equal(resolve(c.Config.Labels['com.docker.compose.project.working_dir']), resolve(directory));
  for (const bindings of Object.values(c.HostConfig.PortBindings || {}))
    for (const b of bindings || []) assert.equal(b.HostIp, '127.0.0.1');
  assert.equal(c.State.Running, true);
}
const app = containers.find(c => c.Config.Labels['com.docker.compose.service'] === 'app');
assert.ok(app);
async function sourceState() {
  const ids = (await command(['ps', '-aq', '--filter', 'label=com.docker.compose.project=mispisit-sarantsev'])).split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const values = JSON.parse(await command(['inspect', ...ids]));
  assert.equal(values.some(c => c.State.Running), false, 'The source must remain stopped');
  return values.map(c => ({ id: c.Id, startedAt: c.State.StartedAt, finishedAt: c.State.FinishedAt })).sort((a,b)=>a.id.localeCompare(b.id));
}
const sourceBefore = await sourceState();
await mkdir(output, { recursive: true });
const jar = new Map(); let csrf = '';
async function api(path, body) {
  const response = await fetch(base + path, { redirect: 'manual', headers: {
    Cookie: [...jar].map(([k,v])=>k+'='+v).join('; '), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, ...(body ? { method: 'POST', body: JSON.stringify({ ...body, csrfToken: csrf }) } : {}) });
  for (const cookie of response.headers.getSetCookie()) { const pair=cookie.split(';')[0], i=pair.indexOf('='); jar.set(pair.slice(0,i),pair.slice(i+1)); }
  assert.ok(response.status === 200 || response.status === 201, 'QA API failed: '+path+' (HTTP '+response.status+')');
  return response.json();
}
csrf = (await api('/api/console/session')).csrfToken;
csrf = (await api('/api/console/register', { name:'SDK stability QA', email:randomUUID()+'@example.test', password:randomUUID()+randomUUID() })).csrfToken;
const origin = (await api('/api/console/session')).endpoint;
const { project } = await api('/api/console/projects', { name:'Bounded SDK recovery verification' });
const { application, rawKey } = await api('/api/console/projects/'+project.id+'/apps', { name:'Isolated Web SDK stability', platform:'web', identifier:origin });
const values = new Map(), storage = { getItem:k=>values.get(k)??null, setItem:(k,v)=>values.set(k,v), removeItem:k=>values.delete(k) };
const createdIds = new Set(), latencies = [], requests = {}, samples = [];
let generated = 0, liveFailures = 0, recreated = false, lostAck = false, stopping = false, stopped = false;
let phase = 'steady', peakQueue = 0, oldAccepted = 0, oldFailures = 0, priorDropped = 0, priorRejected = 0, restartQueue = null;
const mark = async text => { console.log(text); await writeFile(join(output,'progress.json'),JSON.stringify({ phase,generated,peakQueue,stopped,recreated,lostAck,at:new Date().toISOString() },null,2)); };
const started = performance.now();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const until = async seconds => { const delay=seconds*1000-(performance.now()-started); if(delay>0)await sleep(delay); };
const elapsed = () => (performance.now()-started)/1000;
function buildTracker() {
  return createTracker({ endpoint:base, ingestKey:rawKey, appVersion:'sdk-stability-qa', allowHttp:true,
    persist:true, storage, maxQueue:1000, flushIntervalMs:5000,
    fetch:async(url,init)=>{
      const begin=performance.now();
      try {
        const response=await fetch(url,{...init,headers:{...init.headers,Origin:origin}});
        requests[response.status]=(requests[response.status]||0)+1;
        if(response.status===200)latencies.push(performance.now()-begin);
        // Discard one real successful reply after commit, retaining IDs for a genuine retry.
        if(response.status===200 && elapsed()>180 && !lostAck){lostAck=true;await response.arrayBuffer();throw new Error('QA lost ACK');}
        return response;
      } catch(error) { liveFailures++; throw error; }
    },
  });
}
let tracker = buildTracker();
let producerDone = false, faultDone = false, sawFiring = false, sawRecovery = false;
async function monitor() {
  while (!producerDone || !faultDone) {
    let status='unavailable';
    try {
      const reply=await (await fetch('http://127.0.0.1:18089/api/v1/alerts',{signal:AbortSignal.timeout(5000)})).json();
      const alert=reply.data.alerts.find(a=>a.labels.alertname==='UlsaApiDown');
      status=alert?.state||'inactive';
      if(status==='firing')sawFiring=true;
      if(sawFiring && status==='inactive')sawRecovery=true;
      const metric=await (await fetch('http://127.0.0.1:18089/api/v1/query?query='+encodeURIComponent('ulsa_process_resident_memory_bytes{job="ulsa-api"}'),{signal:AbortSignal.timeout(5000)})).json();
      samples.push({seconds:Math.round(elapsed()),phase,alert:status,queued:tracker.getStatus().queued,rssBytes:metric.data?.result?.[0]?.value?.[1]??null});
    } catch { samples.push({seconds:Math.round(elapsed()),phase,alert:status,queued:tracker.getStatus().queued}); }
    await sleep(10000);
  }
}
async function produce() {
  try {
    for(let i=0;i<600;i++) {
      await until(i/2);
      assert.equal(tracker.track('button_click',{screen:'stability',properties:{button:'qa_check',sequence:i}}),true);
      generated++;
      for(const value of values.values()) { try { const saved=JSON.parse(value);for(const e of saved.queue||[])createdIds.add(e.eventId); } catch {} }
      peakQueue=Math.max(peakQueue,tracker.getStatus().queued);
      if(i%60===0)await mark('SDK produced '+generated+' events; queued '+tracker.getStatus().queued);
    }
  } finally { producerDone=true; }
}
async function faults() {
  try {
    await until(60); phase='api_down'; stopping=true;
    await command(['stop','-t','3',app.Id]); stopped=true;
    await mark('Isolated API stopped');
    await until(115);
    const before=tracker.getStatus();
    oldAccepted+=before.accepted;oldFailures+=before.failures;priorDropped+=before.dropped;priorRejected+=before.rejected;
    tracker.close();tracker=buildTracker();restartQueue={before:before.queued,after:tracker.getStatus().queued};
    assert.ok(before.queued>0);assert.equal(restartQueue.after,restartQueue.before);recreated=true;
    await mark('SDK recreated from its persistent queue');
    await until(165);phase='api_restarting';
    await command(['start',app.Id]);stopped=false;
    for(let i=0;i<60;i++){try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).status===200)break;}catch{} await sleep(1000);}
    assert.equal((await fetch(base+'/health')).status,200);phase='recovered';await mark('Isolated API healthy again');
  } finally { faultDone=true; }
}
try {
  await mark('Starting 5-minute run at 2 events/second');
  const results=await Promise.allSettled([produce(),faults(),monitor()]);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  phase='draining';
  const deadline=Date.now()+90000;
  while(tracker.getStatus().queued && Date.now()<deadline){await tracker.flush();await sleep(1000);}
  const final=tracker.getStatus();
  assert.equal(final.queued,0);assert.equal(final.paused,'');assert.equal(final.dropped+priorDropped,0);assert.equal(final.rejected+priorRejected,0);
  assert.equal(oldAccepted+final.accepted,generated);assert.equal(generated,600);assert.equal(createdIds.size,600);
  assert.ok(recreated && lostAck && liveFailures>0);assert.ok(sawFiring && sawRecovery,'Prometheus must show both firing and recovery');
  const data=await api('/console/apps/'+application.id+'/export.json?kind=events&period=all&to='+Date.now()+'&timezone=UTC');
  assert.equal(data.row_count,600);assert.deepEqual(new Set(data.rows.map(r=>r.event_id)),createdIds);
  assert.deepEqual(await sourceState(),sourceBefore);
  latencies.sort((a,b)=>a-b);
  const summary={sdkVersion:final.version,durationSeconds:Math.round(elapsed()),generated,stored:data.row_count,queueAfter:final.queued,peakQueue,restartQueue,clientRecreated:recreated,lostAckRetried:lostAck,
    acknowledged:oldAccepted+final.accepted,dropped:priorDropped+final.dropped,rejected:priorRejected+final.rejected,sdkFailures:oldFailures+final.failures,requestStatuses:requests,
    http200P50ms:Math.round(latencies[Math.floor(latencies.length*.5)]),http200P95ms:Math.round(latencies[Math.floor(latencies.length*.95)]),
    prometheusApiDownFired:sawFiring,prometheusApiDownRecovered:sawRecovery,sourceStayedStopped:true,appId:application.id,limitations:'One Node client using actual JS SDK, in-memory localStorage adapter across client recreation, same-host Intel, bounded rate; no browser process/disk/power-loss or maximum capacity claim'};
  await writeFile(join(output,'stability-summary.json'),JSON.stringify(summary,null,2));
  await mark('PASS: all 600 exact event IDs stored once; queue empty; alert recovered');
  console.log(JSON.stringify(summary,null,2));
} finally {
  tracker.close();
  if(stopping && stopped)await command(['start',app.Id]);
  await writeFile(join(output,'stability-samples.json'),JSON.stringify(samples,null,2));
}

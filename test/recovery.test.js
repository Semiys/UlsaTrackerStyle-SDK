import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectName, safeFile, targetPort, restoreOverride, restore, verifyFiles, validateIsolation } from '../scripts/recovery.mjs';

test('recovery rejects ambiguous project names and unsafe manifest paths',()=>{
  for(const value of ['','main/project','UPPER','../main','a'.repeat(49),undefined])assert.throws(()=>projectName(value));
  assert.equal(projectName('ulsa-recovery-proof'),'ulsa-recovery-proof');
  for(const value of ['/etc/passwd','../secret','config/../secret','C:/secret','config\\secret','a//b','.git/config','x\nfile',undefined])assert.throws(()=>safeFile(value));
  assert.equal(safeFile('config/.monitoring-secrets/dashboard-password'),'config/.monitoring-secrets/dashboard-password');
});
test('restore ports are bounded and generated mappings replace all public listeners',()=>{
  for(const value of [0,80,65534,'8080:8080','10.5',undefined])assert.throws(()=>targetPort(value));
  assert.equal(targetPort('18088'),18088);
  const services=Object.fromEntries(['app','db','dashboard','frontend','prometheus','monitoring-dashboard'].map(s=>[s,{image:'sha256:'+'a'.repeat(64)}]));
  const yaml=restoreOverride({services},18088);
  assert.match(yaml,/ports: !override \[\]/);
  for(const port of [18088,18089,18090])assert.match(yaml,new RegExp('127\\.0\\.0\\.1:'+port+':'));
  assert.doesNotMatch(yaml,/0\.0\.0\.0|192\.168\./);
  assert.match(yaml,/PUBLIC_URL: http:\/\/127\.0\.0\.1:18088/);
  assert.equal((yaml.match(/pull_policy: never/g)||[]).length,6);
});


test('restore refuses its source project before accessing Docker or creating a destination',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ulsa-recovery-test-')),file=join(directory,'manifest.json'),target=directory+'-target';
  t.after(async()=>{await unlink(file);await rmdir(directory);});
  await writeFile(file,JSON.stringify({formatVersion:1,sourceProject:'source',volumes:[],configFiles:[]}));
  await assert.rejects(restore({input:directory,project:'source',directory:target}),/source project/);
  await assert.rejects(access(target));
});
test('backup verification accepts complete bytes and rejects changed content and path traversal',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ulsa-recovery-test-')),file=join(directory,'data.txt');
  t.after(async()=>{await unlink(file);await rmdir(directory);});
  await writeFile(file,'original');const files={'data.txt':createHash('sha256').update('original').digest('hex')};
  await verifyFiles(directory,files);await writeFile(file,'modified');
  await assert.rejects(verifyFiles(directory,files),/checksum mismatch/);
  await assert.rejects(verifyFiles(directory,{'../outside':'a'.repeat(64)}),/Unsafe backup file/);
});


test('restored services cannot reuse source networks, writable host paths, external secrets or public listeners',()=>{
  const directory=join(tmpdir(),'ulsa-private-config'),project='isolated';
  const good={services:{frontend:{ports:[{host_ip:'127.0.0.1'}]},db:{volumes:[{type:'bind',source:join(directory,'monitoring/config.xml'),read_only:true}]}},volumes:{dbdata:{name:project+'_dbdata'}},networks:{default:{name:project+'_default'}},secrets:{password:{file:join(directory,'.monitoring-secrets/password')}}};
  validateIsolation(good,project,directory);
  for(const change of [
    c=>{c.services.frontend.ports[0].host_ip='0.0.0.0';},
    c=>{c.services.db.volumes[0].source=join(tmpdir(),'source-db');},
    c=>{c.services.db.volumes[0].read_only=false;},
    c=>{c.volumes.dbdata.name='source_dbdata';},
    c=>{c.networks.default.name='source_default';},
    c=>{c.secrets.password.file=join(tmpdir(),'source-secret');},
  ]) {const bad=structuredClone(good);change(bad);assert.throws(()=>validateIsolation(bad,project,directory));}
});

// Runs only inside a disposable, network-isolated Docker helper.
import { readdir, lstat, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';

async function fingerprint() {
  const hash=createHash('sha256');let files=0,bytes=0;
  async function visit(relative='') {
    for(const name of (await readdir('/data/'+relative)).sort()) {
      const path=relative?relative+'/'+name:name,full='/data/'+path,info=await lstat(full);
      if(info.isDirectory()) { hash.update(JSON.stringify(['dir',path,info.mode&0o7777,info.uid,info.gid])+'\n'); await visit(path); }
      else if(info.isSymbolicLink()) { hash.update(JSON.stringify(['link',path,await readlink(full)])+'\n');files++; }
      else if(info.isFile()) {
        const digest=createHash('sha256');for await(const chunk of createReadStream(full))digest.update(chunk);
        hash.update(JSON.stringify(['file',path,info.size,info.mode&0o7777,info.uid,info.gid,digest.digest('hex')])+'\n');files++;bytes+=info.size;
      } else throw new Error('Unsupported special file in volume');
    }
  }
  const base=await lstat('/data');hash.update(JSON.stringify(['root',base.mode&0o7777,base.uid,base.gid])+'\n');
  await visit();return {sha256:hash.digest('hex'),files,bytes};
}
function tar(args) {
  const result=spawnSync('tar',args,{encoding:'utf8',maxBuffer:64*1024*1024});
  if(result.status!==0)throw new Error('Volume archive operation failed');
  return result.stdout;
}
const [mode,file]=process.argv.slice(2);
if(file&&!/^vol-[a-z0-9_-]+\.tar\.gz$/.test(file))throw new Error('Invalid volume archive name');
if(mode==='snapshot') {
  const before=await fingerprint();tar(['--hard-dereference','-I','gzip -1','-cf','/backup/'+file,'-C','/data','.']);
  const after=await fingerprint();if(before.sha256!==after.sha256)throw new Error('Volume changed during backup');
  console.log(JSON.stringify(before));
} else if(mode==='validate') {
  for(const path of tar(['-tzf','/backup/'+file]).split('\n').filter(Boolean)) {
    if(path.startsWith('/')||path.includes('\\')||/[\x00-\x1f\x7f]/.test(path)||path.split('/').includes('..')||/^[A-Za-z]:/.test(path))throw new Error('Unsafe archive entry');
  }
  // A trusted backup may contain relative ClickHouse metadata links. Absolute
  // or escaping links are never needed in these data volumes.
  const verbose=tar(['-tvzf','/backup/'+file,'--numeric-owner','--quoting-style=literal']);
  for(const line of verbose.split('\n'))if(line.startsWith('l')) {
    const at=line.lastIndexOf(' -> ');if(at<0)throw new Error('Invalid link entry');
    const target=line.slice(at+4),match=/^\S+\s+\d+\/\d+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/.exec(line.slice(0,at));
    if(!match||posix.isAbsolute(target)||target.includes('\\'))throw new Error('Unsafe archive link');
    const resolved=posix.normalize(posix.join(posix.dirname(match[1]),target));
    if(resolved==='..'||resolved.startsWith('../'))throw new Error('Escaping archive link');
  }
  for(const line of verbose.split('\n').filter(Boolean))if(!['-','d','l'].includes(line[0]))throw new Error('Unsupported archive entry type');
  console.log('{"valid":true}');
} else if(mode==='extract') {
  if((await readdir('/data')).length)throw new Error('Restore volume is not empty');
  tar(['-xzf','/backup/'+file,'-C','/data','--numeric-owner']);console.log(JSON.stringify(await fingerprint()));
} else if(mode==='fingerprint')console.log(JSON.stringify(await fingerprint()));
else throw new Error('Unknown volume operation');

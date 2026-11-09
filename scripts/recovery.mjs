import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, lstat, chmod, copyFile, access, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const docker=process.env.DOCKER_BIN||'docker';
const composeFiles=['docker-compose.yml','docker-compose.monitoring.yml','docker-compose.react.yml'];
const helperTag='node:24.22.2-bookworm-slim';
const requiredServices=['app','db','dashboard','frontend','prometheus','monitoring-dashboard'];
const volumeTool=resolve(root,'scripts/recovery-volume.mjs');
const roles=['appdata','dbdata','product_grafana_13','prometheusdata','operatordata'];
export function projectName(value) {
  if(typeof value!=='string'||!/^([a-z][a-z0-9_-]{0,47})$/.test(value))throw new Error('Use a lowercase Docker project name, up to 48 characters');
  return value;
}
export function safeFile(value) {
  if(typeof value!=='string'||!value||value.includes('\\')||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git')||/[\x00-\x1f\x7f:]/.test(value))throw new Error('Unsafe backup file path');
  return value;
}
export function targetPort(value) {
  if(!/^\d+$/.test(String(value)))throw new Error('Invalid restore port');
  const port=Number(value);if(port<1024||port>65533)throw new Error('Restore port must be between 1024 and 65533');return port;
}
function outsideRepository(value) {
  if(typeof value!=='string'||!isAbsolute(value))throw new Error('Use an absolute directory path');
  const result=resolve(value),inside=relative(root,result);
  if(!inside||(!inside.startsWith('..')&&!isAbsolute(inside)))throw new Error('Keep private backup/restore data outside the repository');
  return result;
}
async function exists(path) { try { await access(path);return true; }catch(error){if(error.code==='ENOENT')return false;throw error;} }
function run(args,{cwd=root,env=process.env}={}) {
  const result=spawnSync(docker,args,{cwd,env,encoding:'utf8',maxBuffer:64*1024*1024,windowsHide:true});
  if(result.error)throw new Error('Docker CLI could not start; set DOCKER_BIN if necessary');
  if(result.status!==0)throw new Error('Docker command failed: '+args.slice(0,2).join(' '));
  return result.stdout.trim();
}
const json=(args,options)=>JSON.parse(run(args,options));
const inspectImage=ref=>json(['image','inspect',ref])[0];
const inspectContainer=ids=>json(['inspect',...ids]);
async function sha256(path) {const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function verifyFiles(input,files) {
  if(!files||typeof files!=='object'||Array.isArray(files)||!Object.keys(files).length)throw new Error('Invalid backup file list');
  const base=await realpath(input);
  for(const [name,hash] of Object.entries(files)) {
    safeFile(name);const path=resolve(input,name),actual=await realpath(path),inside=relative(base,actual);
    if(!inside||inside.startsWith('..')||isAbsolute(inside)||(await lstat(path)).isSymbolicLink())throw new Error('Backup file escapes its directory');
    if(!/^[a-f0-9]{64}$/.test(hash)||await sha256(path)!==hash)throw new Error('Backup checksum mismatch: '+name);
  }
}

function log(message) {console.log(message);}
function assertStopped(containers) {
  if(containers.some(c=>c.State.Running))throw new Error('Backup requires all source containers to be stopped; source was not changed');
}
function containerStamp(containers) {return JSON.stringify(containers.map(c=>[c.Id,c.State.StartedAt,c.State.FinishedAt]).sort());}
const composeArgs=(project,directory,override=false)=>['compose','-p',project,...composeFiles.flatMap(f=>['-f',resolve(directory,f)]),...(override?['-f',resolve(directory,'recovery.override.yml')]:[])];
function helper(image,{volume,backup,writeVolume=false,writeBackup=false,command}) {
  return json(['run','--rm','--network','none','--memory','256m','--cpus','1','--pids-limit','64','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=FOWNER','--cap-add=DAC_OVERRIDE','--security-opt=no-new-privileges:true',
    ...(volume?['--mount',`type=volume,source=${volume},target=/data${writeVolume?'':',readonly'}`]:[]),
    '--mount',`type=bind,source=${backup},target=/backup${writeBackup?'':',readonly'}`,
    '--mount',`type=bind,source=${volumeTool},target=/tool/volume.mjs,readonly`,image,'node','/tool/volume.mjs',...command]);
}
async function copyConfig(output) {
  const copied=[];
  async function copy(name) {
    const source=resolve(root,name),info=await lstat(source);
    if(info.isSymbolicLink())throw new Error('Configuration symlinks are not supported');
    if(info.isDirectory()) {for(const child of (await readdir(source)).sort())await copy(name+'/'+child);}
    else if(info.isFile()) {
      const dest=resolve(output,'config',name);await mkdir(dirname(dest),{recursive:true,mode:0o700});await copyFile(source,dest);await chmod(dest,0o600);copied.push('config/'+name);
    } else throw new Error('Unsupported configuration file');
  }
  for(const name of [...composeFiles,'grafana','monitoring','.monitoring-secrets'])await copy(name);
  if(await exists(resolve(root,'.env')))await copy('.env');
  return copied;
}
export async function backup({project,output,withoutImages=false}) {
  projectName(project);output=outsideRepository(output);
  if(await exists(output))throw new Error('Backup output must be a new directory');
  const ids=run(['ps','-aq','--filter','label=com.docker.compose.project='+project]).split(/\s+/).filter(Boolean);
  if(!ids.length)throw new Error('Source project containers were not found');
  const containers=inspectContainer(ids);assertStopped(containers);const stamp=containerStamp(containers);
  const services={};for(const service of requiredServices) {
    const matches=containers.filter(c=>c.Config.Labels['com.docker.compose.service']===service);
    if(matches.length!==1)throw new Error('Expected exactly one source service: '+service);
    services[service]={image:matches[0].Image,configuredImage:matches[0].Config.Image,exitCode:matches[0].State.ExitCode};
  }
  for(const [service,source] of Object.entries(services)) {
    try { inspectImage(source.image); } catch { throw new Error('Missing image for source service '+service+'; recreate it from its intended release before backup'); }
  }
  const helperImage=inspectImage(helperTag).Id;
  const volumes=[];
  for(const container of containers)for(const mount of container.Mounts.filter(m=>m.Type==='volume'&&m.RW)) {
    if(volumes.some(v=>v.source===mount.Name))continue;
    const info=json(['volume','inspect',mount.Name])[0],role=info.Labels?.['com.docker.compose.volume'];
    if(!roles.includes(role)||info.Labels?.['com.docker.compose.project']!==project)throw new Error('Unexpected source data volume');
    if(run(['ps','-q','--filter','volume='+mount.Name]))throw new Error('A source volume is mounted by a running container');
    volumes.push({role,source:mount.Name,file:'vol-'+role+'.tar.gz'});
  }
  if(roles.some(role=>!volumes.some(v=>v.role===role)))throw new Error('The six-service data profile is incomplete');
  await mkdir(output,{mode:0o700});await writeFile(resolve(output,'.gitignore'),'*\n',{mode:0o600});
  const configFiles=await copyConfig(output),files={};
  for(const volume of volumes) {
    assertStopped(inspectContainer(ids));log('Backing up '+volume.role);
    volume.fingerprint=helper(helperImage,{volume:volume.source,backup:output,writeBackup:true,command:['snapshot',volume.file]});
    files[volume.file]=await sha256(resolve(output,volume.file));
  }
  let imagesFile=null;
  if(!withoutImages) {imagesFile='images.tar';log('Saving exact Docker images');run(['image','save','-o',resolve(output,imagesFile),...new Set([helperImage,...Object.values(services).map(s=>s.image)])]);files[imagesFile]=await sha256(resolve(output,imagesFile));}
  for(const name of configFiles)files[name]=await sha256(resolve(output,name));
  const finalContainers=inspectContainer(ids);assertStopped(finalContainers);
  if(stamp!==containerStamp(finalContainers))throw new Error('Source containers changed during backup; no complete manifest was written');
  const manifest={formatVersion:1,toolVersion:'0.1.0',createdAt:new Date().toISOString(),backupId:randomUUID(),sourceProject:project,architecture:inspectImage(helperImage).Architecture,helperImage,services,volumes,configFiles,imagesFile,files};
  await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  log('Backup complete: '+output);return manifest;
}
export function restoreOverride(manifest,port) {
  const url='http://127.0.0.1:'+port;
  let text='services:\n';
  for(const service of requiredServices) {
    text+='  '+service+':\n    image: '+JSON.stringify(manifest.services[service].image)+'\n    pull_policy: never\n';
    if(service==='app')text+='    ports: !override []\n    environment:\n      PUBLIC_URL: '+url+'\n      DASHBOARD_PUBLIC_URL: '+url+'\n';
    if(service==='dashboard')text+='    environment:\n      GF_SERVER_ROOT_URL: '+url+'/grafana/\n';
    if(service==='frontend')text+='    ports: !override ["127.0.0.1:'+port+':8080"]\n    environment:\n      PUBLIC_URL: '+url+'\n';
    if(service==='prometheus')text+='    ports: !override ["127.0.0.1:'+(port+1)+':9090"]\n';
    if(service==='monitoring-dashboard')text+='    ports: !override ["127.0.0.1:'+(port+2)+':3000"]\n';
  }
  return text;
}
export function validateIsolation(configuration,project,directory) {
  const inside=path=>{if(typeof path!=='string')return false;const part=relative(resolve(directory),resolve(path));return !!part&&!part.startsWith('..')&&!isAbsolute(part);};
  for(const service of Object.values(configuration.services??{})) {
    for(const mapping of service.ports??[])if(mapping.host_ip!=='127.0.0.1')throw new Error('Restore ports must be loopback only');
    for(const mount of service.volumes??[])if(mount.type==='bind'&&(!mount.read_only||!inside(mount.source)))throw new Error('Restore bind mount escapes its private configuration');
  }
  for(const [name,volume]of Object.entries(configuration.volumes??{}))if(volume.external||volume.name!==project+'_'+name)throw new Error('Unexpected external restore volume');
  for(const [name,network]of Object.entries(configuration.networks??{}))if(network.external||network.name!==project+'_'+name)throw new Error('External restore networks are forbidden');
  for(const secret of Object.values(configuration.secrets??{}))if(secret.external||!inside(secret.file))throw new Error('Restore secret escapes its private configuration');
}
export async function restore({input,project,directory,port=18088}) {
  projectName(project);port=targetPort(port);input=outsideRepository(input);directory=outsideRepository(directory);
  const manifest=JSON.parse(await readFile(resolve(input,'manifest.json'),'utf8'));
  if(manifest.formatVersion!==1||!Array.isArray(manifest.volumes)||!Array.isArray(manifest.configFiles))throw new Error('Unsupported backup manifest');
  if(project===manifest.sourceProject)throw new Error('Restoring over the source project is forbidden');
  if(await exists(directory))throw new Error('Restore directory must not exist');
  if(run(['ps','-aq','--filter','label=com.docker.compose.project='+project])||run(['volume','ls','-q','--filter','label=com.docker.compose.project='+project]))throw new Error('Restore project already exists');
  for(const role of [...roles,'grafanadata','grafanaplugins4112','grafanaplugins4234']) {
    if(run(['volume','ls','-q','--filter','name=^'+project+'_'+role+'$']))throw new Error('Target volume already exists');
  }
  await verifyFiles(input,manifest.files);
  if(manifest.volumes.length!==roles.length||new Set(manifest.volumes.map(v=>v.role)).size!==roles.length||roles.some(role=>!manifest.volumes.some(v=>v.role===role)))throw new Error('Unexpected backup data volumes');
  for(const volume of manifest.volumes)if(volume.file!=='vol-'+volume.role+'.tar.gz'||!manifest.files[volume.file])throw new Error('Invalid volume archive');
  for(const service of requiredServices)if(!/^sha256:[a-f0-9]{64}$/.test(manifest.services?.[service]?.image))throw new Error('Invalid service image');
  if(!/^sha256:[a-f0-9]{64}$/.test(manifest.helperImage))throw new Error('Invalid helper image');
  const imageIds=[...new Set([manifest.helperImage,...Object.values(manifest.services).map(s=>s.image)])];
  const missing=imageIds.some(image=>{try{inspectImage(image);return false;}catch{return true;}});
  if(missing) {
    if(manifest.imagesFile!=='images.tar'||!manifest.files['images.tar'])throw new Error('Exact images are missing; use a backup with included images');
    log('Loading saved Docker images');run(['image','load','-i',resolve(input,'images.tar')]);
  }
  for(const image of imageIds)if(inspectImage(image).Architecture!==manifest.architecture)throw new Error('Image architecture mismatch');
  // Validate archives before creating any destination volume.
  for(const volume of manifest.volumes)helper(manifest.helperImage,{backup:input,command:['validate',volume.file]});
  await mkdir(directory,{mode:0o700});await writeFile(resolve(directory,'.gitignore'),'*\n',{mode:0o600});
  for(const name of manifest.configFiles) {
    safeFile(name);if(!name.startsWith('config/')||!manifest.files[name])throw new Error('Invalid configuration manifest');
    const destination=resolve(directory,name.slice(7));await mkdir(dirname(destination),{recursive:true,mode:0o700});await copyFile(resolve(input,name),destination);await chmod(destination,0o600);
  }
  await writeFile(resolve(directory,'recovery.override.yml'),restoreOverride(manifest,port),{mode:0o600});
  await writeFile(resolve(directory,'recovery.json'),JSON.stringify({backupId:manifest.backupId,sourceProject:manifest.sourceProject,project,createdAt:new Date().toISOString()},null,2),{mode:0o600});
  const args=composeArgs(project,directory,true),configuration=json([...args,'config','--format','json'],{cwd:directory});
  validateIsolation(configuration,project,directory);
  for(const volume of manifest.volumes) {
    log('Restoring '+volume.role);const name=project+'_'+volume.role;
    run(['volume','create','--label','com.docker.compose.project='+project,'--label','com.docker.compose.volume='+volume.role,'--label','io.ulsatracker.restore-id='+manifest.backupId,name]);
    const actual=helper(manifest.helperImage,{volume:name,backup:input,writeVolume:true,command:['extract',volume.file]});
    if(actual.sha256!==volume.fingerprint.sha256)throw new Error('Restored volume does not match the snapshot: '+volume.role);
  }
  // Preserve the copied secret bytes; only set permissions needed by container GID 65530.
  run(['run','--rm','--network','none','--memory','256m','--cpus','1','--pids-limit','64','--read-only','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=FOWNER','--security-opt=no-new-privileges:true','--mount',`type=bind,source=${directory},target=/workspace`,manifest.helperImage,'node','--input-type=module','-e',"import{chmod,chown}from'node:fs/promises';for(const name of['dashboard-password','operator-password']){const p='/workspace/.monitoring-secrets/'+name;await chown(p,0,65530);await chmod(p,0o440);}"]);
  log('Starting restored containers');run([...args,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','180'],{cwd:directory});
  log('Restored cabinet: http://127.0.0.1:'+port);return {directory,project,port,backupId:manifest.backupId};
}
function options(args) {
  const result={};for(let i=0;i<args.length;i++) {
    const key=args[i];if(key==='--without-images')result.withoutImages=true;
    else if(['--project','--output','--input','--directory','--port'].includes(key)&&args[i+1]&&!args[i+1].startsWith('--'))result[key.slice(2)]=args[++i];
    else throw new Error('Unknown or incomplete argument: '+key);
  }return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,...args]=process.argv.slice(2);
  try {const config=options(args);if(command==='backup')await backup(config);else if(command==='restore')await restore(config);else throw new Error('Usage: node scripts/recovery.mjs backup|restore --project NAME ...');}
  catch(error){console.error(error.message);process.exitCode=1;}
}

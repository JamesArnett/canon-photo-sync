import { chmod, copyFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { bootstrapSchema, secretSchema, settingsSchema, type CameraConfig } from './config.js';
import { openStore } from './store.js';
import { ImportPaths, within } from './paths.js';
import { canonCCAPI, type CCAPIFactory } from './ccapi.js';
import { CameraTransport } from './transport.js';
import { Engine } from './engine.js';
import { Auth } from './auth.js';
import { Push, vapid, sender } from './push.js';
import { Previews } from './previews.js';
import { web } from './web.js';

async function privateFile(path:string) {
  const info=await lstat(path);
  if (!info.isFile() || (info.mode&0o077) || info.uid!==process.getuid?.()) throw Error('Private file must be owned by the service account and mode 0600');
  return JSON.parse(await readFile(path,'utf8')) as unknown;
}
async function main() {
  if (process.getuid?.()===0) throw Error('Run as a dedicated unprivileged account');
  const bootstrapFile=resolve(process.env.CANON_BOOTSTRAP ?? 'bootstrap.json');
  const secretFile=resolve(process.env.CANON_SECRETS ?? join(dirname(bootstrapFile),'secrets.json'));
  const bootstrap=bootstrapSchema.parse(await privateFile(bootstrapFile));
  const secrets=secretSchema.parse(await privateFile(secretFile));
  if (!bootstrap.oidc.subjects.length&&!bootstrap.oidc.groups.length) throw Error('OIDC allowlist is empty');
  process.umask(0o077);
  await mkdir(bootstrap.data,{recursive:true,mode:0o700});
  const info=await stat(bootstrap.data);
  if (await realpath(bootstrap.data)!==bootstrap.data || (info.mode&0o077) || info.uid!==process.getuid?.()) throw Error('Data directory must be private and canonical');
  if (bootstrap.allowedRoots.some(root=>within(root,bootstrap.data)||within(bootstrap.data,root))) throw Error('Separate application data and import directories');
  const paths=new ImportPaths(bootstrap.allowedRoots);
  for (const path of paths.roots) await paths.directory(path);
  const storePath=join(bootstrap.data,'sync.sqlite');
  try {
    const dbFile=await lstat(storePath);
    if (!dbFile.isFile() || (dbFile.mode&0o077) || dbFile.uid!==process.getuid?.()) throw Error('Database file must be private');
  } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const db=openStore(storePath);
  const config=()=>{
    const saved=db.prepare("SELECT value FROM settings WHERE key='general'").get() as {value:string}|undefined;
    const rows=db.prepare('SELECT config FROM cameras ORDER BY id').all() as {config:string}[];
    return {settings:saved?settingsSchema.parse(JSON.parse(saved.value)):bootstrap.settings,
      cameras:rows.map(row=>JSON.parse(row.config) as CameraConfig)};
  };
  const credentials=(camera:CameraConfig)=>{
    if (!camera.secretRef) return undefined;
    const secret=Object.hasOwn(secrets.cameras,camera.secretRef)?secrets.cameras[camera.secretRef]:undefined;
    if (!secret) throw Error('Unknown camera credential or certificate profile');
    return secret;
  };
  const transport=(camera:CameraConfig)=>new CameraTransport(new URL(camera.address),bootstrap.cameraNetworks,credentials(camera));
  const factory:CCAPIFactory=bootstrap.ccapiModule?(await import(pathToFileURL(bootstrap.ccapiModule).href)).default:canonCCAPI;
  if (typeof factory!=='function') throw Error('CCAPI module must export a factory');
  const adapter=(camera:CameraConfig)=>factory(Object.freeze(camera),transport(camera));
  const validateCamera=async(camera:CameraConfig)=>{ await transport(camera).approve(); };
  const auth=new Auth(bootstrap,secrets.oidcClientSecret);
  const keyPath=join(bootstrap.data,'vapid.json');
  const keys=await vapid(keyPath);
  if (process.argv[2]==='backup') {
    const target=process.argv[3];
    if (!target) throw Error('Supply a new backup directory');
    const folder=resolve(target);
    if (paths.roots.some(root=>within(root,folder)) || within(bootstrap.data,folder)) throw Error('Use a separate private backup location');
    await mkdir(folder,{mode:0o700});
    db.prepare('VACUUM INTO ?').run(join(folder,'sync.sqlite'));
    for (const [from,name] of [[bootstrapFile,'bootstrap.json'],[secretFile,'secrets.json'],[keyPath,'vapid.json']]) {
      const to=join(folder,name);
      await copyFile(from,to);
      await chmod(to,0o600);
    }
    db.close();
    console.log('Backup complete');
    return;
  }
  if (process.argv[2]==='doctor') {
    console.log('Runtime',process.version,'Backend 127.0.0.1:'+bootstrap.port);
    const checks:[string,()=>Promise<unknown>][]=[
      ['Database',async()=>{ if ((db.prepare('PRAGMA quick_check').get() as {quick_check:string}).quick_check!=='ok') throw Error(); }],
      ['OIDC',()=>auth.config()],['Default destination',()=>paths.check(config().settings.destination)],
      ['Web Push keys',async()=>keys.publicKey],
      ['Camera network policy',async()=>new CameraTransport(new URL('https://camera.invalid'),bootstrap.cameraNetworks)]
    ];
    config().cameras.forEach((camera,i)=>checks.push(['Camera '+(i+1),async()=>{
      if (camera.destination) await paths.check(camera.destination);
      if ((await adapter(camera).identify(AbortSignal.timeout(15000))).serial!==camera.serial) throw Error();
    }]));
    for(const [name,check] of checks) {
      try { await check(); console.log(name,'OK'); } catch { console.log(name,'check failed'); process.exitCode=1; }
    }
    db.close();
    return;
  }
  const push=new Push(db,keys,sender(bootstrap.pushSubject),()=>config().settings,id=>config().cameras.find(camera=>camera.id===id)?.notifications??{});
  const previews=new Previews(db,join(bootstrap.data,'previews'),()=>config().settings.thumbnailBytes);
  await previews.initialize();
  const engine=new Engine(db,paths,config,adapter,(kind,camera,message,eventId)=>{
    try { push.emit(kind,camera,message,undefined,eventId); } catch (error) {
      if (eventId) throw error;
      console.error('Could not record application event');
    }
  },(row,source,media,serial)=>previews.schedule(row,source,media,serial),
  factory===canonCCAPI ? () => 1 : camera => camera.concurrency);
  let ready=false;
  const server=web({bootstrap,auth,db,engine,paths,push,previews,config,adapter,validateCamera,ready:()=>ready});
  // Bind before recovery so another listener cannot recover a running daemon's queue.
  server.listen(bootstrap.port,'127.0.0.1');
  await once(server,'listening');
  try { await engine.recover(); } catch (error) { server.close(); throw error; }
  engine.start();
  ready=true;
  const delivery=setInterval(()=>void push.tick(),3000);
  const maintenance=setInterval(()=>{
    try {
      const cutoff=Date.now()-config().settings.eventDays*86400000;
      db.prepare("DELETE FROM deliveries WHERE event IN (SELECT id FROM events WHERE time<?)").run(cutoff);
      db.prepare('DELETE FROM events WHERE time<?').run(cutoff);
      db.prepare('DELETE FROM event_keys WHERE time<? AND key NOT IN (SELECT id FROM batches)').run(cutoff);
      void previews.trim().catch(()=>{});
    } catch { console.error('Maintenance failed'); }
  },3600000);
  console.log('Canon Photo Sync listening on 127.0.0.1:'+bootstrap.port);
  let stopping=false;
  async function stop() {
    if (stopping) return;
    stopping=true;
    ready=false;
    clearInterval(delivery);
    clearInterval(maintenance);
    const closed=new Promise<void>(done=>server.close(()=>done()));
    const deadline=setTimeout(()=>{server.closeAllConnections();process.exit(1);},20000);
    deadline.unref();
    await Promise.allSettled([engine.stop(),push.stop(),previews.stop(),closed]);
    db.close();
    clearTimeout(deadline);
  }
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>void stop());
}
main().catch(()=>{ console.error('Startup or maintenance command failed. Check runtime, private configuration, port, and data permissions.');process.exitCode=1; });

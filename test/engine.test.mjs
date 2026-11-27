import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readdir, rm, readFile, rename, symlink, link, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { Engine } from '../dist/engine.js';
import { SimulatedCamera } from '../dist/camera.js';
import { ImportPaths } from '../dist/paths.js';
import { openStore } from '../dist/store.js';
import { cameraSchema, settingsSchema } from '../dist/config.js';
import { CameraTransport } from '../dist/transport.js';
import { mockCCAPI } from './fixtures/providers.mjs';

export const item=(key,storage='slot1',name='IMG_0001.JPG',size=200000)=>({key:String(key),storage,name,path:storage+'/'+name,size,captured:'2025-01-01T01:00:00Z'});
export async function until(fn,timeout=8000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await fn())return;await wait(25);}
  assert.fail('Condition timed out');
}
async function setup(t) {
  const root=await mkdtemp(join(tmpdir(),'canon-engine-'));
  const dest=join(root,'import');await mkdir(dest);
  const path=join(root,'state.sqlite');
  let db=openStore(path);
  const cameras=[];
  const adapters=new Map();
  const settings=settingsSchema.parse({destination:dest,minimumBytes:0,batchSeconds:0,retries:2});
  const paths=new ImportPaths([dest]);
  const events=[];
  let engine;
  const create=()=>new Engine(db,paths,()=>({settings,cameras:[...cameras]}),camera=>adapters.get(camera.id),(...event)=>events.push(event));
  engine=create();
  t.after(async()=>{await engine.stop();db.close();await rm(root,{recursive:true,force:true});});
  const attach=(serial,adapter)=>{
    const camera={...cameraSchema.parse({name:serial,address:'https://camera.invalid',serial,poll:15,concurrency:2}),id:serial,created:0};
    cameras.push(camera);adapters.set(serial,adapter);
  };
  return {root,dest,path,attach,paths,settings,events,cameras,get engine(){return engine;},get db(){return db;},
    rows:()=>db.prepare('SELECT * FROM transfers ORDER BY created,id').all(),
    async restart(){await engine.stop();db.close();db=openStore(path);engine=create();await engine.recover();},
    async drive(check) {await until(async()=>{engine.tick();return check();});}
  };
}
test('offline camera reconnects while another camera imports independently',async t=>{
  const x=await setup(t);
  const a=new SimulatedCamera('a',[item(1)]);a.online=false;
  x.attach('a',a);x.attach('b',new SimulatedCamera('b',[item(2)]));
  await x.drive(()=>x.rows().some(row=>row.camera==='b'&&row.status==='done'));
  assert.equal(x.engine.states.get('a').status,'disconnected');
  a.online=true;x.engine.wake('a');
  await x.drive(()=>x.rows().filter(row=>row.status==='done').length===2);
  assert.equal((await readdir(x.dest)).length,2);
});
test('concurrent card duplicates collapse and changed metadata preserves counter resets',async t=>{
  const x=await setup(t);
  const a=new SimulatedCamera('a',[item(1),item(257,'slot2'),{...item(2,'slot1'),captured:'2025-01-02T00:00:00Z'}]);
  x.attach('a',a);
  await x.drive(()=>x.rows().filter(row=>['duplicate','done'].includes(row.status)).length===3);
  assert.equal(x.rows().filter(row=>row.status==='done').length,2);
  assert.equal((await readdir(x.dest)).length,2);
  assert.deepEqual(new Set(x.rows().map(row=>row.verification)),new Set(['source-size']));
});
test('interruption leaves no partial publication and resumes after restart',async t=>{
  const x=await setup(t);
  const a=new SimulatedCamera('a',[item(1)]);a.interrupted=true;x.attach('a',a);
  await x.drive(()=>x.rows().some(row=>row.error));
  assert.deepEqual(await readdir(x.dest),[]);
  assert.ok(x.events.some(event=>event[0]==='interrupted'));
  assert.ok(x.events.every(event=>event[0]!=='completed'));
  a.interrupted=false;await x.restart();
  x.db.exec('UPDATE transfers SET retry=0');
  await x.drive(()=>x.rows().some(row=>row.status==='done'));
  await x.drive(()=>x.events.some(event=>event[0]==='completed'));
});
test('history prevents reimport after completed file moved externally and daemon restarted',async t=>{
  const x=await setup(t);x.attach('a',new SimulatedCamera('a',[item(1)]));
  await x.drive(()=>x.rows().some(row=>row.status==='done'));
  await rename(x.rows()[0].destination,join(x.root,'moved.jpg'));
  await x.restart();
  await x.drive(()=>x.engine.states.get('a')?.status==='connected'&&!x.engine.states.get('a').scanning);
  assert.equal(x.rows().length,1);assert.deepEqual(await readdir(x.dest),[]);
});
test('recovery recognizes a published hard link and retains successful history',async t=>{
  const x=await setup(t);const file=join(x.dest,'frame.jpg');const stage=join(x.dest,'.staged');
  await writeFile(stage,'exact original');await link(stage,file);
  x.db.prepare("INSERT INTO transfers(id,camera,name,kind,model,media,fingerprint,status,created,destination,partial) VALUES ('t','a','frame.jpg','jpg','EOS','{}','one','publishing',0,?,?)").run(file,stage);
  await x.restart();
  assert.equal(x.rows()[0].status,'done');assert.equal(await readFile(file,'utf8'),'exact original');
  assert.deepEqual(await readdir(x.dest),['frame.jpg']);
});
test('low disk reserve prevents writes and retries independently',async t=>{
  const x=await setup(t);x.settings.minimumBytes=Number.MAX_SAFE_INTEGER;x.settings.retries=0;
  x.attach('a',new SimulatedCamera('a',[item(1)]));
  await x.drive(()=>x.rows().some(row=>row.status==='failed'));
  assert.deepEqual(await readdir(x.dest),[]);
  assert.ok(x.events.some(event=>event[0]==='nasSpace'));
});
test('identity mismatch never opens camera media',async t=>{
  const x=await setup(t);
  x.attach('a',new SimulatedCamera('wrong',[item(1)]));
  await x.drive(()=>x.engine.states.get('a')?.status==='error');
  assert.equal(x.rows().length,0);
});
test('import directory sandbox rejects symlink and traversal',async t=>{
  const x=await setup(t);
  await symlink(x.root,join(x.dest,'escape'));
  await assert.rejects(x.paths.browse(join(x.dest,'escape')));
  await assert.rejects(x.paths.directory(x.dest+'/../'));
  assert.deepEqual((await x.paths.browse(x.dest)).directories,[]);
  await assert.rejects(x.paths.create(join(x.root,'outside')));
});
test('camera SSRF rejects loopback, public addresses, and redirected URLs', async()=>{
  for(const address of ['127.0.0.1','169.254.169.254','203.0.113.1','[::1]']) {
    await assert.rejects(new CameraTransport(new URL('http://'+address),['0.0.0.0/0','::/0']).approve(),/outside/);
  }
  await assert.rejects(new CameraTransport(new URL('https://camera.invalid'),[]).get('https://other.invalid/',AbortSignal.timeout(1000)),/Invalid camera link/);
});
test('mock HTTP camera enumerates both card slots and streams originals', async t=>{
  const x=await setup(t);
  const remote=await mockCCAPI('http-camera',[item(1),item(2,'slot2')]);t.after(remote.close);
  remote.fixture.malformed=true;x.attach('http-camera',remote.adapter);
  await x.drive(()=>x.engine.states.get('http-camera')?.failures===1);
  assert.equal(x.rows().length,0);
  remote.fixture.malformed=false;x.engine.wake();
  await x.drive(()=>x.rows().filter(row=>row.status==='done').length===2);
  assert.deepEqual(new Set(x.rows().map(row=>JSON.parse(row.media).storage)),new Set(['slot1','slot2']));
});

test('graceful shutdown interrupts an active download and retains work for restart',async t=>{
  const x=await setup(t);
  const a=new SimulatedCamera('a',[item(1)]);
  const original=a.open.bind(a);
  a.open=async (media,signal)=>{
    await wait(30000,undefined,{signal});
    return original(media,signal);
  };
  x.attach('a',a);
  await x.drive(()=>x.engine.active.size===1);
  await x.engine.stop();
  assert.equal(x.rows()[0].status,'queued');assert.equal(x.rows()[0].attempts,0);
  assert.deepEqual(await readdir(x.dest),[]);
  a.open=original;await x.restart();x.db.exec('UPDATE transfers SET retry=0');
  await x.drive(()=>x.rows()[0].status==='done');
});
test('a destination edit applies to later work and leaves the active snapshot intact',async t=>{
  const x=await setup(t);
  const next=join(x.dest,'next');await mkdir(next);
  const a=new SimulatedCamera('a',[item(1)]);x.attach('a',a);
  const original=a.open.bind(a);
  let resolve;
  const gate=new Promise(done=>{resolve=done;});
  a.open=async (...args)=>{await gate;return original(...args);};
  await x.drive(()=>x.engine.active.size===1);
  x.cameras[0]={...x.cameras[0],destination:next};
  resolve();
  await x.drive(()=>x.rows()[0].status==='done');
  assert.equal(x.rows()[0].destination,join(x.dest,'IMG_0001.JPG'));
  a.media.push(item(2,'slot1','IMG_0002.JPG'));x.engine.wake();
  await x.drive(()=>x.rows().filter(row=>row.status==='done').length===2);
  assert.equal(x.rows().find(row=>row.name==='IMG_0002.JPG').destination,join(next,'IMG_0002.JPG'));
});
test('incomplete byte count and incorrect source hash are never finalized',async t=>{
  const x=await setup(t);x.settings.retries=0;
  const a=new SimulatedCamera('a',[{...item(1),sha256:'0'.repeat(64)},item(2,'slot2','IMG_0002.JPG')]);
  const original=a.open.bind(a);
  a.open=async(media,signal)=>original(media.key==='2'?{...media,size:10}:media,signal);
  x.attach('a',a);
  await x.drive(()=>x.rows().filter(row=>row.status==='failed').length===2);
  assert.deepEqual(await readdir(x.dest),[]);
  a.online=true;x.engine.wake();
  await x.drive(()=>x.events.some(event=>event[0]==='completedErrors'));
  assert.ok(x.events.every(event=>event[0]!=='completed'));
});
test('SQLite snapshot restores a database including completed history',async t=>{
  const x=await setup(t);x.attach('a',new SimulatedCamera('a',[item(1)]));
  await x.drive(()=>x.rows().some(row=>row.status==='done'));
  const snapshot=join(x.root,'backup.sqlite');x.db.prepare('VACUUM INTO ?').run(snapshot);
  const backup=openStore(snapshot);
  try {assert.equal(backup.prepare('PRAGMA quick_check').get().quick_check,'ok');
    assert.equal(backup.prepare("SELECT count(*) AS total FROM transfers WHERE status='done'").get().total,1);}
  finally {backup.close();}
});

test('bounded preview cache serves and evicts a small JPEG without touching the original',async t=>{
  const {Previews}=await import('../dist/previews.js');
  const x=await setup(t);
  const id='00000000-0000-0000-0000-000000000001';
  const name='small.jpg';
  const destination=join(x.dest,name);
  const original=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDiqKKK+aPjz//Z','base64');
  await writeFile(destination,original);
  x.db.prepare("INSERT INTO transfers(id,camera,name,kind,model,media,fingerprint,status,created,destination) VALUES (?,?,?,'jpg','EOS','{}','preview','done',0,?)")
    .run(id,'a',name,destination);
  let limit=128000;
  const previews=new Previews(x.db,join(x.root,'thumbs'),()=>limit);
  await previews.initialize();
  previews.schedule(x.rows()[0],new SimulatedCamera('a',[]),item(1),'a');
  await until(()=>previews.get(id));
  assert.deepEqual(await previews.get(id),original);
  limit=0;
  await previews.stop();await previews.trim();
  assert.equal(await previews.get(id),undefined);
  assert.deepEqual(await readFile(destination),original);
});

test('new-media policy and UTC layout use camera modification time when capture time is absent',async t=>{
  const x=await setup(t);
  const older={...item(1,'slot1','OLD.JPG'),captured:undefined,modified:'2025-01-01T21:00:00Z'};
  const newer={...item(2,'slot1','NEW.JPG'),captured:undefined,modified:'2025-01-02T01:00:00Z'};
  x.attach('a',new SimulatedCamera('a',[older,newer]));
  x.cameras[0]={...x.cameras[0],mode:'new',layout:'date',created:Date.parse('2025-01-02T00:00:00Z')};
  await x.drive(()=>x.rows().some(row=>row.status==='done'));
  assert.deepEqual(x.rows().map(row=>row.name),['NEW.JPG']);
  assert.equal(x.rows()[0].destination,join(x.dest,'2025-01-02','NEW.JPG'));
});

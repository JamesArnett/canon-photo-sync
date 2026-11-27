import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CanonR6MarkII } from '../dist/ccapi.js';
import { CameraTransport } from '../dist/transport.js';
import { CameraBusy } from '../dist/camera.js';
import { CameraDigest } from '../dist/digest.js';
import { cameraSchema } from '../dist/config.js';
import { listen } from './fixtures/providers.mjs';

const contents='/ccapi/ver120/contents';
const storage=contents+'/card1';
const cardTwo=contents+'/card2';
const directory=storage+'/100CANON';
const file=directory+'/FRAME_1.CR3';
const second=directory+'/FRAME_2.JPG';
const movie=cardTwo+'/101CANON/CLIP_1.MP4';
const mirrorDirectory=cardTwo+'/100CANON';
const mirrorFile=mirrorDirectory+'/FRAME_1.CR3';
const uniqueStill=mirrorDirectory+'/FRAME_3.JPG';
const primaryMovie=directory+'/CLIP_2.MP4';
const secondaryMovie=mirrorDirectory+'/CLIP_2.MP4';
const identityPath='/ccapi/ver100/deviceinformation';
const serial='fixture-serial';
const bytes=Buffer.from('fixture original');
const date='Tue, 03 Nov 2026 12:34:56 GMT';
const signal=()=>AbortSignal.timeout(5000);
const sendJson=(res,body)=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(body));

function localTransport(origin,secret) {
  const transport=new CameraTransport(new URL(origin),[],secret);
  // Fixture-only DNS approval. The daemon always uses the production policy.
  transport.approve=async()=>({address:'127.0.0.1',family:4});
  return transport;
}
async function fixture(t,config={}) {
  const requests=[];
  const scenario={badPath:false,wrongSerial:false,busy:false,modified:date,wrongLength:false,model:'Canon EOS R6 Mark II',mirror:false,primaryMounted:true};
  const server=createServer((req,res)=>{
    requests.push([req.method,req.url]);
    const {pathname,searchParams}=new URL(req.url,'http://fixture.invalid');
    if(pathname===identityPath) return sendJson(res,{productname:scenario.model,serialnumber:scenario.wrongSerial?'different':serial});
    if(pathname===contents) {
      if(scenario.busy) return res.writeHead(503).end();
      const primary=scenario.badPath?'https://other.invalid'+storage:storage;
      return sendJson(res,{path:!scenario.primaryMounted?[cardTwo]:scenario.mirror?[cardTwo,primary]:[primary,cardTwo]});
    }
    if(pathname===storage) return sendJson(res,{path:[directory]});
    if(pathname===cardTwo) return sendJson(res,{path:scenario.mirror?[mirrorDirectory,cardTwo+'/101CANON']:[cardTwo+'/101CANON']});
    if(pathname===directory) {
      if(searchParams.get('kind')==='number') return sendJson(res,{pagenumber:2,contentsnumber:scenario.mirror?102:101});
      const path=searchParams.get('page')==='1'?[file,...Array.from({length:99},(_,i)=>directory+'/note'+i+'.txt')]:scenario.mirror?[second,primaryMovie]:[second];
      return sendJson(res,{path});
    }
    if(pathname===mirrorDirectory || pathname===cardTwo+'/101CANON') {
      const path=pathname===mirrorDirectory?[mirrorFile,uniqueStill,secondaryMovie]:[movie];
      return sendJson(res,searchParams.get('kind')==='number'?{pagenumber:1,contentsnumber:path.length}:{path});
    }
    if([file,second,movie,mirrorFile,uniqueStill,primaryMovie,secondaryMovie].includes(pathname)) {
      if(searchParams.get('kind')==='info') return sendJson(res,{filesize:bytes.length,lastmodifieddate:scenario.modified});
      if(searchParams.get('kind')==='thumbnail') {
        return res.writeHead(200,{'Content-Type':'image/jpeg'}).end(Buffer.from([255,216,255,217]));
      }
      if(searchParams.get('kind')==='main') {
        const payload=scenario.wrongLength?Buffer.concat([bytes,bytes]):bytes;
        return res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':payload.length}).end(payload);
      }
    }
    if(pathname==='/ccapi/ver110/devicestatus/storage') return sendJson(res,{storagelist:[{spacesize:700},{spacesize:1200}]});
    if(pathname==='/ccapi/ver110/devicestatus/batterylist') return sendJson(res,{batterylist:[{kind:'battery',level:'79'}]});
    res.writeHead(404).end();
  });
  const origin=await listen(server);
  t.after(()=>{server.closeAllConnections();server.close();});
  const transport=localTransport(origin);
  return {adapter:new CanonR6MarkII({serial,...config},transport),requests,scenario,transport};
}
async function gather(adapter) {
  const media=[];
  for await(const item of adapter.list(signal())) media.push(item);
  return media;
}
test('read-only Canon HTTP adapter identifies, pages both cards, streams originals, and fetches a JPEG preview',async t=>{
  const {adapter,requests,scenario}=await fixture(t);
  assert.equal((await adapter.identify(signal())).model,scenario.model);
  scenario.model='Canon EOS R6m2';
  const identity=await adapter.identify(signal());
  assert.equal(identity.serial,serial);
  assert.equal(identity.model,scenario.model);
  const media=await gather(adapter);
  assert.deepEqual(media.map(m=>m.path),[file,second,movie]);
  assert.deepEqual(media.map(m=>m.storage),['card1','card1','card2']);
  assert.equal(media[0].captured,undefined);
  assert.equal(media[0].modified,'2026-11-03T12:34:56.000Z');
  assert.equal(identity.free,1900);
  assert.equal(identity.battery,79);
  const raw=await adapter.open(media[0],signal());
  const chunks=[];
  for await(const part of raw) chunks.push(part);
  assert.deepEqual(Buffer.concat(chunks),bytes);
  assert.deepEqual(await adapter.thumbnail(media[0],signal()),Buffer.from([255,216,255,217]));
  assert.ok(requests.every(([method])=>method==='GET'));
  assert.ok(requests.some(([,path])=>path===directory+'?kind=list&page=2'));
});
test('Canon adapter rejects identity mismatches, escaped links, changed files and wrong original lengths',async t=>{
  const {adapter,requests,scenario}=await fixture(t);
  scenario.wrongSerial=true;
  await assert.rejects(gather(adapter),/serial does not match/);
  assert.deepEqual(requests, [['GET',identityPath]]);
  scenario.wrongSerial=false;
  await adapter.identify(signal());
  scenario.badPath=true;
  await assert.rejects(gather(adapter),/content path/);
  scenario.badPath=false;
  const [media]=await gather(adapter);
  scenario.modified='Wed, 04 Nov 2026 12:34:56 GMT';
  await assert.rejects(adapter.open(media,signal()),/changed since enumeration/);
  assert.equal(requests.filter(([,path])=>path.endsWith('?kind=main')).length,0);
  scenario.modified=date;
  scenario.wrongLength=true;
  await assert.rejects(adapter.open(media,signal()),/original response/);
  scenario.busy=true;
  await assert.rejects(gather(adapter),CameraBusy);
});
test('duplicate stills mode prefers card 1 while retaining unmatched files and movies on card 2',async t=>{
  const {adapter,requests,scenario,transport}=await fixture(t,{cardRecording:'duplicate-stills'});
  scenario.mirror=true;
  assert.deepEqual((await gather(adapter)).map(m=>m.path),[file,second,primaryMovie,uniqueStill,secondaryMovie,movie]);
  assert.ok(!requests.some(([,path])=>path===mirrorFile+'?kind=info'));
  assert.ok(requests.some(([,path])=>path===mirrorDirectory+'?kind=list&page=1'));
  const defaultAdapter=new CanonR6MarkII({serial},transport);
  assert.ok((await gather(defaultAdapter)).some(m=>m.path===mirrorFile));
  scenario.primaryMounted=false;
  assert.deepEqual((await gather(adapter)).map(m=>m.path),[mirrorFile,uniqueStill,secondaryMovie,movie]);
});
test('Canon resolves local file timestamps using the configured time zone and skips ambiguous times',async t=>{
  const input={name:'Fixture camera',address:'https://camera.invalid',serial};
  const config=cameraSchema.parse({...input,timeZone:'America/Los_Angeles'});
  assert.equal(cameraSchema.parse(input).timeZone,undefined);
  assert.equal(cameraSchema.safeParse({...input,timeZone:'Invalid/Zone'}).success,false);
  assert.equal(cameraSchema.safeParse({...input,timeZone:'-08:00'}).success,false);
  const {adapter,scenario,transport}=await fixture(t,config);
  const cases=[
    [date,'2026-11-03T12:34:56.000Z'],
    ['Thu, 15 Jan 2026 12:34:56','2026-01-15T20:34:56.000Z'],
    ['Wed, 15 Jul 2026 23:34:56','2026-07-16T06:34:56.000Z'],
    ['Sun, 08 Mar 2026 02:30:00',undefined],
    ['Sun, 01 Nov 2026 01:30:00',undefined],
    ['Sun, 31 Apr 2026 12:34:56',undefined]
  ];
  for(const [raw,expected] of cases) {
    scenario.modified=raw;
    assert.equal((await gather(adapter))[0].modified,expected,raw);
  }
  scenario.modified=cases[1][0];
  assert.equal((await gather(new CanonR6MarkII({serial},transport)))[0].modified,undefined);
});
test('Canon Digest handles a real HTTPS challenge and signs the exact GET request target',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'canon-digest-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const key=join(folder,'key.pem'),cert=join(folder,'cert.pem');
  const opensslConfig=join(folder,'openssl.cnf');
  await writeFile(opensslConfig,'[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\n');
  execFileSync('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-keyout',key,'-out',cert,'-days','1',
    '-config',opensslConfig],{stdio:'ignore'});
  const pem=await readFile(cert,'utf8');
  const credentials={username:'fixture',password:'synthetic password'};
  const challenge='Digest realm="CameraControlApi", nonce="nonce", opaque="fixture", algorithm=MD5, qop="auth"';
  const md5=value=>createHash('md5').update(value).digest('hex');
  let verified=0;
  const server=httpsServer({key:await readFile(key),cert:pem},(req,res)=>{
    if(!req.headers.authorization) return res.writeHead(401,{'WWW-Authenticate':challenge}).end();
    const fields=Object.fromEntries(Array.from(req.headers.authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g),
      ([,name,quoted,plain])=>[name,quoted??plain]));
    const expected=md5([md5('fixture:CameraControlApi:synthetic password'),'nonce',fields.nc,fields.cnonce,'auth',md5('GET:'+req.url)].join(':'));
    if(fields.uri!==req.url || fields.response!==expected || fields.opaque!=='fixture') return res.writeHead(403).end();
    verified++;
    return sendJson(res,{ok:true});
  });
  const origin=(await listen(server)).replace('http:','https:');
  t.after(()=>{server.closeAllConnections();server.close();});
  const transport=localTransport(origin,{ca:pem,digest:credentials});
  assert.deepEqual(await transport.json(file+'?kind=info',signal()),{ok:true});
  assert.deepEqual(await transport.json(identityPath,signal()),{ok:true});
  assert.equal(verified,2);
  await assert.rejects(localTransport(origin,{digest:credentials}).json(identityPath,signal()),/certificate validation/);
  assert.throws(()=>localTransport(origin.replace('https:','http:'),{digest:credentials}),/credentials require HTTPS/);
  assert.throws(()=>new CameraDigest('fixture','synthetic').accept(challenge.replace('CameraControlApi','OtherRealm')),/Unsupported/);
});

import { request as http } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { bootstrapSchema, settingsSchema } from '../dist/config.js';
import { Auth, authorized } from '../dist/auth.js';
import { web } from '../dist/web.js';
import { openStore } from '../dist/store.js';
import { allowedPush, Push, vapid } from '../dist/push.js';
import { mockOIDC, mockPush, listen } from './fixtures/providers.mjs';

test('signed OIDC callback validates issuer, audience, signature, state, nonce, expiry and authorization',async t=>{
  const provider=mockOIDC();
  const bootstrap=bootstrapSchema.parse({origin:'https://photos.fixture.invalid',data:'/var/lib/canon',allowedRoots:['/media/import'],
    cameraNetworks:[],settings:{destination:'/media/import'},pushSubject:'mailto:nobody@example.invalid',
    oidc:{issuer:provider.issuer,clientId:'canon',subjects:['approved'],groups:['photo'] }});
  const auth=new Auth(bootstrap,'synthetic',await provider.config());
  const server=web({bootstrap,auth,config:()=>({settings:bootstrap.settings,cameras:[]})});
  const base=await listen(server);
  t.after(()=>{server.closeAllConnections();server.close();});
  const host=new URL(bootstrap.origin).host;
  const request=(path,options={})=>new Promise((resolve,reject)=>{
    const req=http(base+path,{...options,headers:{Host:host,...options.headers}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:{get:key=>res.headers[key],getSetCookie:()=>res.headers['set-cookie']??[]},
        json:async()=>JSON.parse(Buffer.concat(chunks).toString())}));
    });
    req.on('error',reject);
    req.end();
  });
  assert.equal((await request('/api/session')).status,401);
  assert.equal((await request('/api/devices',{method:'PUT'})).status,401);
  assert.equal((await request('/api/directories')).status,401);
  assert.equal((await request('/',{headers:{Host:'other.invalid'}})).status,400);
  assert.equal((await request('/',{headers:{'X-Forwarded-Host':'other.invalid'}})).status,400);
  assert.equal((await request('/',{headers:{'X-Forwarded-Proto':'http'}})).status,400);
  for(const variant of ['issuer','audience','signature','state','nonce','expired','unauthorized','group','valid']){
    const start=await request('/auth/login');
    assert.equal(start.status,303);
    const address=new URL(start.headers.get('location'));
    assert.ok(address.searchParams.get('code_challenge'));
    const flow=start.headers.getSetCookie()[0].split(';')[0];
    provider.state.nonce=variant==='nonce'?'incorrect':address.searchParams.get('nonce');
    provider.state.badSignature=variant==='signature';
    provider.state.subject=['unauthorized','group'].includes(variant)?'other':'approved';
    provider.state.override=variant==='issuer'?{iss:'https://wrong.invalid'}:variant==='audience'?{aud:'wrong'}:
      variant==='expired'?{exp:1}:variant==='group'?{groups:['photo']}:{};
    const state=variant==='state'?'wrong':address.searchParams.get('state');
    const finish=await request('/auth/callback?code=fixture&state='+state,{headers:{Cookie:flow}});
    const valid=['valid','group'].includes(variant);
    assert.equal(finish.status,valid?303:401,variant);
    if(!valid)continue;
    const cookie=finish.headers.getSetCookie()[0].split(';')[0];
    assert.match(finish.headers.getSetCookie()[0],/Secure; HttpOnly; SameSite=Lax/);
    const session=await request('/api/session',{headers:{Cookie:cookie}});
    assert.equal(session.status,200);
    const {csrf}=await session.json();
    assert.equal((await request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:bootstrap.origin}})).status,403);
    assert.equal((await request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:'https://wrong.invalid','X-CSRF-Token':csrf}})).status,403);
    assert.equal((await request('/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:bootstrap.origin,'X-CSRF-Token':csrf}})).status,200);
    assert.equal((await request('/api/session',{headers:{Cookie:cookie}})).status,401);
  }
  assert.equal(authorized({...bootstrap.oidc,subjects:[],groups:[]},{sub:'approved'}),false);
});
test('push persists keys, deduplicates events, retries and removes expired subscriptions',async t=>{
  const work=await mkdtemp(join(tmpdir(),'canon-push-'));
  const db=openStore(join(work,'data.sqlite'));
  t.after(async()=>{db.close();await rm(work,{force:true,recursive:true});});
  const path=join(work,'vapid.json');
  const keys=await vapid(path);assert.deepEqual(await vapid(path),keys);
  const provider=mockPush([503,201,410]);
  const settings=settingsSchema.parse({destination:'/media/import',privatePush:true});
  const push=new Push(db,keys,provider.send,()=>settings, id=>id==='silent'?{completed:false}:{});
  const ecdh=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
  const p256dh=Buffer.concat([Buffer.from([4]),Buffer.from(ecdh.x,'base64url'),Buffer.from(ecdh.y,'base64url')]).toString('base64url');
  const subscription={endpoint:'https://web.push.apple.com/fixture',keys:{auth:Buffer.alloc(16).toString('base64url'),p256dh}};
  assert.equal(allowedPush('https://web.push.apple.com.other.invalid/a'),false);
  assert.equal(allowedPush('https://127.0.0.1/a'),false);
  assert.equal(allowedPush('https://evil@web.push.apple.com/a'),false);
  assert.throws(()=>push.register('subject',{name:'unsafe',subscription:{...subscription,endpoint:'https://127.0.0.1'}}));
  push.register('subject',{name:'iPhone',subscription});
  assert.deepEqual(Object.keys(push.devices('subject')[0]),['id','name','events','quiet']);
  assert.throws(()=>push.register('other',{name:'Other',subscription}));
  const hour=new Date().getUTCHours();
  push.register('subject',{name:'iPhone',subscription,quiet:{from:hour,to:(hour+1)%24,offset:0,allowUrgent:false}});
  push.emit('completed','camera','quiet delivery');
  await push.tick();
  assert.equal(provider.messages.length,0);
  db.exec('DELETE FROM deliveries');
  push.register('subject',{name:'iPhone',subscription,events:{connected:false}});
  push.emit('connected','camera','connected');
  push.emit('completed','silent','override suppresses this');
  push.emit('completed','camera','private camera name');
  push.emit('completed','camera','private camera name');
  await push.tick();
  assert.equal(provider.messages.length,1);
  assert.equal(provider.messages[0].payload.body,'Open Canon Photo Sync for details.');
  db.exec('UPDATE deliveries SET due=0');
  await push.tick();
  assert.equal(db.prepare("SELECT count(*) AS n FROM deliveries WHERE state='submitted'").get().n,1);
  push.emit('test','','test','subject');
  await push.tick();
  assert.equal(push.devices('subject').length,0);
});
test('PWA shell is installable and service worker routes only static assets',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../public/manifest.webmanifest',import.meta.url)));
  assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
  for(const icon of manifest.icons)assert.ok((await readFile(new URL('../public'+icon.src,import.meta.url))).length>100);
  const sw=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
  assert.match(sw,/shell\.includes\(url\.pathname\)/);assert.doesNotMatch(sw,/\/api\//);
});

test('production Web Push library prepares an encrypted payload and VAPID authorization offline', async()=>{
  const webpush=await import('web-push');
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'jwk'});
  const p256dh=Buffer.concat([Buffer.from([4]),Buffer.from(key.x,'base64url'),Buffer.from(key.y,'base64url')]).toString('base64url');
  const data=webpush.generateRequestDetails({endpoint:'https://web.push.apple.com/fixture',
    keys:{auth:Buffer.alloc(16).toString('base64url'),p256dh}},'fixture privacy check',
    {vapidDetails:{subject:'mailto:test@example.invalid',...webpush.generateVAPIDKeys()}});
  assert.equal(data.headers['Content-Encoding'],'aes128gcm');
  assert.match(data.headers.Authorization,/^vapid /);
  assert.equal(data.body.includes(Buffer.from('fixture privacy check')),false);
});

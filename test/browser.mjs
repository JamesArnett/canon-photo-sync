import { chromium } from 'playwright-core';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { bootstrapSchema } from '../dist/config.js';
import { Auth } from '../dist/auth.js';
import { Engine } from '../dist/engine.js';
import { SimulatedCamera } from '../dist/camera.js';
import { ImportPaths } from '../dist/paths.js';
import { Previews } from '../dist/previews.js';
import { Push, vapid } from '../dist/push.js';
import { openStore } from '../dist/store.js';
import { web } from '../dist/web.js';
import { mockOIDC, mockPush } from './fixtures/providers.mjs';

const root=await mkdtemp(join(tmpdir(),'canon-browser-'));
const destination=join(root,'imports');await mkdir(destination);
const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(done=>probe.close(done));
const origin='http://127.0.0.1:'+port;
const provider=mockOIDC();
const bootstrap={...bootstrapSchema.parse({
  origin:'https://test.invalid',data:root,allowedRoots:[destination],cameraNetworks:[],
  pushSubject:'mailto:test@example.invalid',oidc:{issuer:provider.issuer,clientId:'canon',subjects:['approved']},
  settings:{destination,minimumBytes:0,batchSeconds:0}
}),origin};
const db=openStore(join(root,'app.sqlite'));
const paths=new ImportPaths([destination]);
const previews=new Previews(db,join(root,'previews'),()=>0);await previews.initialize();
const config=()=>{
  const saved=db.prepare("SELECT value FROM settings WHERE key='general'").get();
  return {settings:saved?JSON.parse(saved.value):bootstrap.settings,
    cameras:db.prepare('SELECT config FROM cameras').all().map(row=>JSON.parse(row.config))};
};
const source=new SimulatedCamera('SIM-BROWSER',[{key:'1',storage:'first',path:'first/Sample.JPG',name:'Sample.JPG',size:1024}]);
const adapter=()=>source;
const engine=new Engine(db,paths,config,adapter);
const push=new Push(db,await vapid(join(root,'vapid.json')),mockPush().send,()=>config().settings);
const auth=new Auth(bootstrap,'synthetic',await provider.config());
const server=web({bootstrap,auth,db,engine,paths,push,previews,config,adapter,validateCamera:async()=>{}});
server.listen(port,'127.0.0.1');await once(server,'listening');
engine.start();
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(provider.issuer+'/authorize?*',async route=>{
    const query=new URL(route.request().url()).searchParams;
    provider.state.nonce=query.get('nonce');
    await route.fulfill({status:303,headers:{Location:origin+'/auth/callback?code=fixture&state='+query.get('state')}});
  });
  await page.goto(origin);
  await page.getByRole('link',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
  await page.getByRole('link',{name:'Cameras',exact:true}).click();
  await page.getByLabel('Friendly name').fill('Fixture camera');
  await page.getByLabel('Address including scheme and port').fill('https://camera.fixture.invalid');
  await page.getByLabel('Expected serial number').fill('SIM-BROWSER');
  const recording=page.getByLabel('Canon card recording');
  assert.equal(await recording.inputValue(),'all');
  await recording.selectOption('duplicate-stills');
  await page.getByLabel('Camera time zone (Canon)').fill('America/Los_Angeles');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Fixture camera · Enabled').click();
  assert.equal(config().cameras[0].cardRecording,'duplicate-stills');
  assert.equal(config().cameras[0].timeZone,'America/Los_Angeles');
  assert.equal(await page.locator('details[open]').getByLabel('Canon card recording').inputValue(),'duplicate-stills');
  assert.equal(await page.locator('details[open]').getByLabel('Camera time zone (Canon)').inputValue(),'America/Los_Angeles');
  await page.getByRole('link',{name:'Dashboard',exact:true}).click();
  await page.getByText('Sample.JPG',{exact:true}).first().waitFor({timeout:15000});
  await page.getByRole('link',{name:'Activity',exact:true}).click();
  await page.getByText('Sample.JPG · done',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await page.getByRole('heading',{name:'Notifications'}).waitFor();
  await page.getByRole('button',{name:'Browse directories'}).click();
  await page.getByRole('dialog').getByRole('button',{name:destination,exact:true}).click();
  await page.getByRole('button',{name:'Select this directory'}).click();
  await page.getByLabel('Appearance').selectOption('dark');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  assert.equal(config().settings.appearance,'dark');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>navigator.serviceWorker.ready);
  const cached=await page.evaluate(async()=>Promise.all((await caches.keys()).map(async key=>(await (await caches.open(key)).keys()).map(row=>new URL(row.url).pathname))));
  assert.ok(cached.flat().includes('/'));
  assert.ok(cached.flat().every(path=>!path.startsWith('/api/')));
  await context.setOffline(true);
  await page.getByText('Dashboard unavailable.',{exact:false}).waitFor();
  assert.equal(await page.getByText('Fixture camera',{exact:true}).count(),0);
  await page.reload({waitUntil:'load'});
  await page.getByText('Dashboard unavailable.',{exact:false}).waitFor();
  await context.setOffline(false);
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByRole('link',{name:'Sign in',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Chromium mobile viewport smoke passed: signed OIDC, configuration, import, history, directory picker, theme, service worker, offline shell, logout.');
} finally {
  await browser?.close();
  server.closeAllConnections();await new Promise(done=>server.close(done));
  await engine.stop();db.close();await rm(root,{recursive:true,force:true});
}

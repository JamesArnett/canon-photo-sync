import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { Engine } from '../dist/engine.js';
import { SimulatedCamera } from '../dist/camera.js';
import { ImportPaths } from '../dist/paths.js';
import { openStore } from '../dist/store.js';
import { settingsSchema, cameraSchema } from '../dist/config.js';
import assert from 'node:assert/strict';

const root=await mkdtemp(join(tmpdir(),'canon-simulate-'));
const destination=join(root,'originals');await mkdir(destination);
const database=join(root,'state.sqlite');
const large=process.argv.includes('--large');
const size=large?2304*1024**2:16*1024**2;
const db=openStore(database);
const settings=settingsSchema.parse({destination,minimumBytes:0,batchSeconds:0});
const item=(key,size,storage)=>({key,storage,name:'CLIP_0001.MP4',path:storage+'/CLIP_0001.MP4',size,captured:'2025-01-01T12:00:00Z'});
const adapterA=new SimulatedCamera('A',[item('1',size,'slot1')]);
const adapterB=new SimulatedCamera('B',[item('2',16*1024**2,'slot2')]);adapterB.online=false;
const cameras=['A','B'].map(id=>({...cameraSchema.parse({name:'Simulated EOS '+id,address:'https://example.invalid',serial:id}),id,created:0}));
const records=[];
const engine=new Engine(db,new ImportPaths([destination]),()=>({settings,cameras:[...cameras]}),camera=>camera.id==='A'?adapterA:adapterB,(...event)=>records.push(event));
const idle=process.memoryUsage.rss();
let peak=idle;
const meter=setInterval(()=>{peak=Math.max(peak,process.memoryUsage.rss());},10);
const begin=performance.now();
const budget=begin+120000;
try {
  while(performance.now()<budget){
    engine.tick();
    if (engine.states.get('B')?.failures&&!adapterB.online){adapterB.online=true;engine.wake('B');}
    if (records.filter(event=>event[0]==='completed').length===2)break;
    await wait(15);
  }
  const rows=db.prepare("SELECT size,status,duration,verification FROM transfers WHERE status='done'").all();
  assert.equal(rows.length,2);
  assert.equal((await readdir(destination)).length,2);
  assert.equal(rows.reduce((sum,row)=>sum+row.size,0),size+16*1024**2);
  console.log(JSON.stringify({runtime:process.version,cameras:2,files:rows.length,bytes:size+16*1024**2,
    seconds:+((performance.now()-begin)/1000).toFixed(2),idleRssMiB:+(idle/1024**2).toFixed(1),
    peakRssMiB:+(peak/1024**2).toFixed(1),verification:rows.map(row=>row.verification)},null,2));
} finally {
  clearInterval(meter);
  await engine.stop();db.close();await rm(root,{recursive:true,force:true});
}

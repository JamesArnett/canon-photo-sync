import { CameraBusy } from './camera.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Auth, equal } from './auth.js';
import { cameraSchema, events, settingsSchema, type Bootstrap, type CameraConfig, type Settings } from './config.js';
import type { Engine, Transfer } from './engine.js';
import type { CameraAdapter } from './camera.js';
import type { Database } from './store.js';
import type { ImportPaths } from './paths.js';
import type { Push } from './push.js';
import { CameraProtocolError, CameraUnavailable } from './transport.js';
import type { Previews } from './previews.js';

type Context = {
  bootstrap:Bootstrap;auth:Auth;db:Database;engine:Engine;paths:ImportPaths;push:Push;previews:Previews;
  config:()=>{settings:Settings;cameras:CameraConfig[]};adapter:(camera:CameraConfig)=>CameraAdapter;
  validateCamera:(camera:CameraConfig)=>Promise<void>;ready?:()=>boolean;
};
const files = new Map(Object.entries({'/':'index.html','/styles.css':'styles.css','/app.js':'app.js','/sw.js':'sw.js','/manifest.webmanifest':'manifest.webmanifest','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png','/apple-touch-icon.png':'apple-touch-icon.png'}));
const mime:Record<string,string> = {html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',webmanifest:'application/manifest+json',png:'image/png'};
const json = (res:ServerResponse,status:number,value:unknown) => res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(value));
class HttpError extends Error { constructor(readonly status:number,message:string){super(message);} }
async function body(req:IncomingMessage):Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415,'Expected JSON');
  const chunks:Buffer[]=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>262144) throw new HttpError(413,'Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400,'Invalid JSON'); }
}
function history(db:Database,url:URL) {
  const conditions:string[]=[];
  const args:(string|number)[]=[];
  for (const field of ['camera','kind','status']) {
    const value=url.searchParams.get(field);
    if (value) { conditions.push(field+'=?'); args.push(value.slice(0,128)); }
  }
  const search=url.searchParams.get('search');
  if (search) { conditions.push('instr(lower(name),lower(?))>0'); args.push(search.slice(0,200)); }
  for (const [field,op] of [['from','>='],['to','<=']]) {
    const value=url.searchParams.get(field);
    if (value && !Number.isFinite(Date.parse(value))) throw new HttpError(400,'Invalid date');
    if (value) { conditions.push('created'+op+'?'); args.push(Date.parse(value)+(field==='to'?86399999:0)); }
  }
  return {where:conditions.length?' WHERE '+conditions.join(' AND '):'',args};
}
const csv = (value:unknown) => {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'"+text;
  return '"'+text.replaceAll('"','""')+'"';
};

export function web(ctx:Context) {
  const {bootstrap,auth,db,engine,paths,push,previews}=ctx;
  const host=new URL(bootstrap.origin).host;
  const rate=new Map<string,{bucket:number;used:number}>();
  const start=Date.now();
  const server=createServer({requestTimeout:15000,headersTimeout:10000},async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Strict-Transport-Security','max-age=31536000');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== host ||
        (req.headers['x-forwarded-host'] !== undefined && req.headers['x-forwarded-host'] !== host) ||
        (req.headers['x-forwarded-proto'] !== undefined && req.headers['x-forwarded-proto'] !== 'https') ||
        !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw new HttpError(400,'Invalid request origin');
      const url=new URL(req.url,bootstrap.origin);
      if (url.origin!==bootstrap.origin) throw new HttpError(400,'Invalid request origin');
      if (req.headers.origin && req.headers.origin !== bootstrap.origin) throw new HttpError(403,'Origin denied');
      if (ctx.ready && !ctx.ready()) throw new HttpError(503,'Photo Sync is starting or shutting down');
      const path=url.pathname;
      const method=req.method;
      const file=files.get(path);
      if (method==='GET' && file) {
        const content=await readFile(resolve(import.meta.dirname,'../public',file));
        res.writeHead(200,{'Content-Type':mime[file.split('.').at(-1)!]}).end(content);
        return;
      }
      const session=auth.session(req);
      if (!session || method !== 'GET') {
        const bucket=Math.floor(Date.now()/60000);
        const key=session?.subject ?? 'anonymous';
        if(rate.size>1024 || [...rate.values()].some(value=>value.bucket!==bucket)) {
          for(const [id,value] of rate) if(value.bucket!==bucket) rate.delete(id);
        }
        const limit=rate.get(key) ?? {bucket,used:0};
        if(++limit.used > (session?120:90)) throw new HttpError(429,'Please wait before retrying');
        rate.set(key,limit);
      }
      if (method==='GET' && path==='/auth/login') { await auth.begin(req,res); return; }
      if (method==='GET' && path==='/auth/callback') {
        try { await auth.finish(req,res,url); } catch { throw new HttpError(401,'SSO rejected the login or identity is unauthorized'); }
        return;
      }
      if (!session) throw new HttpError(401,'Sign in required');
      if (method!=='GET' && (req.headers.origin!==bootstrap.origin || typeof req.headers['x-csrf-token'] !== 'string' ||
        !equal(req.headers['x-csrf-token'],session.csrf))) throw new HttpError(403,'Request verification failed');
      const {settings,cameras}=ctx.config();
      if (method==='GET' && path==='/api/session') return json(res,200,{csrf:session.csrf});
      if (method==='POST' && path==='/auth/logout') return json(res,200,{redirect:await auth.logout(req,res)});
      if (method==='GET' && path==='/api/status') {
        const counts=db.prepare("SELECT status,count(*) AS count,coalesce(sum(size),0) AS bytes,max(completed) AS last FROM transfers GROUP BY status").all();
        const cameraCounts=db.prepare("SELECT camera,status,count(*) AS count FROM transfers WHERE status IN ('queued','failed','review') GROUP BY camera,status").all();
        const recent=db.prepare("SELECT id,camera,name,kind,media,completed,status,verification,thumbnail FROM transfers WHERE status IN ('done','cleanup') AND kind NOT IN ('mp4','mov') ORDER BY completed DESC LIMIT 12").all();
        const free=await paths.free(settings.destination).catch(()=>null);
        const uptime=Date.now()-start;
        return json(res,200,{running:true,uptime,runtime:process.version,version:'0.1.0',rss:process.memoryUsage.rss(),free,counts,cameraCounts,recent,paused:settings.paused,
          cameras:cameras.map(({id,name,address,enabled,paused})=>({id,name,address,enabled,paused,...engine.states.get(id),status:!enabled?'disabled':paused||settings.paused?'paused':[...engine.active.values()].some(t=>t.camera===id)?'synchronizing':engine.states.get(id)?.status??'disconnected'})),
          active:[...engine.active.values()].map(item=>{
            const elapsed=Math.max(1,(Date.now()-item.started)/1000);
            const speed=item.bytes/elapsed;
            return {...item,elapsed,speed,remaining:item.size&&speed?Math.max(0,(item.size-item.bytes)/speed):null};
          })});
      }
      if (method==='GET' && path==='/api/settings') return json(res,200,{settings,events,bootstrap:{origin:bootstrap.origin,issuer:bootstrap.oidc.issuer},vapid:push.keys.publicKey,system:{database:'open',oidc:'authenticated',pushDevices:push.devices(session.subject).length}});
      if (method==='PUT' && path==='/api/settings') {
        const next=settingsSchema.parse(await body(req));
        await paths.check(next.destination);
        db.prepare("INSERT INTO settings VALUES ('general',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
        engine.wake();
        return json(res,200,next);
      }
      if (method==='GET' && path==='/api/cameras') return json(res,200,cameras);
      const cameraRoute=/^\/api\/cameras(?:\/([0-9a-f-]{36}))?(?:\/(test|estimate))?$/.exec(path);
      if (cameraRoute) {
        const [,id,action]=cameraRoute;
        const existing=cameras.find(camera=>camera.id===id);
        if (id&&!existing) throw new HttpError(404,'Camera configuration missing');
        if ((method==='POST'&&!id&&!action)||(method==='PUT'&&existing&&!action)) {
          if (!existing&&cameras.length>=32) throw new HttpError(400,'Camera limit reached');
          const config=cameraSchema.parse(await body(req));
          if (existing && config.serial!==existing.serial) throw new HttpError(400,'Register a replacement camera separately');
          if (cameras.some(c=>c.id!==id&&c.serial===config.serial)) throw new HttpError(409,'Camera serial already configured');
          const known=db.prepare('SELECT id FROM registry WHERE serial=?').get(config.serial) as {id:string}|undefined;
          const next={...config,id:id??known?.id??randomUUID(),created:existing?.created??Date.now()};
          if (next.destination) await paths.check(next.destination);
          await ctx.validateCamera(next);
          if (!id&&ctx.config().cameras.some(c=>c.serial===next.serial)) throw new HttpError(409,'Camera serial already configured');
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('INSERT OR IGNORE INTO registry VALUES (?,?)').run(next.serial,next.id);
            db.prepare("INSERT INTO cameras VALUES (?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config").run(next.id,JSON.stringify(next));
            db.exec('COMMIT');
          } catch (error) {db.exec('ROLLBACK');throw error;}
          engine.wake(next.id);
          return json(res,200,next);
        }
        if (method==='DELETE'&&existing&&!action) {
          db.prepare("UPDATE transfers SET status='cancelled' WHERE camera=? AND status='queued'").run(existing.id);
          db.prepare('DELETE FROM cameras WHERE id=?').run(existing.id);
          return json(res,200,{ok:true});
        }
        if (method==='POST'&&existing&&action) {
          const adapter=ctx.adapter(existing);
          const identity=await adapter.identify(AbortSignal.timeout(15000));
          const matches=identity.serial===existing.serial;
          if (action==='test') return json(res,200,{identity,matches});
          if (!matches) throw new HttpError(409,'Camera serial does not match');
          const signal=AbortSignal.timeout(25000);
          const result={files:0,bytes:0,unknown:0};
          for await (const media of adapter.list(signal)) {
            signal.throwIfAborted();
            const kind=media.name.split('.').at(-1)?.toLowerCase();
            if (!(existing.media??settings.media).some(type=>type===kind) ||
              (existing.mode==='new'&&!(Date.parse(media.captured??media.modified??'')>=existing.created))) continue;
            result.files++;
            if (Number.isSafeInteger(media.size) && media.size!>=0) result.bytes+=media.size!;
            else result.unknown++;
          }
          return json(res,200,result);
        }
      }
      if (path==='/api/directories'&&method==='GET') return json(res,200,await paths.browse(url.searchParams.get('path')??undefined));
      if (path==='/api/directories'&&method==='POST') {
        const input=z.object({path:z.string().max(4096),create:z.boolean().default(false)}).parse(await body(req));
        if (input.create) await paths.create(input.path);
        return json(res,200,{free:await paths.check(input.path)});
      }
      if (path==='/api/sync'&&method==='POST') {
        const input=z.object({camera:z.uuid().optional()}).parse(await body(req));
        engine.wake(input.camera);
        return json(res,202,{ok:true});
      }
      if (path==='/api/retry'&&method==='POST') {
        const input=z.object({id:z.uuid().optional()}).parse(await body(req));
        const sql="UPDATE transfers SET status='queued',attempts=0,retry=0,error=NULL WHERE status='failed' AND camera IN (SELECT id FROM cameras)";
        if (input.id) db.prepare(sql+' AND id=?').run(input.id); else db.prepare(sql).run();
        engine.wake();
        return json(res,202,{ok:true});
      }
      if (path==='/api/reimport'&&method==='POST') {
        const {id}=z.object({id:z.uuid()}).parse(await body(req));
        const next=randomUUID();
        const result=db.prepare(`INSERT INTO transfers(id,camera,name,kind,model,media,fingerprint,status,created,size)
          SELECT ?,camera,name,kind,model,json_set(media,'$.originalFingerprint',coalesce(json_extract(media,'$.originalFingerprint'),fingerprint)),?,'queued',?,size FROM transfers WHERE id=? AND status IN ('done','duplicate')
          AND camera IN (SELECT id FROM cameras)`).run(next,'manual:'+next,Date.now(),id);
        if (!result.changes) throw new HttpError(404,'No eligible transfer');
        engine.wake();
        return json(res,202,{id:next});
      }
      if (path==='/api/history'&&method==='GET') {
        const {where,args}=history(db,url);
        const offset=z.coerce.number().int().min(0).max(100000000).parse(url.searchParams.get('offset')??0);
        const items=db.prepare('SELECT * FROM transfers'+where+' ORDER BY created DESC,id DESC LIMIT 51 OFFSET ?').all(...args,offset);
        return json(res,200,{items:items.slice(0,50),more:items.length>50});
      }
      if (path==='/api/export'&&method==='GET') {
        const {where,args}=history(db,url);
        const format=url.searchParams.get('format')==='csv'?'csv':'json';
        const columns=['id','camera','model','name','kind','media','created','completed','size','hash','verification','status','destination','duration','attempts','error','thumbnail'];
        res.writeHead(200,{'Content-Type':format==='csv'?'text/csv':'application/json','Content-Disposition':'attachment; filename="transfers.'+format+'"'});
        res.write(format==='csv'?columns.join(',')+'\r\n':'[');
        let previous=0;
        // Page through small snapshots so slow clients cannot hold a SQLite cursor open.
        let cursor:{created:number;id:string}|undefined;
        const cutoff=Date.now();
        while (!res.destroyed) {
          const conditions=(where?where+' AND ':' WHERE ')+'created<=?'+(cursor?' AND (created,id)<(?,?)':'');
          const rows=db.prepare('SELECT * FROM transfers'+conditions+' ORDER BY created DESC,id DESC LIMIT 250')
            .all(...args,cutoff,...(cursor?[cursor.created,cursor.id]:[])) as Transfer[];
          if(!rows.length) break;
          const chunk=rows.map(row=>format==='csv'?columns.map(key=>csv(row[key as keyof Transfer])).join(',')+'\r\n':(previous++?',':'')+JSON.stringify(row)).join('');
          if(!res.write(chunk)) {
            await once(res,'drain',{signal:AbortSignal.timeout(15000)});
          }
          cursor=rows.at(-1);
        }
        res.end(format==='json'?']':'');
        return;
      }
      if (path==='/api/events'&&method==='GET') {
        const items=db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all();
        const delivery=db.prepare(`SELECT d.event,d.state,d.attempt,e.kind,e.time,v.id,v.config FROM deliveries d JOIN events e ON e.id=d.event
          JOIN devices v ON v.id=d.device WHERE v.subject=? ORDER BY e.id DESC LIMIT 100`).all(session.subject) as {config:string}[];
        return json(res,200,{items,delivery:delivery.map(({config,...item})=>({...item,device:JSON.parse(config).name}))});
      }
      if (path.startsWith('/api/thumbnail/')&&method==='GET') {
        const image=await previews.get(path.split('/').at(-1)!);
        if (!image) throw new HttpError(404,'Preview unavailable');
        res.writeHead(200,{'Content-Type':'image/jpeg'}).end(image);
        return;
      }
      if (path==='/api/devices'&&method==='GET') return json(res,200,push.devices(session.subject));
      if (path==='/api/devices'&&method==='PUT') return json(res,200,{id:push.register(session.subject,await body(req))});
      if (path.startsWith('/api/devices/')&&method==='DELETE') {
        push.remove(session.subject,path.split('/').at(-1)!);
        return json(res,200,{ok:true});
      }
      if (path==='/api/push-test'&&method==='POST') {
        if (db.prepare("SELECT 1 FROM deliveries d JOIN devices v ON d.device=v.id JOIN events e ON d.event=e.id WHERE v.subject=? AND e.kind='test' AND e.time>?").get(session.subject,Date.now()-60000)) throw new HttpError(429,'Wait a minute between test notifications');
        if (!push.devices(session.subject).length) throw new HttpError(400,'Register a device first');
        push.emit('test','','Web Push test submitted from Canon Photo Sync',session.subject);
        return json(res,202,{ok:true});
      }
      throw new HttpError(404,'Route unavailable');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpError) json(res,error.status,{error:error.message});
      else if (error instanceof z.ZodError) json(res,400,{error:error.issues.map(issue=>issue.path.join('.')+': '+issue.message).join('; ')});
      else if (error instanceof CameraBusy) json(res,503,{error:error.message});
      else if (error instanceof CameraProtocolError || error instanceof CameraUnavailable) json(res,422,{error:error.message});
      else json(res,400,{error:'Operation failed. Check the input, permissions, or connectivity.'});
    }
  });
  server.maxConnections=80;
  return server;
}

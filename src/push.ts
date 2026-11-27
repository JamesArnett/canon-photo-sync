import * as webpush from 'web-push';
import { z } from 'zod';
import { createHash, randomUUID, ECDH } from 'node:crypto';
import { open, readFile, lstat, link, unlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import type { Database } from './store.js';
import { preferences, type EventKind, type Settings } from './config.js';

const enabled = new Set<EventKind>(['completed','completedErrors','transferFailed','interrupted','stalled','nasSpace','destination','cameraError','applicationError']);
const urgent = new Set<EventKind>(['transferFailed','interrupted','stalled','nasSpace','destination','applicationError']);
export function allowedPush(endpoint: string) {
  const url = new URL(endpoint);
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
    (/^(?:[a-z0-9-]+\.)+push\.apple\.com$/.test(url.hostname) ||
    ['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','wns2-par02p.notify.windows.com'].includes(url.hostname));
}
const key = (length: number) => z.string().regex(/^[a-zA-Z0-9_-]+$/).refine(value => Buffer.from(value,'base64url').length===length);
export const deviceSchema = z.object({
  name:z.string().trim().min(1).max(80),
  subscription:z.object({endpoint:z.url().max(2048).refine(allowedPush),keys:z.object({auth:key(16),
    p256dh:key(65).refine(value=>{
      try { ECDH.convertKey(Buffer.from(value,'base64url'),'prime256v1'); return true; }
      catch { return false; }
    })})}),
  events:preferences.default({}),
  quiet:z.object({from:z.number().int().min(0).max(23),to:z.number().int().min(0).max(23),offset:z.number().int().min(-840).max(840),allowUrgent:z.boolean()}).optional()
});
type Device = z.infer<typeof deviceSchema>;
type Send = (subscription:Device['subscription'],payload:string, keys:webpush.VapidKeys) => Promise<number>;
export async function vapid(path: string): Promise<webpush.VapidKeys> {
  async function existing() {
    const info=await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) || info.uid!==process.getuid?.()) throw Error('VAPID file must be private');
    return z.object({publicKey:key(65),privateKey:key(32)}).parse(JSON.parse(await readFile(path,'utf8')));
  }
  try { return await existing(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const keys = webpush.generateVAPIDKeys();
  const staged=path+'.'+randomUUID()+'.partial';
  const file = await open(staged,'wx',0o600);
  try {
    try { await file.writeFile(JSON.stringify(keys)); await file.sync(); } finally { await file.close(); }
    try { await link(staged,path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code==='EEXIST') return await existing(); throw error; }
  } finally { await unlink(staged); }
  return keys;
}
export function sender(subject: string): Send {
  return async (subscription,payload,keys) => {
    if (!allowedPush(subscription.endpoint)) throw Error('Disallowed push provider');
    const details = webpush.generateRequestDetails(subscription,payload,{TTL:3600,vapidDetails:{subject,...keys}});
    const url = new URL(details.endpoint);
    const addresses = await lookup(url.hostname,{all:true});
    if (!addresses.length || addresses.some(entry => ipaddr.process(entry.address).range() !== 'unicast')) throw Error('Invalid push resolution');
    const pinned = addresses[0];
    return new Promise((resolve,reject) => {
      const req = request(url,{method:details.method, headers:details.headers, agent:false, family:pinned.family,
        signal:AbortSignal.timeout(10000),
        lookup:(_host,_options,callback)=>callback(null,pinned.address,pinned.family)},res=>{
        res.resume();
        resolve(res.statusCode ?? 500);
      });
      req.on('error',reject);
      req.end(details.body);
    });
  };
}
export class Push {
  private busy?: Promise<void>;
  private stopped = false;
  constructor(readonly db: Database, readonly keys: webpush.VapidKeys, private readonly send: Send,
    private readonly config: () => Settings, private readonly overrides: (id:string) => Partial<Record<EventKind,boolean>> = () => ({})) {}
  devices(subject:string) {
    return (this.db.prepare('SELECT id,config FROM devices WHERE subject=?').all(subject) as {id:string;config:string}[])
      .map(row => { const {name,events,quiet} = JSON.parse(row.config) as Device; return {id:row.id,name,events,quiet}; });
  }
  register(subject:string,input:unknown) {
    const device = deviceSchema.parse(input);
    const id = createHash('sha256').update(device.subscription.endpoint).digest('hex');
    const owner = this.db.prepare('SELECT subject FROM devices WHERE id=?').get(id) as {subject:string}|undefined;
    if (owner && owner.subject !== subject) throw Error('Subscription already registered');
    if (!owner && this.devices(subject).length >= 20) throw Error('Device limit reached');
    this.db.prepare('INSERT INTO devices VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(id,subject,JSON.stringify(device));
    return id;
  }
  remove(subject:string,id:string) {
    if (this.db.prepare('DELETE FROM devices WHERE subject=? AND id=?').run(subject,id).changes) this.db.prepare('DELETE FROM deliveries WHERE device=?').run(id);
  }
  emit(kind:EventKind|'test', camera:string, message:string, subject?:string, eventId?:string) {
    const now = Date.now();
    const settings = this.config();
    const recent = kind === 'test' || eventId ? undefined : this.db.prepare('SELECT 1 FROM events WHERE kind=? AND camera=? AND message=? AND time>? LIMIT 1').get(kind,camera,message,now-60000);
    if (recent) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (eventId && !this.db.prepare('INSERT OR IGNORE INTO event_keys VALUES (?,?)').run(eventId,now).changes) {
        this.db.exec('COMMIT');
        return;
      }
      const inserted = this.db.prepare('INSERT INTO events(time,camera,kind,message) VALUES (?,?,?,?) RETURNING id').get(now,camera,kind,message) as {id:number};
      if (kind === 'test' || (this.overrides(camera)[kind] ?? settings.notifications[kind] ?? enabled.has(kind))) {
        const devices = (subject ? this.db.prepare('SELECT id,config FROM devices WHERE subject=?').all(subject) :
          this.db.prepare('SELECT id,config FROM devices').all()) as {id:string;config:string}[];
        for (const row of devices) {
          const device = JSON.parse(row.config) as Device;
          if (kind !== 'test' && device.events[kind] === false) continue;
          this.db.prepare("INSERT INTO deliveries(event,device,state,due) VALUES (?,?,'queued',?)").run(inserted.id,row.id,now);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  tick() {
    if (!this.stopped && !this.busy) this.busy = this.deliver().catch(() => {}).finally(() => { this.busy = undefined; });
    return this.busy;
  }
  async stop() { this.stopped = true; await this.busy; }
  private async deliver() {
    const now = Date.now();
    const delivery = this.db.prepare(`SELECT d.*,e.kind,e.message,v.config,v.subject FROM deliveries d
      JOIN events e ON e.id=d.event JOIN devices v ON v.id=d.device
      WHERE d.state='queued' AND d.due<=? ORDER BY d.due LIMIT 1`).get(now) as
      {event:number;device:string;attempt:number;kind:EventKind|'test';message:string;config:string;subject:string}|undefined;
    if (!delivery) return;
    const device = JSON.parse(delivery.config) as Device;
    const quiet = device.quiet;
    if (quiet && delivery.kind !== 'test' && !(quiet.allowUrgent && urgent.has(delivery.kind))) {
      const hour = new Date(now+quiet.offset*60000).getUTCHours();
      const asleep = quiet.from < quiet.to ? hour >= quiet.from && hour < quiet.to : quiet.from > quiet.to && (hour >= quiet.from || hour < quiet.to);
      if (asleep) {
        this.db.prepare('UPDATE deliveries SET due=? WHERE event=? AND device=?').run(now+15*60000,delivery.event,delivery.device);
        return;
      }
    }
    const title = delivery.kind === 'completed' ? 'Photo synchronization complete' :
      delivery.kind === 'test' ? 'Canon Photo Sync test' : 'Canon Photo Sync update';
    const body = this.config().privatePush ? 'Open Canon Photo Sync for details.' : delivery.message;
    const status = await this.send(device.subscription,JSON.stringify({title,body,tag:'canon-'+delivery.event}),this.keys).catch(() => 503);
    if (status === 404 || status === 410) { this.remove(delivery.subject,delivery.device); return; }
    const state = status >= 200 && status < 300 ? 'submitted' :
      delivery.attempt >= 4 || (status >= 400 && status < 500 && status !== 429) ? 'failed' : 'queued';
    this.db.prepare('UPDATE deliveries SET state=?,attempt=attempt+1,due=? WHERE event=? AND device=?')
      .run(state,now+60000*2**delivery.attempt,delivery.event,delivery.device);
  }
}

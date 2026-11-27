import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CameraBusy, CameraProtocolError, type CameraAdapter, type Identity, type Media } from './camera.js';
import type { CameraConfig, EventKind, Settings } from './config.js';
import { ImportPaths, safeName } from './paths.js';
import type { Database } from './store.js';

export interface Transfer {
  id: string; camera: string; name: string; kind: string; model: string; media: string;
  fingerprint: string; status: string; attempts: number; retry: number; created: number;
  completed: number | null; duration: number | null; size: number | null; hash: string | null;
  verification: string | null; destination: string | null; partial: string | null;
  error: string | null; thumbnail: string | null;
}
interface CameraState {
  status: string; lastConnection?: number; lastSync?: number; identity?: Identity;
  manifest?: string;
  estimate?: { files: number; bytes: number; unknown: number };
  error?: string; next: number; failures: number; scanning?: boolean;
}
class IntegrityError extends Error {}
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const exists = async (path: string) => lstat(path).catch(error => {
  if (code(error) === 'ENOENT') return undefined;
  throw error;
});
const jitter = (delay: number) => Math.floor(delay * (0.8 + 0.4 * Math.random()));
function validMedia(media: Media) {
  if (!media || ![media.name,media.path,media.key,media.storage].every(value => typeof value==='string' && value.length>0 && value.length<=4096)) return false;
  return (media.size===undefined || (Number.isSafeInteger(media.size) && media.size>=0)) &&
    [media.captured,media.modified].every(timestamp=>timestamp===undefined ||
      (typeof timestamp==='string' && timestamp.length<=64 && Number.isFinite(Date.parse(timestamp)))) &&
    (media.sha256===undefined || (typeof media.sha256==='string' && /^[0-9a-f]{64}$/i.test(media.sha256)));
}
const hashString = (value: string) => createHash('sha256').update(value).digest('hex');

export class Engine {
  readonly states = new Map<string, CameraState>();
  readonly active = new Map<string, { camera: string; name: string; kind: string; size: number | null; bytes: number; started: number }>();
  readonly tasks = new Set<Promise<void>>();
  readonly shutdown = new AbortController();
  private timer?: NodeJS.Timeout;
  private publication = Promise.resolve();
  private readonly alerts = new Map<string, number>();
  constructor(readonly db: Database, readonly paths: ImportPaths,
    readonly config: () => {settings: Settings; cameras: CameraConfig[]},
    readonly adapter: (camera: CameraConfig) => CameraAdapter,
    readonly notify: (kind: EventKind, camera: string, message: string, eventId?: string) => void = () => {},
    readonly preview: (row: Transfer, adapter: CameraAdapter, media: Media, serial: string) => void = () => {},
    readonly cameraTransferLimit: (camera: CameraConfig) => number = camera => camera.concurrency) {}

  emit(kind: EventKind, camera: string, message: string, cooldown = 0, eventId?: string) {
    const key = camera + ':' + kind;
    if (cooldown && Date.now() - (this.alerts.get(key) ?? 0) < cooldown) return;
    this.alerts.set(key, Date.now());
    this.notify(kind, camera, message, eventId);
  }
  async recover() {
    for (;;) {
      const rows = this.db.prepare("SELECT * FROM transfers WHERE status IN ('downloading','publishing','cleanup') LIMIT 100").all() as Transfer[];
      if (!rows.length) return;
      for (const row of rows) {
        try {
          if (row.partial) await this.paths.directory(dirname(row.partial));
          if (row.destination) await this.paths.directory(dirname(row.destination));
          if (row.status === 'publishing' && row.destination && row.partial) {
            const partial = await exists(row.partial);
            const final = await exists(row.destination);
            if (partial && final && partial.isFile() && final.isFile() && final.ino === partial.ino && final.dev === partial.dev) {
              this.db.prepare("UPDATE transfers SET status='cleanup',completed=? WHERE id=?").run(Date.now(), row.id);
            } else if (!partial || final || partial.nlink > 1) {
              throw Error('Publication requires manual reconciliation');
            } else {
              // A link could have been published and subsequently moved across filesystems.
              throw Error('Publication requires manual reconciliation');
            }
          }
          if (row.partial) await unlink(row.partial).catch(error => { if (code(error) !== 'ENOENT') throw error; });
          this.db.prepare("UPDATE transfers SET status=CASE status WHEN 'cleanup' THEN 'done' ELSE 'queued' END,partial=NULL WHERE id=?").run(row.id);
        } catch {
          this.db.prepare("UPDATE transfers SET status=CASE status WHEN 'cleanup' THEN 'done' ELSE 'review' END, error=? WHERE id=?")
            .run('Inspect the staged and destination files before retrying', row.id);
        }
      }
    }
  }
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }
  async stop() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await Promise.allSettled([...this.tasks]);
  }
  wake(id?: string) {
    for (const [key, state] of this.states) if (!id || id === key) state.next = 0;
    this.tick();
  }
  track(action: Promise<void>) {
    const task = action.catch(() => this.emit('applicationError', '', 'A background operation failed', 60000));
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
  }
  tick() {
    if (this.shutdown.signal.aborted) return;
    const {settings, cameras} = this.config();
    const now = Date.now();
    if (settings.paused) return;
    const ids = new Set(cameras.map(c => c.id));
    for (const id of this.states.keys()) {
      if (ids.has(id)) continue;
      this.states.delete(id);
      this.db.prepare('DELETE FROM sightings WHERE camera=?').run(id);
    }
    for (const key of this.alerts.keys()) if (!key.startsWith(':') && !ids.has(key.split(':')[0])) this.alerts.delete(key);
    for (const camera of cameras.sort((a,b) => b.priority - a.priority)) {
      if (!camera.enabled || camera.paused) continue;
      let state = this.states.get(camera.id);
      if (!state) {
        const sync = this.db.prepare('SELECT completed FROM camera_sync WHERE camera=?').get(camera.id) as {completed:number}|undefined;
        state = {status:'disconnected',next:0,failures:0,lastSync:sync?.completed};
        this.states.set(camera.id,state);
      }
      const current = [...this.active.values()].filter(a => a.camera === camera.id);
      if (!current.length && !state.scanning && state.next <= now) {
        state.scanning = true;
        this.track(this.scan(camera, settings, state).finally(() => { state.scanning = false; }));
      }
      if (current.some(active => now - active.started > 30 * 60000 && !active.bytes)) {
        this.emit('stalled', camera.id, 'A transfer has made no progress', 3600000);
      }
      if (state.status !== 'connected' || state.scanning) continue;
      try { this.updateBatch(camera,settings,state,now); }
      catch { this.emit('applicationError',camera.id,'Could not persist batch status',60000); }
      const slots = Math.min(settings.concurrency - this.active.size, this.cameraTransferLimit(camera) - current.length);
      if (slots < 1) continue;
      const rows = this.db.prepare("SELECT * FROM transfers WHERE camera=? AND status='queued' AND retry<=? AND EXISTS (SELECT 1 FROM sightings WHERE sightings.camera=transfers.camera AND sightings.fingerprint=CASE WHEN transfers.fingerprint LIKE 'manual:%' THEN json_extract(transfers.media,'$.originalFingerprint') ELSE transfers.fingerprint END AND sightings.manifest=?) ORDER BY created LIMIT ?")
        .all(camera.id, now, state.manifest ?? '', slots) as Transfer[];
      for (const row of rows) this.track(this.transfer(row, camera, settings));
    }
  }
  private updateBatch(camera: CameraConfig, settings: Settings, state: CameraState, now: number) {
    let batch = this.db.prepare('SELECT id,started FROM batches WHERE camera=?').get(camera.id) as {id:string;started:number}|undefined;
    if (!batch) {
      if (!this.db.prepare("SELECT 1 FROM transfers WHERE camera=? AND status='queued' LIMIT 1").get(camera.id)) return;
      batch = {id:randomUUID(),started:now};
      this.db.prepare('INSERT INTO batches VALUES (?,?,?)').run(batch.id,camera.id,batch.started);
    }
    this.db.prepare(`INSERT OR IGNORE INTO batch_members SELECT ?,id FROM transfers
      WHERE camera=? AND status IN ('queued','downloading','publishing','cleanup')`).run(batch.id,camera.id);
    const summary = this.db.prepare(`SELECT
      coalesce(sum(status IN ('queued','downloading','publishing','cleanup')),0) AS pending,
      coalesce(sum(status IN ('failed','missing','review','cancelled')),0) AS failed,
      coalesce(sum(status='done'),0) AS files,
      coalesce(sum(CASE WHEN status='done' THEN size END),0) AS bytes,
      max(max(coalesce(completed,created),retry)) AS touched
      FROM batch_members JOIN transfers ON transfers.id=batch_members.transfer WHERE batch_members.batch=?`).get(batch.id) as
      {pending:number;failed:number;files:number;bytes:number;touched:number|null};
    if (summary.pending || now - (summary.touched ?? batch.started) < settings.batchSeconds * 1000) return;
    // The durable notification outbox deduplicates a completion if a restart occurs during batch cleanup.
    if (summary.files || summary.failed) this.emit(summary.failed ? 'completedErrors' : 'completed',camera.id,
      camera.name + ' · ' + summary.files + ' imported · ' + summary.bytes + ' bytes · ' + Math.ceil((now-batch.started)/1000) + ' s · ' + summary.failed + ' errors',0,batch.id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO camera_sync VALUES (?,?) ON CONFLICT(camera) DO UPDATE SET completed=excluded.completed').run(camera.id,now);
      this.db.prepare('DELETE FROM batch_members WHERE batch=?').run(batch.id);
      this.db.prepare('DELETE FROM batches WHERE id=?').run(batch.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    state.lastSync=now;
  }
  async scan(camera: CameraConfig, settings: Settings, state: CameraState) {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30 * 60000)]);
    try {
      const adapter = this.adapter(camera);
      const identity = await adapter.identify(AbortSignal.any([signal, AbortSignal.timeout(15000)]));
      if (typeof identity.model !== 'string' || !identity.model || identity.model.length>128) throw new CameraProtocolError('Invalid camera identity');
      if (identity.serial !== camera.serial) throw new CameraProtocolError('Camera serial does not match configured identity');
      const manifest = randomUUID();
      const estimate = {files:0,bytes:0,unknown:0};
      for await (const media of adapter.list(signal)) {
        signal.throwIfAborted();
        if (!validMedia(media)) throw new CameraProtocolError('Invalid camera media metadata');
        const kind = extname(media.name).slice(1).toLowerCase();
        if (!(camera.media ?? settings.media).some(type => type === kind)) continue;
        if (camera.mode === 'new' && !(Date.parse(media.captured ?? media.modified ?? '') >= camera.created)) continue;
        const fingerprint = hashString(JSON.stringify([identity.serial,media.storage,media.key,media.path,media.size,media.captured??media.modified,media.sha256]));
        const inserted = this.db.prepare(`INSERT OR IGNORE INTO transfers
          (id,camera,name,kind,model,media,fingerprint,status,created,size) VALUES (?,?,?,?,?,?,?,'queued',?,?)`)
          .run(randomUUID(),camera.id,media.name,kind,identity.model,JSON.stringify(media),fingerprint,Date.now(),media.size ?? null);
        this.db.prepare('INSERT INTO sightings VALUES (?,?,?) ON CONFLICT(camera,fingerprint) DO UPDATE SET manifest=excluded.manifest').run(camera.id,fingerprint,manifest);
        this.db.prepare("UPDATE transfers SET status='queued' WHERE camera=? AND fingerprint=? AND status IN ('missing','cancelled')").run(camera.id,fingerprint);
        if (inserted.changes) {
          estimate.files++; estimate.bytes += media.size ?? 0;
          if (media.size === undefined) estimate.unknown++;
        }
      }
      this.db.prepare('DELETE FROM sightings WHERE camera=? AND manifest<>?').run(camera.id,manifest);
      this.db.prepare(`UPDATE transfers SET status='queued' WHERE camera=? AND status='missing' AND fingerprint LIKE 'manual:%' AND EXISTS (
        SELECT 1 FROM sightings WHERE sightings.camera=transfers.camera AND sightings.fingerprint=json_extract(transfers.media,'$.originalFingerprint')
      )`).run(camera.id);
      this.db.prepare(`UPDATE transfers SET status='missing' WHERE camera=? AND status='queued' AND NOT EXISTS (
        SELECT 1 FROM sightings WHERE sightings.camera=transfers.camera AND sightings.fingerprint=CASE WHEN transfers.fingerprint LIKE 'manual:%' THEN json_extract(transfers.media,'$.originalFingerprint') ELSE transfers.fingerprint END
      )`).run(camera.id);
      if (state.status !== 'connected') this.emit('connected', camera.id, camera.name + ' connected');
      Object.assign(state, {status:'connected',manifest,identity,lastConnection:Date.now(),failures:0,error:undefined,next:Date.now()+jitter((camera.poll ?? settings.poll)*1000)});
      if (estimate.files || !state.estimate) state.estimate = estimate;
      if (identity.battery !== undefined && identity.battery <= settings.batteryThreshold) this.emit('lowBattery', camera.id, camera.name + ' battery is low', 3600000);
      if (identity.free !== undefined && identity.free < settings.cameraMinimumBytes) this.emit('cameraSpace', camera.id, camera.name + ' storage is low', 3600000);
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      if (error instanceof CameraBusy) {
        Object.assign(state,{status:'busy',error:undefined,next:Date.now()+jitter((camera.poll??settings.poll)*1000)});
        return;
      }
      if (state.status === 'connected') this.emit('disconnected', camera.id, camera.name + ' disconnected');
      const protocol = error instanceof CameraProtocolError;
      if (protocol) this.emit('cameraError', camera.id, error.message, 3600000);
      state.error = protocol ? error.message : undefined;
      state.status = protocol ? 'error' : 'disconnected';
      state.failures++;
      state.next = Date.now() + jitter(Math.min(900000, (camera.poll ?? settings.poll)*1000 * 2 ** Math.min(state.failures-1, 10)));
    }
  }
  async transfer(row: Transfer, camera: CameraConfig, settings: Settings) {
    const started = Date.now();
    const progress = { camera: camera.id, name: row.name, kind: row.kind, size:row.size, bytes:0, started };
    this.active.set(row.id, progress);
    let partial: string | undefined;
    let publishing = false;
    let destinationError = true;
    let releasePublication: (() => void) | undefined;
    try {
      this.db.prepare("UPDATE transfers SET status='downloading', attempts=attempts+1,error=NULL WHERE id=?").run(row.id);
      const media = JSON.parse(row.media) as Media;
      const base = await this.paths.directory(camera.destination ?? settings.destination);
      const layout = camera.layout ?? settings.layout;
      const timestamp = Date.parse(media.captured ?? media.modified ?? '');
      const date = new Date(Number.isFinite(timestamp) ? timestamp : row.created).toISOString().slice(0,10);
      const segments = layout === 'camera-date' ? [safeName(camera.name),date] : layout === 'camera' ? [safeName(camera.name)] : layout === 'date' ? [date] : [];
      let directory = base;
      for (const segment of segments) {
        directory = join(directory,segment);
        await mkdir(directory,{mode:0o750}).catch(error => { if (code(error) !== 'EEXIST') throw error; });
        await this.paths.directory(directory);
      }
      if (await this.paths.free(directory) < settings.minimumBytes + (row.size ?? 0)) {
        this.emit('nasSpace', camera.id, 'Destination storage is below its reserve', 3600000);
        throw Error('Insufficient destination space');
      }
      partial = join(directory,'.canon-' + row.id + '.partial');
      this.db.prepare('UPDATE transfers SET partial=? WHERE id=?').run(partial,row.id);
      destinationError = false;
      const adapter = this.adapter(camera);
      const signal = this.shutdown.signal;
      if ((await adapter.identify(AbortSignal.any([signal,AbortSignal.timeout(15000)]))).serial !== camera.serial) throw new CameraProtocolError('Camera identity changed before download');
      const source = await adapter.open(media,signal);
      const hash = createHash('sha256');
      let nextSpaceCheck = 64 * 1024 ** 2;
      const paths = this.paths;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          progress.bytes += chunk.length;
          if (row.size !== null && progress.bytes > row.size) { callback(new IntegrityError('Source exceeded advertised size')); return; }
          hash.update(chunk);
          if (progress.bytes < nextSpaceCheck) { callback(null,chunk); return; }
          nextSpaceCheck = progress.bytes + 64 * 1024 ** 2;
          void paths.free(directory).then(free => callback(free < settings.minimumBytes ? Object.assign(Error('Disk reserve exhausted'),{code:'ENOSPC'}) : null,chunk), callback);
        }
      });
      await pipeline(source,meter,createWriteStream(partial,{flags:'wx',mode:0o640}),{signal});
      if (row.size !== null && progress.bytes !== row.size) throw new IntegrityError('Download size did not match the source listing');
      const digest = hash.digest('hex');
      if (media.sha256 && digest !== media.sha256.toLowerCase()) throw new IntegrityError('Download SHA-256 did not match the source checksum');
      const verification = media.sha256 ? 'source-sha256' : row.size !== null ? 'source-size' : 'local-hash';
      // Serialize checksum lookup and publication so concurrent card copies cannot both win.
      const previous = this.publication;
      this.publication = new Promise<void>(resolve => { releasePublication = resolve; });
      await previous;
      const existing = this.db.prepare("SELECT destination FROM transfers WHERE camera=? AND hash=? AND status IN ('done','cleanup','duplicate') LIMIT 1")
        .get(camera.id,digest) as { destination: string } | undefined;
      if (existing && !row.fingerprint.startsWith('manual:')) {
        await unlink(partial);
        this.db.prepare("UPDATE transfers SET status='duplicate',hash=?,verification=?,size=?,duration=?,completed=?,destination=?,partial=NULL WHERE id=?")
          .run(digest,verification,progress.bytes,Date.now()-started,Date.now(),existing.destination,row.id);
        return;
      }
      destinationError = true;
      const file = await open(partial,'r+');
      try { await file.sync(); } finally { await file.close(); }
      await this.paths.directory(directory);
      const sourceExtension = extname(row.name);
      const name = safeName(row.name.slice(0,row.name.length - sourceExtension.length)) + sourceExtension;
      const suffix = extname(name);
      const original = join(directory,name);
      for (let collision = 0; ; collision++) {
        const target = collision ? join(directory,name.slice(0,name.length-suffix.length)+'-'+row.id+(collision > 1 ? '-'+collision : '')+suffix) : original;
        this.db.prepare("UPDATE transfers SET status='publishing',destination=?,hash=?,verification=?,size=?,duration=? WHERE id=?")
          .run(target,digest,verification,progress.bytes,Date.now()-started,row.id);
        publishing = true;
        try { await link(partial,target); }
        catch (error) {
          if (code(error) === 'EEXIST') { publishing = false; continue; }
          throw error;
        }
        const folder = await open(directory,'r');
        try { await folder.sync(); } finally { await folder.close(); }
        this.db.prepare("UPDATE transfers SET status='cleanup',completed=? WHERE id=?").run(Date.now(),row.id);
        await unlink(partial);
        this.db.prepare("UPDATE transfers SET status='done',partial=NULL WHERE id=?").run(row.id);
        this.preview({...row,destination:target},adapter,media,camera.serial);
        break;
      }
    } catch (error) {
      if (publishing) {
        this.db.prepare("UPDATE transfers SET status=CASE status WHEN 'cleanup' THEN 'done' ELSE 'review' END,error=? WHERE id=?")
          .run('Inspect publication state and staged file',row.id);
        this.emit('applicationError',camera.id,'An import requires publication review');
        return;
      }
      if (partial) await unlink(partial).catch(() => {});
      if (error instanceof CameraBusy && !this.shutdown.signal.aborted) {
        this.db.prepare("UPDATE transfers SET status='queued',attempts=attempts-1,retry=?,error=NULL,partial=NULL WHERE id=?")
          .run(Date.now()+jitter(10000),row.id);
        return;
      }
      const stopped = this.shutdown.signal.aborted;
      const exhausted = !stopped && row.attempts >= settings.retries;
      const disk = ['ENOSPC','EDQUOT','EACCES','EPERM','EROFS'].includes(code(error) ?? '');
      const message = stopped ? 'Service stopped' : disk || destinationError ? 'Destination unavailable or low on space' :
        error instanceof CameraProtocolError || error instanceof IntegrityError ? error.message : 'Camera transfer interrupted';
      this.db.prepare('UPDATE transfers SET status=?,attempts=attempts-?,retry=?,error=?,partial=NULL WHERE id=?')
        .run(exhausted?'failed':'queued',stopped?1:0,exhausted?0:Date.now()+jitter(Math.min(900000,5000*2**row.attempts)),message,row.id);
      if (exhausted) this.emit('transferFailed',camera.id,message,60000);
      if (disk || destinationError) this.emit('destination',camera.id,message,3600000);
      else if (!stopped && !(error instanceof IntegrityError)) {
        const state = this.states.get(camera.id);
        if (state) {
          state.status=error instanceof CameraProtocolError?'error':'disconnected';
          state.error=error instanceof CameraProtocolError?error.message:undefined;
          state.next=Date.now()+5000;
        }
        this.emit(error instanceof CameraProtocolError?'cameraError':'interrupted',camera.id,message,60000);
      }
    } finally {
      releasePublication?.();
      this.active.delete(row.id);
    }
  }
}

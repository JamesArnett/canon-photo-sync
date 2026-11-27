import { mkdir, readdir, stat, unlink, writeFile, readFile, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transfer } from './engine.js';
import type { CameraAdapter, Media } from './camera.js';
import { constants } from 'node:fs';
import type { Database } from './store.js';

function jpegDimensions(bytes: Uint8Array) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return;
  for (let offset=2;offset+9<bytes.length;) {
    if (bytes[offset++]!==255) return;
    while (bytes[offset]===255) offset++;
    const marker=bytes[offset++];
    if (marker===0xda || marker===0xd9) return;
    const length=bytes[offset]*256+bytes[offset+1];
    if (length<2 || offset+length>bytes.length) return;
    if ([0xc0,0xc1,0xc2].includes(marker) && length>=8) {
      return {height:bytes[offset+3]*256+bytes[offset+4],width:bytes[offset+5]*256+bytes[offset+6]};
    }
    offset+=length;
  }
}
async function smallOriginal(path: string) {
  if (await realpath(path)!==path) return;
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info=await file.stat();
    if (!info.isFile() || info.size>128000) return;
    const buffer=Buffer.alloc(info.size);
    if ((await file.read(buffer,0,buffer.length,0)).bytesRead!==buffer.length) return;
    const dimensions=jpegDimensions(buffer);
    if (dimensions && dimensions.width<=320 && dimensions.height<=320) return buffer;
  } finally { await file.close(); }
}

export class Previews {
  private readonly jobs: (() => Promise<void>)[] = [];
  private running?: Promise<void>;
  constructor(readonly db: Database, readonly directory: string, private readonly limit: () => number) {}
  async initialize() { await mkdir(this.directory,{recursive:true,mode:0o700}); await this.trim(); }
  schedule(row: Transfer, adapter: CameraAdapter, media: Media, serial: string) {
    if (this.jobs.length >= 24 || !this.limit() || ['mp4','mov'].includes(row.kind)) return;
    this.jobs.push(async () => {
      const signal=AbortSignal.timeout(10000);
      let bytes: Uint8Array|undefined;
      if (adapter.thumbnail) {
        try {
          if ((await adapter.identify(signal)).serial===serial) bytes=await adapter.thumbnail(media,signal);
        } catch {}
      }
      if (!bytes && row.destination && ['jpg','jpeg'].includes(row.kind)) bytes=await smallOriginal(row.destination);
      if (!bytes || bytes.length > Math.min(512000,this.limit())) return;
      const dimensions=jpegDimensions(bytes);
      if (!dimensions || !dimensions.width || !dimensions.height || dimensions.width>640 || dimensions.height>640) return;
      await writeFile(join(this.directory,row.id+'.jpg'),bytes,{flag:'wx',mode:0o600});
      this.db.prepare('UPDATE transfers SET thumbnail=? WHERE id=?').run(row.id,row.id);
      await this.trim();
    });
    this.run();
  }
  private run() {
    if (this.running) return;
    const job = this.jobs.shift();
    if (job) this.running = job().catch(() => {}).finally(() => { this.running = undefined; this.run(); });
  }
  async stop() { this.jobs.length=0; await this.running; }
  async trim() {
    const entries = await Promise.all((await readdir(this.directory)).filter(name=>/^[0-9a-f-]{36}\.jpg$/.test(name)).map(async name=>{
      const path = join(this.directory,name);
      const entry = await stat(path).catch(()=>undefined);
      return {name,path,size:entry?.size ?? 0,mtime:entry?.mtimeMs ?? 0};
    }));
    let size = entries.reduce((sum,entry)=>sum+entry.size,0);
    for (const entry of entries.sort((a,b)=>a.mtime-b.mtime)) {
      if (size <= this.limit()) break;
      await unlink(entry.path).catch(()=>{});
      this.db.prepare('UPDATE transfers SET thumbnail=NULL WHERE thumbnail=?').run(entry.name.slice(0,-4));
      size -= entry.size;
    }
  }
  async get(id:string) {
    if (!/^[0-9a-f-]{36}$/.test(id) || !this.db.prepare("SELECT 1 FROM transfers WHERE id=? AND thumbnail=? AND status IN ('done','cleanup')").get(id,id)) return;
    return readFile(join(this.directory,id+'.jpg')).catch(()=>undefined);
  }
}

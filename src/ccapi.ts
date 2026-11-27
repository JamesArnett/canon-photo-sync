import type { CameraAdapter, Identity, Media } from './camera.js';
import type { CameraConfig } from './config.js';
import { CameraBusy, CameraProtocolError } from './camera.js';
import { CameraHttpError, CameraUnavailable, type CameraTransport } from './transport.js';

// Canon CCAPI 1.4.0 reference, revision 1.6, §§4.3, 4.4, 4.7 and 6.3.17.
export type CCAPIFactory = (camera: Readonly<CameraConfig>, transport: CameraTransport) => CameraAdapter;
const contents='/ccapi/ver120/contents';
const mediaType=/\.(?:jpe?g|cr3|hif|heif|heic|mp4|mov)$/i;
const movieType=/\.(?:mp4|mov)$/i;
type Api = Pick<CameraTransport,'base'|'json'|'get'>;
type Details={size:number;modified?:string};

function object(value:unknown): Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new CameraProtocolError('Invalid Canon CCAPI response');
  return value as Record<string,unknown>;
}
function list(value:unknown,field:string,limit:number): unknown[] {
  const entries=object(value)[field];
  if(!Array.isArray(entries) || entries.length>limit) throw new CameraProtocolError('Invalid Canon CCAPI list');
  return entries;
}
function unsigned(value:unknown):value is number {
  return typeof value==='number' && Number.isSafeInteger(value) && value>=0;
}
function offsetAt(formatter:Intl.DateTimeFormat,timestamp:number) {
  const name=formatter.formatToParts(timestamp).find(part=>part.type==='timeZoneName')?.value;
  if(name==='GMT') return 0;
  const offset=name?.match(/^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(offset) return (offset[1]==='-'?-1:1)*(Number(offset[2])*3600+Number(offset[3])*60+Number(offset[4]??0))*1000;
}
function date(value:unknown,formatter?:Intl.DateTimeFormat) {
  if(typeof value!=='string' || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2}(?: GMT)?$/.test(value)) return;
  const zoned=value.endsWith(' GMT');
  const wallClock=zoned?value:value+' GMT';
  const wall=Date.parse(wallClock);
  if(!Number.isFinite(wall)) return;
  if(zoned) return new Date(wall).toISOString();
  if(!formatter || new Date(wall).toUTCString()!==wallClock) return;

  // Probe both sides of a transition and accept only a unique matching instant.
  const day=24*60*60*1000;
  const offsets=new Set([wall-day,wall,wall+day].map(probe=>offsetAt(formatter,probe)));
  const matches:number[]=[];
  for(const offset of offsets) {
    if(offset!==undefined && offsetAt(formatter,wall-offset)===offset) matches.push(wall-offset);
  }
  if(matches.length===1) return new Date(matches[0]).toISOString();
}

export class CanonR6MarkII implements CameraAdapter {
  private identity?:Identity;
  private readonly timeZoneFormatter?:Intl.DateTimeFormat;
  constructor(private readonly camera:Readonly<CameraConfig>,private readonly api:Api) {
    if(camera.timeZone) this.timeZoneFormatter=new Intl.DateTimeFormat('en',{timeZone:camera.timeZone,timeZoneName:'longOffset'});
  }
  async identify(signal:AbortSignal) {
    this.identity=undefined;
    const result=object(await this.api.json('/ccapi/ver100/deviceinformation',signal));
    const {serialnumber:serial,productname:model}=result;
    if(typeof serial!=='string' || !serial || serial.length>128 || typeof model!=='string' ||
      !/^(?:Canon )?EOS R6(?: Mark II|m2)$/i.test(model.trim())) throw new CameraProtocolError('Expected Canon EOS R6 Mark II identity');
    return this.identity={serial,model};
  }
  private async verify(signal:AbortSignal) {
    const identity=this.identity??await this.identify(signal);
    if(identity.serial!==this.camera.serial) throw new CameraProtocolError('Camera serial does not match configured identity');
    return identity;
  }
  private child(value:unknown,parent:string) {
    if(typeof value!=='string' || value.length>4096 || /[\\?#\x00-\x1f\x7f]/.test(value) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)) throw new CameraProtocolError('Invalid Canon CCAPI content path');
    const url=new URL(value,this.api.base);
    if(url.origin!==this.api.base.origin || url.username || url.password ||
      !url.pathname.startsWith(parent+'/')) throw new CameraProtocolError('Invalid Canon CCAPI content path');
    const tail=url.pathname.slice(parent.length+1);
    let name:string;
    try { name=decodeURIComponent(tail); } catch { throw new CameraProtocolError('Invalid Canon CCAPI content path'); }
    if(!name || name==='.' || name==='..' || /[/\\\x00-\x1f\x7f]/.test(name)) throw new CameraProtocolError('Invalid Canon CCAPI content path');
    return {path:parent+'/'+encodeURIComponent(name),name};
  }
  private file(media:Media) {
    const storage=this.child(contents+'/'+encodeURIComponent(media.storage),contents);
    const directory=this.child(media.path.slice(0,media.path.lastIndexOf('/')),storage.path);
    const file=this.child(media.path,directory.path);
    if(file.name!==media.name || file.path!==media.key || !mediaType.test(file.name)) throw new CameraProtocolError('Invalid Canon CCAPI media record');
    return file.path;
  }
  private async details(path:string,signal:AbortSignal):Promise<Details> {
    const result=object(await this.api.json(path+'?kind=info',signal));
    if(!unsigned(result.filesize)) throw new CameraProtocolError('Invalid Canon CCAPI file size');
    return {size:result.filesize,modified:date(result.lastmodifieddate,this.timeZoneFormatter)};
  }
  private async metrics(signal:AbortSignal,identity:Identity) {
    const collect=async<T>(path:string,field:string,map:(rows:unknown[])=>T) => {
      try { return map(list(await this.api.json(path,signal),field,8)); }
      catch(error) {
        signal.throwIfAborted();
        if(!(error instanceof CameraProtocolError || error instanceof CameraBusy || error instanceof CameraUnavailable)) throw error;
      }
    };
    identity.free=await collect('/ccapi/ver110/devicestatus/storage','storagelist',rows=>{
      const sizes=rows.map(row=>object(row).spacesize);
      if(sizes.length && sizes.every(unsigned)) {
        const total=sizes.reduce((sum,size)=>sum+size,0);
        if(unsigned(total)) return total;
      }
    });
    identity.battery=await collect('/ccapi/ver110/devicestatus/batterylist','batterylist',rows=>{
      const levels=rows.map(object).filter(row=>row.kind==='battery' &&
        typeof row.level==='string' && /^(?:100|[0-9]{1,2})$/.test(row.level)).map(row=>Number(row.level));
      if(levels.length) return Math.min(...levels);
    });
  }
  async *list(signal:AbortSignal) {
    const identity=await this.verify(signal);
    const cards=list(await this.api.json(contents,signal),'path',8).map(entry=>this.child(entry,contents));
    const preferCardOne=this.camera.cardRecording==='duplicate-stills' &&
      cards.some(card=>card.name==='card1') && cards.some(card=>card.name==='card2');
    const primaryStills=preferCardOne ? new Set<string>() : undefined;
    if(preferCardOne) cards.sort((a,b)=>Number(b.name==='card1')-Number(a.name==='card1'));
    for(const card of cards) {
      const directories=list(await this.api.json(card.path,signal),'path',10000);
      for(const entry of directories) {
        const directory=this.child(entry,card.path);
        const counts=object(await this.api.json(directory.path+'?kind=number',signal));
        if(!unsigned(counts.pagenumber) || counts.pagenumber>10000 || !unsigned(counts.contentsnumber) ||
          (counts.contentsnumber>0 && counts.pagenumber!==Math.ceil(counts.contentsnumber/100))) throw new CameraProtocolError('Invalid Canon CCAPI page count');
        let seen=0;
        for(let page=1;page<=counts.pagenumber;page++) {
          const files=list(await this.api.json(directory.path+'?kind=list&page='+page,signal),'path',100);
          seen+=files.length;
          for(const entry of files) {
            signal.throwIfAborted();
            const file=this.child(entry,directory.path);
            if(!mediaType.test(file.name)) continue;
            const stillPath=primaryStills && !movieType.test(file.name) ? file.path.slice(card.path.length) : undefined;
            if(card.name==='card2' && stillPath && primaryStills?.has(stillPath)) continue;
            const details=await this.details(file.path,signal);
            if(card.name==='card1' && stillPath && details.size>0) primaryStills?.add(stillPath);
            yield {key:file.path,path:file.path,storage:card.name,name:file.name,...details};
          }
        }
        if(seen!==counts.contentsnumber) throw new CameraBusy('Camera library changed during enumeration');
      }
    }
    await this.metrics(signal,identity);
  }
  async open(media:Media,signal:AbortSignal) {
    await this.verify(signal);
    const path=this.file(media);
    const current=await this.details(path,signal);
    if(media.size!==current.size || media.modified!==current.modified) throw new CameraProtocolError('Camera file changed since enumeration');
    const response=await this.api.get(path+'?kind=main',signal);
    const type=response.headers['content-type']?.split(';')[0].trim().toLowerCase();
    const length=response.headers['content-length'];
    if(!type || !['image/jpeg','image/heif','video/mp4','video/quicktime','application/octet-stream'].includes(type) ||
      (length!==undefined && Number(length)!==current.size)) {
      response.destroy();
      throw new CameraProtocolError('Unexpected Canon CCAPI original response');
    }
    return response;
  }
  async thumbnail(media:Media,signal:AbortSignal) {
    await this.verify(signal);
    try {
      const response=await this.api.get(this.file(media)+'?kind=thumbnail',signal);
      if(response.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='image/jpeg') {
        response.destroy();
        return;
      }
      const chunks:Buffer[]=[];
      let total=0;
      for await(const part of response) {
        total+=part.length;
        if(total>512000) return;
        chunks.push(part);
      }
      return Buffer.concat(chunks,total);
    } catch(error) {
      if(!(error instanceof CameraHttpError && [400,404].includes(error.status))) throw error;
    }
  }
}

export const canonCCAPI:CCAPIFactory=(camera,transport)=>new CanonR6MarkII(camera,transport);

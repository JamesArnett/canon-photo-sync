import { createHash, randomBytes } from 'node:crypto';
import { CameraProtocolError } from './camera.js';

type Challenge = {realm:string;nonce:string;opaque?:string};
const md5 = (value:string) => createHash('md5').update(value).digest('hex');
const quote = (value:string) => '"' + value.replace(/["\\]/g,'\\$&') + '"';

export class CameraDigest {
  private challenge?: Challenge;
  private count=0;
  constructor(private readonly username:string,private readonly password:string) {}
  accept(header:string|undefined) {
    const value=header?.match(/^Digest\s+(.+)$/i)?.[1];
    const fields=new Map<string,string>();
    const parameter=/\s*([a-z][a-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))\s*(?:,|$)/iy;
    let position=0;
    while(value && position<value.length) {
      parameter.lastIndex=position;
      const item=parameter.exec(value);
      if(!item || fields.has(item[1].toLowerCase())) throw new CameraProtocolError('Invalid camera Digest challenge');
      fields.set(item[1].toLowerCase(),item[2]?.replace(/\\(.)/g,'$1')??item[3]);
      position=parameter.lastIndex;
    }
    const realm=fields.get('realm');
    const nonce=fields.get('nonce');
    const opaque=fields.get('opaque');
    if(realm!=='CameraControlApi' || !nonce || !/^[\x20-\x7e]+$/.test(nonce) ||
      (opaque!==undefined && !/^[\x20-\x7e]*$/.test(opaque)) ||
      (fields.get('algorithm')??'MD5').toUpperCase()!=='MD5' ||
      !fields.get('qop')?.split(',').some(part=>part.trim()==='auth')) throw new CameraProtocolError('Unsupported camera Digest challenge');
    if(this.challenge?.nonce!==nonce) this.count=0;
    this.challenge={realm,nonce,opaque};
  }
  authorization(url:URL) {
    if(!this.challenge) return;
    const {realm,nonce,opaque}=this.challenge;
    const uri=url.pathname+url.search;
    const count=(++this.count).toString(16).padStart(8,'0');
    const random=randomBytes(16).toString('hex');
    const response=md5([md5(this.username+':'+realm+':'+this.password),nonce,count,random,'auth',md5('GET:'+uri)].join(':'));
    const fields=[
      'username='+quote(this.username),'realm='+quote(realm),'nonce='+quote(nonce),'uri='+quote(uri),
      'algorithm=MD5','qop=auth','nc='+count,'cnonce='+quote(random),'response='+quote(response)
    ];
    if(opaque!==undefined) fields.push('opaque='+quote(opaque));
    return 'Digest '+fields.join(', ');
  }
}

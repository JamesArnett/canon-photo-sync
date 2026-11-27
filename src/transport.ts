import { lookup } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { IncomingMessage } from 'node:http';
import ipaddr from 'ipaddr.js';
import { CameraBusy, CameraProtocolError } from './camera.js';
import { CameraDigest } from './digest.js';

export { CameraProtocolError } from './camera.js';

export class CameraUnavailable extends Error {}
export class CameraHttpError extends CameraProtocolError {
  constructor(readonly status:number) { super('Camera returned HTTP '+status); }
}
type Credential = {ca?:string;authorization?:string;digest?:{username:string;password:string}};
export class CameraTransport {
  private readonly networks;
  private readonly digest?: CameraDigest;
  constructor(readonly base: URL, networks: string[], private readonly secret?: Credential) {
    this.networks = networks.map(cidr => ipaddr.parseCIDR(cidr));
    if (base.protocol === 'http:' && (secret?.authorization || secret?.digest)) throw new CameraProtocolError('Camera credentials require HTTPS');
    if (secret?.digest) this.digest=new CameraDigest(secret.digest.username,secret.digest.password);
  }
  async approve() {
    const host = this.base.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(host, { all: true }).catch(() => { throw new CameraUnavailable('Camera DNS unavailable'); });
    const allowed = (ip: string) => {
      const address = ipaddr.process(ip);
      return ['private','uniqueLocal','carrierGradeNat'].includes(address.range()) &&
        this.networks.some(([network, bits]) => address.kind() === network.kind() &&
          (address as ipaddr.IPv4).match(network as ipaddr.IPv4, bits));
    };
    if (!addresses.length || addresses.some(entry => !allowed(entry.address))) {
      throw new CameraProtocolError('Camera DNS resolved outside approved local networks');
    }
    return addresses[0];
  }
  async get(path: string, signal: AbortSignal): Promise<IncomingMessage> {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || url.username || url.password || url.hash) throw new CameraProtocolError('Invalid camera link');
    const pinned = await this.approve();
    signal.throwIfAborted();
    let response = await this.request(url,pinned,signal);
    if (response.statusCode===401 && this.digest) {
      const challenge=response.headers['www-authenticate'];
      response.destroy();
      this.digest.accept(challenge);
      response=await this.request(url,pinned,signal);
    }
    const status=response.statusCode??0;
    if (status!==200 || (response.headers['content-encoding'] && response.headers['content-encoding']!=='identity')) {
      response.destroy();
      if (status===503) throw new CameraBusy('Camera is temporarily busy');
      if (status===401) throw new CameraProtocolError('Camera authentication failed. Check the HTTPS Digest profile.');
      if (status===200) throw new CameraProtocolError('Unexpected camera response encoding');
      throw new CameraHttpError(status);
    }
    return response;
  }
  private request(url:URL,pinned:Awaited<ReturnType<CameraTransport['approve']>>,signal:AbortSignal) {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const get = url.protocol === 'https:' ? httpsGet : httpGet;
      const authorization=this.digest?.authorization(url) ?? this.secret?.authorization;
      const request = get(url, {
        agent: false, signal, ca: this.secret?.ca, family: pinned.family,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { 'Accept-Encoding': 'identity', ...(authorization ? {Authorization:authorization} : {}) }
      }, resolve);
      request.setTimeout(15000, () => request.destroy(new CameraUnavailable('Camera request timed out')));
      request.on('error', error => {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        reject(/CERT|TLS|SSL|SELF_SIGNED/.test(code) ? new CameraProtocolError('Camera certificate validation failed') : new CameraUnavailable('Camera connection unavailable'));
      });
    });
  }
  async json(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.get(path, signal);
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 2 ** 20) throw new CameraProtocolError('Camera metadata exceeds response limit');
      buffers.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(buffers).toString()); }
    catch { throw new CameraProtocolError('Invalid camera JSON'); }
  }
}

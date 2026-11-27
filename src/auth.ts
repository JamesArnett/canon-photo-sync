import * as oidc from 'openid-client';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Bootstrap } from './config.js';

export const token = () => randomBytes(32).toString('base64url');
export const equal = (a: string, b: string) => a.length === b.length && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
type Session = { subject: string; csrf: string; expires: number };
type Flow = { state: string; nonce: string; verifier?: string; expires: number };
const prefix = '__Host-canon-';
function cookie(req: IncomingMessage, key: string) {
  return req.headers.cookie?.split(/;\s*/).find(value => value.startsWith(prefix+key+'='))?.slice((prefix+key+'=').length) ?? '';
}
function set(res: ServerResponse, key: string, value: string, seconds: number) {
  res.setHeader('Set-Cookie', prefix+key+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+seconds);
}
function redirect(res: ServerResponse, url: string) {
  res.writeHead(303,{Location:url}).end();
}
export function authorized(options: Bootstrap['oidc'], claims: Record<string, unknown>) {
  const groups = claims[options.groupsClaim];
  return typeof claims.sub === 'string' && (options.subjects.includes(claims.sub) ||
    (Array.isArray(groups) && groups.some(group => typeof group === 'string' && options.groups.includes(group))));
}

export class Auth {
  private configuration?: Promise<oidc.Configuration>;
  private readonly sessions = new Map<string, Session>();
  private readonly flows = new Map<string, Flow>();
  constructor(readonly bootstrap: Bootstrap, private readonly secret: string,
    private readonly fixtureConfig?: oidc.Configuration) {}
  async config() {
    if (this.fixtureConfig) return this.fixtureConfig;
    if (!this.configuration) {
      const options = this.bootstrap.oidc;
      this.configuration = oidc.discovery(
        new URL(options.discovery ?? options.issuer), options.clientId,
        {client_secret:this.secret},options.clientAuth==='client_secret_basic' ? oidc.ClientSecretBasic(this.secret) : oidc.ClientSecretPost(this.secret),{
          execute:[oidc.enableNonRepudiationChecks],
          [oidc.customFetch]: (url, init) => fetch(url,{...init,body:init.body instanceof Uint8Array ? Buffer.from(init.body) : init.body,redirect:'error',signal:AbortSignal.any([init?.signal ?? new AbortController().signal,AbortSignal.timeout(10000)])})
        }).then(config => {
          const metadata = config.serverMetadata();
          if (metadata.issuer !== options.issuer || !metadata.jwks_uri || !metadata.authorization_endpoint || !metadata.token_endpoint ||
            [metadata.jwks_uri,metadata.authorization_endpoint,metadata.token_endpoint,metadata.end_session_endpoint].some(url => url && new URL(url).protocol !== 'https:')) throw Error('OIDC discovery metadata mismatch');
          return config;
        }).catch(error => { this.configuration = undefined; throw error; });
    }
    return this.configuration;
  }
  session(req: IncomingMessage) {
    const id = cookie(req,'session');
    const session = this.sessions.get(id);
    if (session && session.expires > Date.now()) return session;
    this.sessions.delete(id);
  }
  private prune<T extends {expires:number}>(map: Map<string,T>) {
    for (const [key,value] of map) if (value.expires <= Date.now()) map.delete(key);
    if (map.size >= 1024) throw Error('Authentication capacity reached');
  }
  async begin(req: IncomingMessage, res: ServerResponse) {
    this.prune(this.flows);
    const config = await this.config();
    const options = this.bootstrap.oidc;
    const flow = {state:oidc.randomState(), nonce:oidc.randomNonce(), verifier:options.pkce ? oidc.randomPKCECodeVerifier() : undefined, expires:Date.now()+600000};
    const parameters: Record<string,string> = {redirect_uri:this.bootstrap.origin+'/auth/callback',scope:'openid',state:flow.state,nonce:flow.nonce};
    if (flow.verifier) {
      parameters.code_challenge = await oidc.calculatePKCECodeChallenge(flow.verifier);
      parameters.code_challenge_method = 'S256';
    }
    this.flows.delete(cookie(req,'flow'));
    const id = token();
    this.flows.set(id,flow);
    set(res,'flow',id,600);
    redirect(res,oidc.buildAuthorizationUrl(config,parameters).href);
  }
  async finish(req: IncomingMessage, res: ServerResponse, url: URL) {
    const id = cookie(req,'flow');
    const flow = this.flows.get(id);
    this.flows.delete(id);
    if (!flow || flow.expires <= Date.now()) throw Error('Login attempt expired');
    const config = await this.config();
    const result = await oidc.authorizationCodeGrant(config,url,{expectedState:flow.state,expectedNonce:flow.nonce,pkceCodeVerifier:flow.verifier,idTokenExpected:true});
    const claims = result.claims();
    if (!claims || !authorized(this.bootstrap.oidc,claims)) throw Error('Identity is outside the authorization allowlist');
    this.sessions.delete(cookie(req,'session'));
    this.prune(this.sessions);
    const lifetime = this.bootstrap.oidc.sessionMinutes * 60;
    const session = token();
    this.sessions.set(session,{subject:claims.sub,csrf:token(),expires:Date.now()+lifetime*1000});
    set(res,'session',session,lifetime);
    res.appendHeader('Set-Cookie',prefix+'flow=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    redirect(res,'/');
  }
  async logout(req: IncomingMessage,res: ServerResponse) {
    this.sessions.delete(cookie(req,'session'));
    set(res,'session','',0);
    const config = this.bootstrap.oidc.postLogout ? await this.config().catch(() => undefined) : undefined;
    if (config?.serverMetadata().end_session_endpoint) return oidc.buildEndSessionUrl(config,{
      client_id:this.bootstrap.oidc.clientId,post_logout_redirect_uri:this.bootstrap.oidc.postLogout!
    }).href;
    return '/';
  }
}

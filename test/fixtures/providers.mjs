import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as oidc from 'openid-client';

export async function listen(server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return 'http://127.0.0.1:'+server.address().port;
}
const json = (res,value) => res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(value));

/** Fixture wire format is project-owned. It makes no claim about Canon's protocol. */
export async function mockCCAPI(serial, media) {
  const fixture={online:true,interrupt:false,malformed:false};
  const server=createServer((req,res)=>{
    if(!fixture.online){res.destroy();return;}
    if(req.url==='/fixture/identity')return json(res,{serial,model:'Mock EOS'});
    if(req.url==='/fixture/volumes')return json(res,[...new Set(media.map(item=>item.storage))]);
    if(req.url?.startsWith('/fixture/list/'))return json(res,fixture.malformed?null:media.filter(item=>item.storage===req.url.split('/').at(-1)));
    if(req.url?.startsWith('/fixture/original/')){
      const item=media.find(row=>row.key===req.url.split('/').at(-1));
      if(!item){res.writeHead(404).end();return;}
      res.writeHead(200,{'Content-Length':item.size});
      if(fixture.interrupt){res.write(Buffer.alloc(1));res.destroy();return;}
      const chunk=Buffer.alloc(65536,Number(item.key));
      Readable.from((function*(){for(let n=item.size;n>0;n-=chunk.length)yield chunk.subarray(0,Math.min(n,chunk.length));})()).pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  const origin=await listen(server);
  const get=async(path,signal)=>{
    const response=await fetch(origin+path,{signal,redirect:'error'});
    if(!response.ok)throw Error('Mock camera unavailable');
    return response;
  };
  const adapter={
    identify:async signal=>(await get('/fixture/identity',signal)).json(),
    async *list(signal){
      const volumes=await (await get('/fixture/volumes',signal)).json();
      for(const volume of volumes){
        const entries=await (await get('/fixture/list/'+volume,signal)).json();
        if(!Array.isArray(entries))throw Error('Invalid mock enumeration');
        yield*entries;
      }
    },
    open:async(media,signal)=>Readable.fromWeb((await get('/fixture/original/'+media.key,signal)).body)
  };
  return {fixture,adapter,close:()=>server.closeAllConnections()||server.close()};
}

/** Signed synthetic tokens exercise the same OIDC grant used by the production listener. */
export function mockOIDC(clientId='canon') {
  const issuer='https://sso.fixture.invalid';
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const metadata={issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',
    code_challenge_methods_supported:['S256'],id_token_signing_alg_values_supported:['RS256']};
  const state={nonce:'',subject:'approved',override:{},badSignature:false};
  const fetch=async url=>{
    if(String(url).endsWith('/.well-known/openid-configuration'))return Response.json(metadata);
    if(String(url).endsWith('/jwks'))return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'fake-key',alg:'RS256',use:'sig'}]});
    const now=Math.floor(Date.now()/1000);
    const claims={iss:issuer,aud:clientId,sub:state.subject,nonce:state.nonce,iat:now,exp:now+300,...state.override};
    const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const input=encode({alg:'RS256',kid:'fake-key'})+'.'+encode(claims);
    const signed=sign('RSA-SHA256',Buffer.from(state.badSignature?input+'bad':input),privateKey).toString('base64url');
    return Response.json({access_token:'fixture',id_token:input+'.'+signed,token_type:'Bearer'});
  };
  const config=async()=>oidc.discovery(new URL(issuer),clientId,{client_secret:'synthetic'},undefined,
    {[oidc.customFetch]:fetch,execute:[oidc.enableNonRepudiationChecks]});
  return {issuer,config,state,fetch};
}
export function mockPush(codes=[201]) {
  const messages=[];
  return {messages,send:async (subscription,payload)=>{
    messages.push({subscription,payload:JSON.parse(payload)});
    return codes.length>1?codes.shift():codes[0];
  }};
}

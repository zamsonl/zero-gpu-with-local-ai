// These controls are deliberately incapable of forwarding to the owner's global relay routes.
import {RELAY_ORIGIN as SERVICE} from './deployment.mjs';
export function ownCloudConfig(config){
  if(!config?.session_id)return null;
  if(!/^[A-Za-z0-9_-]{16,64}$/.test(config.session_id)||config.relay!==SERVICE+'/_agent/'+config.session_id||config.host!=='kaggle'||typeof config.key!=='string'||config.key.length<24)throw new Error('Invalid personal Kaggle session. Owner connection fallback is disabled.');
  return config;
}
export async function ownCloudRequest(config,path,{fetcher=fetch,signal}={}){
  const own=ownCloudConfig(config);if(!own)throw new Error('This helper has no personal Kaggle session.');
  if(!['/v1/status','/v1/server/log','/v1/server/shutdown','/v1/heartbeat'].includes(path))throw new Error('Unsupported personal server operation.');
  const post=path.endsWith('/shutdown')||path.endsWith('/heartbeat');
  const response=await fetcher(own.relay+path,{method:post?'POST':'GET',headers:{'x-relay-key':own.key,...(post?{'content-type':'application/json'}:{})},body:post?'{}':undefined,redirect:'error',signal:signal??AbortSignal.timeout(10000)});
  const result=await response.json();if(!response.ok){const error=new Error('Personal Kaggle session request failed.');error.status=response.status;throw error;}
  return result;
}

/** Keeps only this session alive while its owning local window/process remains open. */
export function startPersonalKeepAlive(config,{request=ownCloudRequest,intervalMs=30000,setTimer=setTimeout,clearTimer=clearTimeout,signal,onError=()=>{}}={}){
  const own=ownCloudConfig(config);if(!own)throw new Error('This helper has no personal Kaggle session.');
  if(!Number.isFinite(intervalMs)||intervalMs<1000||intervalMs>60000)throw new Error('Invalid personal heartbeat interval.');
  const abort=new AbortController();let timer=null,stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;clearTimer(timer);timer=null;signal?.removeEventListener('abort',stop);abort.abort();};
  const tick=async()=>{
    if(stopped)return false;
    let succeeded=false;
    try{await request(own,'/v1/heartbeat',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});succeeded=true;}
    catch(error){if(!stopped){onError();if([401,403,409,410].includes(error?.status))stop();}}
    finally{if(!stopped){timer=setTimer(()=>{timer=null;void tick();},intervalMs);timer?.unref?.();}}
    return succeeded;
  };
  signal?.addEventListener('abort',stop,{once:true});
  if(signal?.aborted)stop();
  const ready=tick();
  return {stop,ready};
}

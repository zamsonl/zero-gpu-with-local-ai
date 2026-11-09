import {randomUUID} from 'node:crypto';
import readline from 'node:readline';
import {RELAY_ORIGIN} from './deployment.mjs';
export {RELAY_ORIGIN} from './deployment.mjs';

const ID=/^[A-Za-z0-9_-]{16,64}$/;
const CLIENT_ID=/^[A-Za-z0-9_-]{16,80}$/;

export function validateModelUrl(value=''){
  if(typeof value!=='string'||value.length>2048)throw new Error('Hugging Face GGUF only. Paste a public repository or complete .gguf file link.');
  if(!value.trim())return '';
  let url;try{url=new URL(value.trim());}catch{throw new Error('Hugging Face GGUF only. Use an https://huggingface.co/… link.');}
  if(url.protocol!=='https:'||url.hostname!=='huggingface.co'||url.port||url.username||url.password||url.hash||[...url.searchParams].some(([k,v])=>k!=='download'||v!=='true'))throw new Error('Hugging Face GGUF only. Other hosts and credential-bearing links are not supported.');
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<2||parts.some(p=>!/^[-A-Za-z0-9_.]+$/.test(p)||p==='.'||p==='..')||parts.length>2&&(!['blob','resolve'].includes(parts[2])||parts.length<5||!/\.gguf$/i.test(parts.at(-1))||/mmproj|\d{5}-of-\d{5}/i.test(parts.slice(4).join('/'))))throw new Error('Choose a Hugging Face repository or a complete single GGUF chat model, not a projector or split shard.');
  return 'https://huggingface.co/'+parts.slice(0,2).join('/')+(parts.length>2?'/blob/'+parts.slice(3).join('/'):'');
}
export async function probeOwnNotebook(session,{token,fetcher=fetch,signal}={}){
  const own=validatePersonalSession(session,{requireFresh:false});
  const slug=new URL(own.url).pathname.split('/').filter(Boolean).at(-1);
  let response;try{response=await fetcher('https://api.kaggle.com/v1/kernels.KernelsApiService/GetKernelSessionStatus',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({userName:own.owner,kernelSlug:slug}),redirect:'error',signal:signal??AbortSignal.timeout(10000)});}catch{throw new Error('Kaggle queue status is temporarily unavailable.');}
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Kaggle queue status could not be checked.'),{status:response.status});}
  const value=await response.json();return {status:String(value.status||'').toUpperCase()};
}

export function validatePersonalSession(value,{now=Date.now(),requireFresh=true}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||!ID.test(value.session_id||'')||value.host!=='kaggle'||
     typeof value.key!=='string'||!/^[A-Za-z0-9_-]{24,256}$/.test(value.key)||
     typeof value.owner!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value.owner))throw new Error('The service returned an invalid personal Kaggle session. No owner connection was used.');
  let relay,notebook;
  try{relay=new URL(value.relay);notebook=new URL(value.url);}catch{throw new Error('The service returned an invalid personal Kaggle connection.');}
  const expected=RELAY_ORIGIN+'/_agent/'+value.session_id;
  if(value.relay!==expected||relay.username||relay.password||relay.search||relay.hash||
     !['https://www.kaggle.com','https://kaggle.com'].includes(notebook.origin)||notebook.username||notebook.password||notebook.search||notebook.hash||
     !new RegExp('^/code/'+value.owner+'/qwen-agent-[A-Za-z0-9_-]+/?$').test(notebook.pathname))throw new Error('The service did not return an isolated notebook connection for your Kaggle account.');
  const expiry=Date.parse(value.expires_at);
  if(!Number.isFinite(expiry)||requireFresh&&(expiry<=now||expiry>now+14*3600000))throw new Error('The personal Kaggle session has an invalid expiry.');
  const profile=value.model_profile;
  if(profile&&(!(typeof profile.label==='string'&&profile.label.length<=100)||![8192,16384,24576,32768].includes(profile.context)||typeof profile.quant!=='string'||!/^[-A-Z0-9_]{1,30}$/.test(profile.quant)||profile.num_batch!==128||!/^hfgguf:[a-f0-9]{24}$/.test(profile.profile_id)||profile.thinking!==undefined&&typeof profile.thinking!=='boolean'))throw new Error('Invalid custom Hugging Face model profile.');
  return {relay:expected,key:value.key,session_id:value.session_id,host:'kaggle',owner:value.owner,expires_at:value.expires_at,url:notebook.href,...(profile?{model_profile:{...(profile.source_url?{source_url:validateModelUrl(profile.source_url)}:{}),label:profile.label,context:profile.context,quant:profile.quant,num_batch:128,profile_id:profile.profile_id,...(typeof profile.thinking==='boolean'?{thinking:profile.thinking}:{})}}:{})};
}

export async function createOwnKaggleSession({token,consent,modelUrl='',cacheId,clientId=randomUUID(),fetcher=fetch,now=Date.now()}){
  if(consent!==true)throw new Error('Starting a personal GPU notebook requires your explicit consent.');
  if(typeof token!=='string'||!/^KGAT_[A-Za-z0-9_-]{16,251}$/.test(token.trim()))throw new Error('Enter your own modern Kaggle API token (KGAT_…).');
  if(!CLIENT_ID.test(clientId))throw new Error('Invalid launch reference.');
  const model=validateModelUrl(modelUrl);
  let response;
  try{
    response=await fetcher(RELAY_ORIGIN+'/v1/agent/sessions',{
      method:'POST',headers:{'content-type':'application/json'},credentials:'omit',redirect:'error',
      body:JSON.stringify({kaggle_token:token.trim(),consent:true,client_id:clientId,...(cacheId?{cache_id:cacheId}:{}),...(model?{model_url:model}:{})}),signal:AbortSignal.timeout(90000),
    });
  }catch{throw new Error('The personal Kaggle launch could not be confirmed. Check your Kaggle notebooks before retrying with the same --launch-id. No owner connection fallback was used.');}
  if(!response.ok){
    // Remote errors can reflect credentials; expose only local status-based explanations.
    if(response.status===401||response.status===403)throw Object.assign(new Error('Your Kaggle token was not accepted. Forget the saved token, then paste a new token and retry. No owner account fallback was used.'),{status:response.status,code:'personal_token_invalid'});
    if(response.status===429)throw Object.assign(new Error('The personal-session launch limit was reached. Check active notebooks and wait for the account cooldown. To replace a stale token or connect a different account, Forget saved token first, paste the new token, then retry. A new token for the same account does not reset its launch limit.'),{status:429,code:'personal_launch_limit'});
    if(response.status===409)throw Object.assign(new Error('Your Kaggle account may already have a coding notebook running or queued. Check its notebook and resume the existing session or stop it before retrying.'),{status:409,code:'personal_session_active'});
    if(response.status>=500)throw new Error('The personal Kaggle launch could not be confirmed. Check your Kaggle notebooks before retrying with the same --launch-id.');
    throw new Error('The personal-session request was rejected. Check your own Kaggle token and launch consent.');
  }
  let value;
  try{value=await response.json();}catch{throw new Error('The service returned an unreadable personal-session response. Check Kaggle before retrying.');}
  const own=validatePersonalSession(value,{now});
  if(model&&own.model_profile?.source_url!==model){let stopped=false;try{await requestOwnShutdown(own,{fetcher});stopped=true;}catch{}throw Object.assign(new Error('The custom model launch could not be confirmed. '+(stopped?'Shutdown was requested for that notebook.':'Shutdown could not be confirmed.')+' Check Kaggle before another launch and update the connector/service. No model response was requested.'),{code:'custom_model_unconfirmed'});}
  return own;
}

export async function requestOwnShutdown(config,{fetcher=fetch}={}){
  const own=validatePersonalSession(config,{requireFresh:false});
  let response;
  try{
    response=await fetcher(own.relay+'/v1/server/shutdown',{
      method:'POST',headers:{'content-type':'application/json','x-relay-key':own.key},body:'{}',
      credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000),
    });
  }catch{throw new Error('Could not confirm shutdown of your Kaggle notebook. Stop it from your Kaggle account.');}
  if(!response.ok)throw new Error('Your Kaggle shutdown request was not accepted. Stop the notebook from your Kaggle account.');
  return {shutdown:'requested'};
}

export function promptHiddenToken({input=process.stdin,output=process.stdout}={}){
  if(!input.isTTY||!output.isTTY||typeof input.setRawMode!=='function')return Promise.reject(new Error('Hidden token entry needs an interactive terminal. Use --kaggle-token-file with your own private token file.'));
  output.write('Your Kaggle API token (hidden): ');
  const wasRaw=!!input.isRaw,wasPaused=input.isPaused?.()??false;
  input.setRawMode(true);input.resume();
  return new Promise((resolve,reject)=>{
    let secret='',finished=false;
    const clean=()=>{finished=true;input.removeListener('data',onData);input.removeListener('end',onEnd);input.removeListener('error',onError);input.setRawMode(wasRaw);if(wasPaused)input.pause();output.write('\n');};
    const finish=()=>{clean();const value=secret.trim();secret='';resolve(value);};
    const fail=()=>{clean();secret='';reject(new Error('Kaggle token entry cancelled. No GPU notebook was launched.'));};
    const onEnd=()=>fail();
    const onError=()=>fail();
    const onData=chunk=>{
      if(finished)return;
      const text=String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z~]/g,'');
      for(const character of text){
        if(character==='\u0003'||character==='\u0004')return fail();
        if(character==='\r'||character==='\n')return finish();
        if(character==='\u007f'||character==='\b'){secret=secret.slice(0,-1);continue;}
        if(character==='\u0015'){secret='';continue;}
        if(/[A-Za-z0-9_-]/.test(character)&&secret.length<256)secret+=character;
      }
    };
    input.on('data',onData);input.once('end',onEnd);input.once('error',onError);
  });
}

export async function confirmGpuUsage({input=process.stdin,output=process.stdout}={}){
  if(!input.isTTY||!output.isTTY)throw new Error('GPU consent needs an interactive terminal, or the explicit --consent-kaggle-gpu option.');
  const prompt=readline.createInterface({input,output,terminal:true});
  try{return await new Promise(resolve=>{prompt.question('Start a private Qwen notebook in YOUR Kaggle account and use YOUR GPU allowance? [y/N] ',answer=>resolve(/^y(?:es)?$/i.test(answer.trim())));prompt.once('close',()=>resolve(false));});}
  finally{prompt.close();}
}

import {RELAY_ORIGIN,validateModelUrl} from './kaggle-session.mjs';
const STATES=new Set(['creating','queued','unknown','building','uploaded','processing','ready','failed','cancelled']);
const abortError=()=>Object.assign(new Error('Cache preparation cancelled. No GPU notebook was started.'),{name:'AbortError'});
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve();};const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(abortError());};const timer=setTimeout(done,ms);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();});

export async function prepareOwnCache({token,consent,modelUrl='',signal,onProgress,fetcher=fetch,pause=sleep,now=Date.now,maxMs=3*3600000}={}){
  if(consent!==true)throw new Error('Private Kaggle cache preparation requires setup consent.');
  if(typeof token!=='string'||!/^KGAT_[A-Za-z0-9_-]{16,251}$/.test(token))throw new Error('Enter your own Kaggle API token.');
  const model=validateModelUrl(modelUrl);let cacheId='',owner='',finished=false,last='',failures=0,attempt=0;
  const started=now();
  const send=async(action,cleanup=false)=>{
    const timeout=AbortSignal.timeout(cleanup?10000:45000),active=cleanup?timeout:signal?AbortSignal.any([signal,timeout]):timeout;
    let response;try{response=await fetcher(RELAY_ORIGIN+'/v1/agent/cache',{method:'POST',headers:{'content-type':'application/json'},credentials:'omit',redirect:'error',signal:active,body:JSON.stringify({kaggle_token:token,consent:true,...(model?{model_url:model}:{}),...(cacheId?{cache_id:cacheId}:{}),...(action?{action}:{}),...(!cleanup&&attempt++===0?{retry:true}:{})})});}catch{if(signal?.aborted&&!cleanup)throw abortError();throw Object.assign(new Error('Cache setup connection was interrupted. The same build will be checked before any GPU launch.'),{retryable:true});}
    if(!response.ok){await response.body?.cancel();const error=new Error(response.status===401||response.status===403?'Kaggle did not accept the token or private Dataset operation. Check your token and Dataset permissions.':response.status===409?'Another cache build is active, or the existing Dataset could not be safely reused. Check your CPU cache notebook and private Datasets.':response.status===429?'Wait before explicitly retrying cache preparation.':'Private cache preparation could not be confirmed. Check your CPU notebook and Dataset storage. No GPU was started.');error.status=response.status;throw error;}
    const raw=await response.text();if(raw.length>16384)throw new Error('Invalid cache setup response.');let value;try{value=JSON.parse(raw);}catch{throw new Error('Unreadable cache setup response.');}
    if(!STATES.has(value.state)||typeof value.cache_id!=='string'||!/^[-A-Za-z0-9_.:]{8,160}$/.test(value.cache_id)||!/^[A-Za-z0-9_-]{1,64}$/.test(value.owner||'')||(value.model_url||'')!==model||owner&&value.owner!==owner||cacheId&&value.cache_id!==cacheId)throw new Error('The service did not confirm an isolated cache for your selected model and account.');
    cacheId=value.cache_id;owner=value.owner;
    if(value.state==='ready'&&(typeof value.dataset!=='string'||!new RegExp('^'+owner+'/[-A-Za-z0-9_]+/[1-9][0-9]*$').test(value.dataset)))throw new Error('The service returned an invalid pinned private cache.');
    return value;
  };
  try{
    for(;;){
      if(signal?.aborted)throw abortError();if(now()-started>maxMs)throw new Error('Cache preparation reached its three-hour limit. No GPU notebook was started. Check the CPU builder in Kaggle.');
      let value;try{value=await send();failures=0;}catch(error){if(error.name==='AbortError'||!error.retryable||++failures>4)throw error;await pause(5000,signal);continue;}
      const detail=String(value.detail||'Preparing your private cache.').slice(0,500),key=value.state+'|'+detail;
      if(key!==last){last=key;onProgress?.({stage:'cache',state:value.state==='ready'?'complete':['failed','cancelled'].includes(value.state)?'error':'running',detail,owner,...(value.notebook_url?{notebookUrl:value.notebook_url}:{})});}
      if(value.state==='failed'||value.state==='cancelled'){finished=true;throw new Error(detail+' No GPU notebook was started.');}
      if(value.state==='ready'){finished=true;return {cache_id:cacheId,owner,dataset:value.dataset,model_url:value.model_url||null};}
      await pause(15000,signal);
    }
  }finally{
    if(!finished){try{await send('cancel',true);}catch{/* The CPU build also stops if the local setup stops renewing its lease. */}}
    token='';
  }
}

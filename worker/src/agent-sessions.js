import {huggingFaceSource,resolveHuggingFaceModel} from './custom-model.js';
import {readyPersonalCache} from './personal-cache.js';
// Personal Kaggle sessions for the local helper. No owner GPU or owner API-token fallback.
import { agentStep } from './agent.js';
import { settings } from './config.js';
import { HttpError, errorJson, json, readJsonObject } from './http.js';
import { serverScript } from './kaggle.js';
import { readActiveLock, requestStop } from './lock.js';
import { appendLog, logBatch } from './notebook-log.js';
import { findLoadedModel, getJson } from './ollama.js';
import { readTarget, writeTarget, clearTarget, validJobLegSeconds } from './target.js';
import { openCodeChat, openCodeModels } from './opencode.js';

const SESSION_HOURS=13;
export const PERSONAL_IDLE_MINUTES=120;
export const CLIENT_ALIVE_MS=2*60*1000;
const ID=/^[a-f0-9]{40}$/;
const CLIENT_ID=/^[A-Za-z0-9_-]{8,80}$/;
const TOKEN=/^KGAT_[A-Za-z0-9_-]{16,251}$/;
const encoder=new TextEncoder();
const metaKey=id=>'agent:session:'+id;
const prefix=id=>'agent:data:'+id+':';
const now=()=>new Date().toISOString();
const clientAge=heartbeat=>{const age=Date.now()-Date.parse(heartbeat?.at);return Number.isFinite(age)&&age>=0?age:null;};
const clientActive=heartbeat=>{const age=clientAge(heartbeat);return age!==null&&age<=CLIENT_ALIVE_MS;};
const digest=async text=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(text)));
const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
async function derived(secret,text){
  if(typeof secret!=='string'||secret.length<16)throw new HttpError(503,'session_config','Personal Kaggle sessions are not configured.');
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(text)));
}
async function equalHash(secret,expected){
  if(typeof secret!=='string'||typeof expected!=='string')return false;
  return crypto.subtle.timingSafeEqual(encoder.encode(await digest(secret)),encoder.encode(expected));
}
async function read(db,key){const row=await db.prepare('SELECT v FROM state WHERE k = ?1').bind(key).first();return row?JSON.parse(row.v):null;}
async function write(db,key,value){await db.prepare('INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at').bind(key,JSON.stringify(value),now()).run();}

/** Only known state-key SQL used by target/readMode/GenerationLock is accepted. Other tables fail closed. */
export class AgentStateDB {
  constructor(db,id){if(!ID.test(id))throw new Error('Invalid agent namespace.');this.db=db;this.prefix=prefix(id);}
  prepare(sql){
    const normalized=sql.replace(/\s+/g,' ').trim();
    const readOnly=/^SELECT v FROM state WHERE k = \?1$/i.test(normalized);
    const insert=/^INSERT INTO state \(k, v, updated_at\) VALUES \(\?1, \?2, \?3\) ON CONFLICT\s*\(k\) DO UPDATE SET v = excluded\.v, updated_at = excluded\.updated_at(?: WHERE json_extract\(state\.v, '\$\.heartbeat'\) < \?4)?$/i.test(normalized);
    const remove=/^DELETE FROM state WHERE k = \?1(?: AND (?:v = \?2|json_extract\(v, '\$\.owner'\) = \?2))?$/i.test(normalized);
    const update=/^UPDATE state SET v = json_set\(v, '\$\.(?:heartbeat|stop)', \?2\), updated_at = \?2 WHERE k = \?1 AND json_extract\(v, '\$\.owner'\) = \?3$/i.test(normalized);
    if(!readOnly&&!insert&&!remove&&!update)throw new Error('This personal session cannot access that database operation.');
    const allowed=new Set(['target','gen_lock','server_mode','mode_request','opencode_overflow']);
    return {bind:(...args)=>{
      if(!allowed.has(args[0]))throw new Error('This personal session cannot access that state key.');
      const statement=this.db.prepare(sql).bind(this.prefix+args[0],...args.slice(1));
      return {first:column=>statement.first(column),all:()=>statement.all(),run:()=>statement.run()};
    }};
  }
}

async function kaggleCall(env,token,service,method,body,fetcher){
  let response;
  try{response=await fetcher((env.KAGGLE_API_BASE||'https://api.kaggle.com')+'/v1/'+service+'/'+method,{method:'POST',redirect:'manual',headers:{'content-type':'application/json',authorization:'Bearer '+token,'user-agent':'heretic-qwen-personal-agent/1'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}
  catch{throw new HttpError(502,'kaggle_unknown','Kaggle did not confirm this request. Retry the same launch reference to check it; no second notebook will be submitted.',{origin:'kaggle',operation:method,launch_uncertain:true});}
  if(!response.ok){
    // Never reflect a provider body: it may include a credential, notebook code,
    // or a private URL. Retain only bounded structural diagnostics/classification.
    let result=null;try{result=await readJsonObject(response,8192);}catch{}
    const rawCode=result?.error?.code??result?.code;
    const upstream_code=Number.isSafeInteger(rawCode)?rawCode:typeof rawCode==='string'&&/^[A-Za-z0-9_.:-]{1,40}$/.test(rawCode)&&!rawCode.startsWith('KGAT_')?rawCode:undefined;
    const explanation=String(result?.error?.message??(typeof result?.error==='string'?result.error:null)??result?.message??'');
    const category=/gpu.*(?:quota|hours|limit)|(?:quota|hours).*gpu/i.test(explanation)?'gpu_quota'
      :/dataset/i.test(explanation)?'dataset_access':/verif(?:y|ication)|phone/i.test(explanation)?'account_verification'
      :/concurrent|already.*running|too many.*(?:kernel|notebook)/i.test(explanation)?'concurrent_notebooks'
      :/permission|forbidden|unauthori[sz]ed/i.test(explanation)?'account_permission':'request_rejected';
    const confirmed_refusal=response.status>=400&&response.status<500&&response.status!==408;
    const code=confirmed_refusal?(response.status===429?'kaggle_rate_limit':'kaggle_refused'):'kaggle_unknown';
    throw new HttpError(response.status===401||response.status===403&&method==='IntrospectToken'?401:response.status===429?429:502,code,
      `Kaggle ${confirmed_refusal?'refused':'did not confirm'} ${method} (HTTP ${response.status}; ${category}). ${confirmed_refusal?'No accepted launch was confirmed.':'Check the same launch reference before starting another notebook.'}`,
      {origin:'kaggle',operation:method,upstream_status:response.status,...(upstream_code===undefined?{}:{upstream_code}),category,confirmed_refusal,launch_uncertain:!confirmed_refusal});
  }
  const result=await (['ListKernels','GetAcceleratorQuotaStatistics'].includes(method)?readJsonObject(response,256*1024):response.json()).catch(()=>null);
  if(!result||result.error||Number.isInteger(result.code)&&result.code>=400)throw new HttpError(502,'kaggle_unknown','Kaggle returned an unconfirmed result. Retry the same launch reference to check it.',{origin:'kaggle',operation:method,launch_uncertain:true});
  return result;
}

const terminalKaggleStatus=status=>['COMPLETE','ERROR','CANCELED','CANCELLED','CANCEL_ACKNOWLEDGED'].includes(String(status||'').toUpperCase());
const rejectedLaunch=meta=>meta?.launch_state==='failed'&&(meta.launch_error?.confirmed_refusal===true||meta.launch_error?.submission_sent===false);
const legacyUnconfirmed=meta=>meta?.launch_state==='failed'&&!meta.launch_error&&meta.version==null;
function inaccessibleNotebook(meta,status=403){
  const recoverable=legacyUnconfirmed(meta);
  return new HttpError(409,'personal_notebook_inaccessible','Kaggle cannot access an earlier coding notebook. Retrying alone cannot establish whether it was deleted. Check the notebook in your account; only use deleted-notebook recovery after confirming the old coding notebooks are not running or queued.',{origin:'kaggle',operation:'GetKernelSessionStatus',upstream_status:status,launch_uncertain:true,can_confirm_deleted:recoverable,notebook_url:`https://www.kaggle.com/code/${meta.owner}/${meta.slug}`});
}

// PROFILE is the official CLI's --mine inventory. Absence and zero reserved
// quota are corroboration, not a deletion guarantee; explicit operator deletion
// confirmation is also required. This never resets an ambiguous accepted job.
async function deletionEvidence(env,token,owner,fetcher){
  const refs=new Set(),seen=new Set();let pageToken='';
  for(let page=0;page<8;page++){
    const result=await kaggleCall(env,token,'kernels.KernelsApiService','ListKernels',{group:'PROFILE',user:'',language:'all',kernelType:'all',outputType:'all',pageSize:100,...(pageToken?{pageToken}:{page:1})},fetcher);
    if(Object.keys(result).some(key=>!['kernels','nextPageToken'].includes(key)))throw new HttpError(409,'personal_inventory_unconfirmed','Kaggle did not return a notebook inventory. No stale record was reset.',{launch_uncertain:true});
    const kernels=result.kernels===undefined?[]:result.kernels,next=result.nextPageToken===undefined?'':result.nextPageToken;
    if(!Array.isArray(kernels)||kernels.length>100||typeof next!=='string'||next.length>4096)throw new HttpError(409,'personal_inventory_unconfirmed','Kaggle returned an incomplete notebook inventory. No stale record was reset.',{launch_uncertain:true});
    for(const item of kernels){
      const ref=item?.ref;
      if(typeof ref!=='string'||!new RegExp('^'+owner+'/[A-Za-z0-9_-]+$','i').test(ref)||item.author!==undefined&&(typeof item.author!=='string'||item.author.toLowerCase()!==owner.toLowerCase())||item.slug!==undefined&&(typeof item.slug!=='string'||item.slug.toLowerCase()!==ref.split('/')[1].toLowerCase()))throw new HttpError(409,'personal_inventory_unconfirmed','Kaggle did not return a verifiable inventory for this account. No stale record was reset.',{launch_uncertain:true});
      refs.add(ref.toLowerCase());
    }
    if(!next){
      const quota=await kaggleCall(env,token,'kernels.KernelsApiService','GetAcceleratorQuotaStatistics',{},fetcher);
      if(Object.keys(quota).some(key=>!['gpuQuota','tpuQuota','quotaRefreshTime'].includes(key))||typeof quota.gpuQuota?.timeReserved!=='string'||!/^0(?:\.0{1,9})?s$/.test(quota.gpuQuota.timeReserved))throw new HttpError(409,'personal_gpu_state_unconfirmed','Kaggle reports reserved GPU time or did not confirm the GPU reservation state. Check running and queued notebooks before resetting old tracking.',{origin:'kaggle',operation:'GetAcceleratorQuotaStatistics',launch_uncertain:true});
      return refs;
    }
    if(seen.has(next))break;
    seen.add(next);pageToken=next;
  }
  throw new HttpError(409,'personal_inventory_unconfirmed','The complete notebook inventory could not be checked within the connection budget. No stale record was reset.',{launch_uncertain:true});
}

async function verifiedNotebookIdentity(meta,env,token,fetcher,slug){
  const found=await kaggleCall(env,token,'kernels.KernelsApiService','GetKernel',{userName:meta.owner,kernelSlug:slug},fetcher).catch(()=>null);
  const source=found?.blob?.source;
  const launch=typeof source==='string'?/^LAUNCH_TOKEN = ["']([a-f0-9]{64})["']$/m.exec(source)?.[1]:null;
  if(typeof source!=='string'||!source.includes('/_agent/'+meta.id)||!launch||!await equalHash(launch,meta.launch_hash)||typeof found.metadata?.ref!=='string'||found.metadata.ref.toLowerCase()!==(meta.owner+'/'+slug).toLowerCase())return null;
  try{return canonicalNotebookIdentity({ref:found.metadata.ref,kernelId:found.metadata.id},meta.owner);}catch{return null;}
}

async function repairLegacyIdentity(db,meta,env,token,fetcher){
  if(meta.launch_state!=='launched'||meta.canonical_ref||!meta.version)return null;
  const identity=await verifiedNotebookIdentity(meta,env,token,fetcher,'qwen-local-coding-agent');
  if(!identity)return null;
  await db.prepare("UPDATE state SET v=json_set(v,'$.slug',?1,'$.url',?2,'$.canonical_ref',?3,'$.kernel_id',?4,'$.identity_repaired_at',?5),updated_at=?5 WHERE k=?6 AND json_extract(v,'$.canonical_ref') IS NULL").bind(identity.slug,identity.url,identity.canonical_ref,identity.kernel_id??null,now(),metaKey(meta.id)).run();
  return read(db,metaKey(meta.id));
}

async function reconcileLaunch(db,meta,env,token,fetcher,recovery){
  if(rejectedLaunch(meta)||meta.ended_at)return meta;
  try{
    const result=await kaggleCall(env,token,'kernels.KernelsApiService','GetKernelSessionStatus',{userName:meta.owner,kernelSlug:meta.slug},fetcher);
    if(typeof result.status!=='string'||!result.status.trim())throw new HttpError(502,'kaggle_unknown','Kaggle did not return a notebook status.');
    let cancelledWithoutReservation=false;
    if(String(result.status).toUpperCase()==='CANCEL_REQUESTED'){
      const [shutdown,target,heartbeat]=await Promise.all([read(db,prefix(meta.id)+'shutdown'),read(db,prefix(meta.id)+'target'),read(db,prefix(meta.id)+'client_activity')]);
      if(shutdown&&!target&&!clientActive(heartbeat)){
        const quota=await kaggleCall(env,token,'kernels.KernelsApiService','GetAcceleratorQuotaStatistics',{},fetcher).catch(()=>null);
        cancelledWithoutReservation=typeof quota?.gpuQuota?.timeReserved==='string'&&/^0(?:\.0{1,9})?s$/.test(quota.gpuQuota.timeReserved);
      }
    }
    const updated={...meta,launch_state:'launched',reconciled_at:now(),kaggle_status:String(result.status).toUpperCase(),...(terminalKaggleStatus(result.status)||cancelledWithoutReservation?{ended_at:now(),...(cancelledWithoutReservation?{ended_reason:'shutdown_requested_no_reserved_gpu'}:{})}:{} )};
    await write(db,metaKey(meta.id),updated);return updated;
  }catch(error){
    if([403,404].includes(error?.extra?.upstream_status)){
      const repaired=await repairLegacyIdentity(db,meta,env,token,fetcher);
      if(repaired?.canonical_ref)return reconcileLaunch(db,repaired,env,token,fetcher,recovery);
      if(recovery?.confirmed&&legacyUnconfirmed(meta)&&meta.owner.toLowerCase()===recovery.owner.toLowerCase()){
        const age=Date.now()-Date.parse(meta.created_at);
        const [target,heartbeat,boot]=await Promise.all([read(db,prefix(meta.id)+'target'),read(db,prefix(meta.id)+'client_activity'),read(db,prefix(meta.id)+'boot')]);
        if(!Number.isFinite(age)||age<4*60000||target||clientActive(heartbeat)||boot&&!['queued','failed'].includes(boot.stage))throw inaccessibleNotebook(meta,error.extra.upstream_status);
        recovery.evidence??=deletionEvidence(env,token,recovery.owner,fetcher);
        const refs=await recovery.evidence;
        if(refs.has((meta.owner+'/'+meta.slug).toLowerCase()))throw inaccessibleNotebook(meta,error.extra.upstream_status);
        // Remote checks may be slow. Re-read local activity and fence the final
        // update against callbacks/reconciliation arriving while they ran.
        const keys=[metaKey(meta.id),prefix(meta.id)+'target',prefix(meta.id)+'client_activity',prefix(meta.id)+'boot'];
        const rows=await Promise.all(keys.map(key=>db.prepare('SELECT v FROM state WHERE k = ?1').bind(key).first()));
        const fresh=rows[0]?JSON.parse(rows[0].v):null,h=rows[2]?JSON.parse(rows[2].v):null,b=rows[3]?JSON.parse(rows[3].v):null;
        if(!legacyUnconfirmed(fresh)||fresh.ended_at||fresh.owner!==meta.owner||fresh.slug!==meta.slug||rows[1]||clientActive(h)||b&&!['queued','failed'].includes(b.stage))throw inaccessibleNotebook(meta,error.extra.upstream_status);
        const updated={...fresh,ended_at:now(),reconciled_at:now(),recovery:{kind:'operator_confirmed_missing_legacy',inventory_checked:true,gpu_reserved:'0s'}};
        const changed=await db.prepare("UPDATE state SET v = ?1, updated_at = ?2 WHERE k = ?3 AND v = ?4 AND NOT EXISTS(SELECT 1 FROM state WHERE k = ?5) AND COALESCE((SELECT v FROM state WHERE k = ?6),'') = ?7 AND COALESCE((SELECT v FROM state WHERE k = ?8),'') = ?9").bind(JSON.stringify(updated),now(),keys[0],rows[0].v,keys[1],keys[2],rows[2]?.v??'',keys[3],rows[3]?.v??'').run();
        if(changed.meta.changes!==1)throw inaccessibleNotebook(meta,error.extra.upstream_status);
        return updated;
      }
      throw inaccessibleNotebook(meta,error.extra.upstream_status);
    }
    throw new HttpError(409,'personal_launch_unconfirmed','The previous notebook state could not be verified. Retry the same launch reference; another GPU notebook was not submitted.',{origin:error?.extra?.origin==='kaggle'?'kaggle':'connector',operation:'GetKernelSessionStatus',launch_uncertain:true,...(error?.extra?.upstream_status?{upstream_status:error.extra.upstream_status}:{} )});
  }
}

async function reserveLaunch(db,owner,id,env,token,fetcher,recovery){
  const key='agent:rate:'+await digest(owner.toLowerCase());
  for(let attempt=0;attempt<4;attempt++){
    const row=await db.prepare('SELECT v FROM state WHERE k = ?1').bind(key).first();
    const previous=row?JSON.parse(row.v):{launches:[]};
    const cutoff=Date.now()-24*3600000;
    const recent=previous.launches.filter(x=>Date.parse(x.at)>cutoff),counted=[],rejected=[],orphanKeys=[];
    if(recent.some(x=>x.id===id))return;
    for(const item of recent){
      let active=await read(db,metaKey(item.id));
      if(!active){
        if(Date.now()-Date.parse(item.at)<4*60000)throw new HttpError(503,'personal_launch_busy','A personal launch reservation is still being prepared. Check the same launch reference before starting another.',{origin:'connector',launch_uncertain:true});
        // No submit is allowed without metadata and a still-owned reservation.
        // A late creator is fenced again immediately before SaveKernel below.
        orphanKeys.push(metaKey(item.id));
        continue;
      }
      if(active&&!active.ended_at&&Date.parse(active.expires_at)>Date.now())active=await reconcileLaunch(db,active,env,token,fetcher,recovery);
      if(rejectedLaunch(active)){rejected.push(item);continue;}
      counted.push(item);
      if(!active||active.ended_at||Date.parse(active.expires_at)<=Date.now())continue;
      throw new HttpError(409,'personal_session_active','This Kaggle account already has a personal coding notebook running or queued. Resume the same helper session, or stop that notebook in Kaggle before creating another.',{origin:'connector',launch_uncertain:false});
    }
    const rejectedDelay=Math.max(0,...rejected.map(x=>30_000-(Date.now()-Date.parse(x.at))));
    if(rejectedDelay>0)throw new HttpError(429,'personal_retry_cooldown','The last refused launch has a short connector retry delay. Its refusal did not consume the daily GPU-launch allowance.',{origin:'connector',limit_kind:'rejected_retry',retry_after_seconds:Math.ceil(rejectedDelay/1000),launch_uncertain:false});
    const delay=Math.max(0,...counted.map(x=>4*60000-(Date.now()-Date.parse(x.at))));
    if(counted.length>=8||delay>0)throw new HttpError(429,'personal_launch_limit','The connector safety limit was reached. Reuse the existing launch reference; replacing the Kaggle token does not change this account limit.',{origin:'connector',limit_kind:counted.length>=8?'daily':'cooldown',retry_after_seconds:Math.ceil((counted.length>=8?Math.min(...counted.map(x=>Date.parse(x.at)+24*3600000-Date.now())):delay)/1000),launch_uncertain:false});
    const next=JSON.stringify({launches:[...counted,...rejected.filter(x=>Date.now()-Date.parse(x.at)<30_000),{id,at:now()}]});
    // An orphan's metadata may appear after the lookup above. Do not remove its
    // reservation in that ordering; the late creator fences the opposite one.
    const orphanFence=orphanKeys.length?' AND NOT EXISTS(SELECT 1 FROM state WHERE k IN ('+orphanKeys.map((_,index)=>'?'+(index+5)).join(',')+'))':'';
    const changed=row?await db.prepare('UPDATE state SET v = ?1, updated_at = ?2 WHERE k = ?3 AND v = ?4'+orphanFence).bind(next,now(),key,row.v,...orphanKeys).run():await db.prepare('INSERT OR IGNORE INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)').bind(key,next,now()).run();
    if(changed.meta.changes){
      // Only this authenticated owner's expired session namespaces are eligible for cleanup.
      for(const old of previous.launches.filter(x=>!recent.some(y=>x.id===y.id)).slice(0,8)){
        if(!ID.test(old.id))continue;
        const metadata=await read(db,metaKey(old.id));
        if(metadata?.owner===owner&&Date.parse(metadata.expires_at)<Date.now()){
          await db.prepare('DELETE FROM state WHERE k LIKE ?1').bind(prefix(old.id)+'%').run().catch(()=>{});
          await db.prepare('DELETE FROM state WHERE k = ?1').bind(metaKey(old.id)).run().catch(()=>{});
        }
      }
      return;
    }
  }
  throw new HttpError(503,'personal_launch_busy','This account is starting another helper session. Try again shortly.');
}

function descriptor(origin,meta,key){return {relay:origin+'/_agent/'+meta.id,key,session_id:meta.id,host:'kaggle',owner:meta.owner,expires_at:meta.expires_at,url:meta.url,launch_state:meta.launch_state,...(meta.model?{model_profile:{source_url:meta.model.url,label:meta.model.label,context:meta.model.context,quant:meta.model.quant,num_batch:128,profile_id:meta.model.profile_id}}:{})};}

/** Kaggle derives new slugs from titles. Persist its authenticated returned identity. */
export function canonicalNotebookIdentity(saved,owner){
  const fail=()=>new HttpError(502,'kaggle_identity_unconfirmed','Kaggle accepted the request but did not return a consistent notebook identity. The existing launch remains reserved; do not submit another.',{origin:'kaggle',operation:'SaveKernel',launch_uncertain:true});
  let url;
  if(saved.url!==undefined){try{url=new URL(saved.url);}catch{throw fail();}
    if(!['https://www.kaggle.com','https://kaggle.com'].includes(url.origin)||url.username||url.password||url.search||url.hash||!/^\/code\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))throw fail();}
  const ref=saved.ref??(url?url.pathname.replace(/^\/code\//,'').replace(/\/$/,''):null);
  if(typeof ref!=='string'||!new RegExp('^'+owner+'/[A-Za-z0-9_-]+$','i').test(ref)||url&&url.pathname.replace(/^\/code\//,'').replace(/\/$/,'').toLowerCase()!==ref.toLowerCase())throw fail();
  const slug=ref.split('/')[1],kernelId=saved.kernelId;
  if(kernelId!==undefined&&!(Number.isSafeInteger(kernelId)&&kernelId>0)&&!(typeof kernelId==='string'&&/^[1-9][0-9]{0,19}$/.test(kernelId)))throw fail();
  return {slug,url:`https://www.kaggle.com/code/${owner}/${slug}`,canonical_ref:owner+'/'+slug,...(kernelId===undefined?{}:{kernel_id:String(kernelId)})};
}

export async function bootstrapAgentSession({request,env,fetcher=fetch,resolveModel=resolveHuggingFaceModel}){
  try{
    const body=await readJsonObject(request,8192);
    if(body.consent!==true)throw new HttpError(400,'consent_required','Confirm that starting your own Kaggle GPU session consumes your allowance.');
    if(body.confirm_deleted_notebooks!==undefined&&typeof body.confirm_deleted_notebooks!=='boolean')throw new HttpError(400,'invalid_recovery_confirmation','Deleted-notebook recovery requires an explicit boolean choice.');
    if(typeof body.kaggle_token!=='string'||!TOKEN.test(body.kaggle_token))throw new HttpError(400,'personal_token_required','Enter your own Kaggle API token. Saved owner credentials are never used.');
    const requestedModel=body.model_url===undefined||body.model_url===''?null:huggingFaceSource(body.model_url);
    const clientId=body.client_id??crypto.randomUUID();
    if(typeof clientId!=='string'||!CLIENT_ID.test(clientId))throw new HttpError(400,'client_id','Invalid launch identity.');
    const info=await kaggleCall(env,body.kaggle_token,'security.OAuthService','IntrospectToken',{token:body.kaggle_token},fetcher);
    if(info.active!==true||typeof info.username!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(info.username))throw new HttpError(401,'personal_token_invalid','The supplied Kaggle token is not active for a valid account.');
    const owner=info.username;
    const recovery={owner,confirmed:body.confirm_deleted_notebooks===true};
    const id=(await derived(env.RELAY_KEY,'agent-session:'+owner.toLowerCase()+':'+clientId)).slice(0,40);
    const key=await derived(env.RELAY_KEY,'agent-helper:'+id);
    const launchToken=await derived(env.RELAY_KEY,'agent-notebook:'+id);
    let existing=await read(env.DB,metaKey(id));
    if(existing){
      if((existing.model?.url||null)!==(requestedModel?.url||null))throw new HttpError(409,"personal_model_changed","This launch identity belongs to another model. Stop its notebook before starting a different model.");
      if(existing.owner!==owner||Date.parse(existing.expires_at)<=Date.now())throw new HttpError(409,'personal_session_expired','This launch identity has expired. Start a new helper launch after checking your notebook.',{origin:'connector',launch_uncertain:false});
      if(!(await equalHash(key,existing.helper_hash)))throw new HttpError(409,'personal_session_changed','The relay signing key changed. Check the old notebook before launching again.');
      if(['failed','unknown','creating'].includes(existing.launch_state)||existing.launch_state==='launched'&&!existing.canonical_ref)existing=await reconcileLaunch(env.DB,existing,env,body.kaggle_token,fetcher,recovery);
      if(rejectedLaunch(existing))throw new HttpError(502,'personal_launch_refused','The previous notebook submission was refused or confirmed absent. Retry creates a new launch reference after the short retry delay.',{...existing.launch_error,origin:existing.launch_error?.origin||'connector',launch_uncertain:false});
      if(existing.ended_at)throw new HttpError(409,'personal_session_ended','The notebook for this launch reference has finished. Start a new helper launch.',{origin:'connector',launch_uncertain:false});
      return json(descriptor(new URL(request.url).origin,existing,key),existing.launch_state==='creating'?202:200);
    }
    const personalCache=body.cache_id?await readyPersonalCache({env,owner,cacheId:body.cache_id,modelUrl:requestedModel?.url||null}):null;
    const model=personalCache?personalCache.model:requestedModel?await resolveModel(body.model_url,{fetcher}):null;
    await reserveLaunch(env.DB,owner,id,env,body.kaggle_token,fetcher,recovery);
    const slug='qwen-agent-'+id.slice(0,24);
    const metadata={id,owner,...(model?{model}:{}),created_at:now(),expires_at:new Date(Date.now()+SESSION_HOURS*3600000).toISOString(),helper_hash:await digest(key),launch_hash:await digest(launchToken),launch_state:'creating',url:`https://www.kaggle.com/code/${owner}/${slug}`,slug};
    const created=await env.DB.prepare('INSERT OR IGNORE INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)').bind(metaKey(id),JSON.stringify(metadata),now()).run();
    if(!created.meta.changes){const found=await read(env.DB,metaKey(id));return json(descriptor(new URL(request.url).origin,found,key),202);}
    const base=new URL(request.url).origin+'/_agent/'+id;
    const cacheDataset=personalCache?.dataset||(!model&&typeof env.KAGGLE_CACHE_DATASET==='string'&&/^[a-z0-9_-]+\/[a-z0-9_-]+\/\d+$/i.test(env.KAGGLE_CACHE_DATASET)&&env.KAGGLE_CACHE_DATASET.split('/')[0].toLowerCase()===owner.toLowerCase()?env.KAGGLE_CACHE_DATASET:null);
    let payload;
    try{
      const reservation=await read(env.DB,'agent:rate:'+await digest(owner.toLowerCase()));
      if(!reservation?.launches?.some(item=>item.id===id))throw new Error('Launch reservation was superseded before submission.');
      await write(env.DB,prefix(id)+'boot',{host:'kaggle',stage:'queued',detail:'Notebook submitted to Kaggle. Waiting for the first startup report; GPU queue state is not yet confirmed.',at:now()});
      payload={slug:`${owner}/${slug}`,newTitle:slug,text:serverScript({relay:base,token:launchToken,quant:model?.quant||'Q5_K_P',contexts:model?[32768,24576,16384,8192]:[98304],vision:false,cacheId:personalCache?.cache_id||(cacheDataset?env.KAGGLE_CACHE_ID||'':''),numBatch:model?128:256,profileId:model?.profile_id||'personal-agent-q5-kv8-b256-96k',agentOnly:true,modelSpec:model,personalCacheSpec:personalCache?.spec||null}),language:'python',kernelType:'script',isPrivate:true,enableGpu:true,enableInternet:true,machineShape:'NvidiaTeslaT4',kernelExecutionType:'SAVE_AND_RUN_ALL',datasetDataSources:cacheDataset?[cacheDataset]:[],kernelDataSources:[],competitionDataSources:[],modelDataSources:[],categoryIds:[]};
    }catch{
      metadata.launch_state='failed';metadata.launch_error={origin:'connector',operation:'PrepareKernel',submission_sent:false};await write(env.DB,metaKey(id),metadata).catch(()=>{});
      throw new HttpError(503,'personal_prepare_failed','The personal notebook could not be prepared. No Kaggle start request was sent.',{...metadata.launch_error,launch_uncertain:false});
    }
    try{
      const saved=await kaggleCall(env,body.kaggle_token,'kernels.KernelsApiService','SaveKernel',payload,fetcher);
      metadata.version=saved.versionNumber??null;metadata.accepted_at=now();
      let identity;
      try{identity=canonicalNotebookIdentity(saved,owner);}catch(error){
        // Some SaveKernel responses use an edit/relative URL or omit identity
        // fields. Read the owned notebook back and verify its scoped source.
        identity=await verifiedNotebookIdentity(metadata,env,body.kaggle_token,fetcher,slug);
        if(!identity)throw error;
      }
      Object.assign(metadata,identity);
      metadata.launch_state='launched';
      await write(env.DB,metaKey(id),metadata);
      return json(descriptor(new URL(request.url).origin,metadata,key),201);
    }catch(error){
      // A lost SaveKernel acknowledgement must never automatically create a second GPU run.
      // SaveKernel may have succeeded even when its response or the later D1 acknowledgement
      // was lost. Only an explicit Kaggle HTTP refusal proves that no confirmed launch exists.
      metadata.launch_state=error instanceof HttpError&&error.extra?.confirmed_refusal===true?'failed':'unknown';
      metadata.launch_error={code:error.code||'kaggle_unknown',...(error.extra||{}),at:now()};
      await write(env.DB,metaKey(id),metadata).catch(()=>{});
      await write(env.DB,prefix(id)+'boot',{host:'kaggle',stage:metadata.launch_state==='failed'?'failed':'queued',detail:metadata.launch_state==='failed'?error.message:`Kaggle SaveKernel did not confirm the submission${metadata.launch_error.upstream_status?' (HTTP '+metadata.launch_error.upstream_status+')':''}. Retry the same launch reference to check this notebook; another notebook will not be submitted.`,at:now()}).catch(()=>{});
      if(metadata.launch_state==='unknown')return json(descriptor(new URL(request.url).origin,metadata,key),202);
      throw error;
    }
  }catch(error){return errorJson(error instanceof HttpError?error:new HttpError(500,'personal_session_error','Personal Kaggle session setup failed. No owner connection was used.'));}
}

async function authenticate(request,env,id,notebook,openai=false){
  const meta=await read(env.DB,metaKey(id));
  if(!meta||Date.parse(meta.expires_at)<=Date.now())throw new HttpError(401,'personal_session_expired','This personal Kaggle session is missing or expired.');
  // OpenAI clients send Bearer auth. It is accepted only for the two explicitly
  // allowed OpenCode routes, never for notebook callbacks or the owner's API.
  const bearer=openai?/^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization')||'')?.[1]:null;
  const given=request.headers.get(notebook?'x-launch-token':'x-relay-key')??bearer;
  if(!(await equalHash(given,notebook?meta.launch_hash:meta.helper_hash)))throw new HttpError(401,'unauthorized','Wrong personal session credential.');
  return {meta,given};
}
function sessionEnv(env,id,key){return {DB:new AgentStateDB(env.DB,id),RELAY_KEY:key,AUTH_MODE:'key',MODEL:'qwen3.8-hauhau',MODEL_LABEL:'Heretic Qwen',NUM_CTX:'98304',TIMING_SCALE:env.TIMING_SCALE,AGENT_SESSION:true};}
const callbacks=new Set(['/_relay/register','/_relay/progress','/_relay/command','/_relay/log','/_relay/unregister']);

export async function routeAgentSession(request,env,ctx,url=new URL(request.url)){
  try{
    const matched=/^\/_agent\/([a-f0-9]{40})(\/.*)$/.exec(url.pathname);
    if(!matched)throw new HttpError(404,'not_found','No such personal session route.');
    const [,id,path]=matched;
    const notebook=callbacks.has(path);
    const openai=path==='/v1/chat/completions'||path==='/v1/models';
    const {meta,given}=await authenticate(request,env,id,notebook,openai);
    const db=new AgentStateDB(env.DB,id);
    if((path==='/v1/agent/step'||path==='/v1/chat/completions')&&request.method==='POST'){
      const ensureActive=async()=>{
        const current=await read(env.DB,metaKey(id));
        if(!current||Date.parse(current.expires_at)<=Date.now()||current.ended_at||current.launch_state==='failed')throw new HttpError(410,'personal_session_ended','This personal Kaggle session has ended. Start a new personal helper session.');
        if(await read(env.DB,prefix(id)+'shutdown'))throw new HttpError(409,'shutting_down','Your Kaggle notebook has been asked to stop.');
      };
      await ensureActive();
      const personalEnv=sessionEnv(env,id,given);if(meta.model)personalEnv.AGENT_MODEL_PROFILE=meta.model;
      if(path==='/v1/chat/completions')personalEnv.AGENT_CONTROL_KEY=await derived(env.RELAY_KEY,'agent-notebook:'+id);
      return await (path==='/v1/chat/completions'?openCodeChat:agentStep)({env:personalEnv,request,ctx,ensureActive});
    }
    if(path==='/v1/models'&&request.method==='GET')return openCodeModels();
    if(path==='/v1/heartbeat'&&request.method==='POST'){
      await readJsonObject(request,1024,{allowEmpty:true});
      if(meta.ended_at||meta.launch_state==='failed')throw new HttpError(410,'personal_session_ended','This personal Kaggle session has ended.');
      if(await read(env.DB,prefix(id)+'shutdown'))throw new HttpError(409,'shutting_down','Your Kaggle notebook has been asked to stop.');
      const heartbeat={at:now()};await write(env.DB,prefix(id)+'client_activity',heartbeat);
      return json({ok:true,client_active:true,idle_minutes:PERSONAL_IDLE_MINUTES});
    }
    if(path==='/v1/server/shutdown'&&request.method==='POST'){
      await write(env.DB,prefix(id)+'shutdown',{requested:true,at:now()});return json({ok:true,shutdown:'requested',owner:meta.owner});
    }
    if(path==='/v1/stop'&&request.method==='POST')return json(await requestStop(db));
    if(path==='/v1/status'&&request.method==='GET'){
      const [target,busy,boot,shutdown,heartbeat]=await Promise.all([readTarget(db),readActiveLock(db),read(env.DB,prefix(id)+'boot'),read(env.DB,prefix(id)+'shutdown'),read(env.DB,prefix(id)+'client_activity')]);
      let server='starting';
      if(meta.ended_at||meta.launch_state==='failed')server='offline';
      else if(target){const [version,ps]=await Promise.all([getJson(target.target,'/api/version',6000),getJson(target.target,'/api/ps',6000)]);server=!version?'offline':findLoadedModel(ps,'qwen3.8-hauhau')?'ready':'idle';}
      else if(boot?.stage==='failed'||meta.launch_state==='failed'||meta.ended_at)server='offline';
      return json({server,host:'kaggle',owner:meta.owner,num_ctx:target?.num_ctx??meta.model?.context??98304,num_batch:meta.model?128:256,...(meta.model?{model_profile:{source_url:meta.model.url,label:meta.model.label,context:target?.num_ctx??meta.model.context,quant:meta.model.quant,num_batch:128,profile_id:meta.model.profile_id,thinking:target?.thinking===true}}:{}),busy,boot,shutting_down:!!shutdown,client_active:!shutdown&&!meta.ended_at&&clientActive(heartbeat),idle_minutes:PERSONAL_IDLE_MINUTES,expires_at:meta.expires_at,url:meta.url,detail:shutdown?'Shutdown requested; confirm your personal notebook has stopped.':boot?.detail??(target?'Your Kaggle notebook is connected.':'Your personal notebook has not connected yet.')});
    }
    if(path==='/v1/server/log'&&request.method==='GET'){
      const logs=await read(env.DB,prefix(id)+'server_log');return json({host:'kaggle',source:'reported',owner:meta.owner,log:logs?.lines.join('\n')||'',status:logs?.status||'RUNNING',truncated:!!logs?.truncated,url:meta.url});
    }
    if(path==='/_relay/command'&&request.method==='GET'){
      const target=await readTarget(db);const shutdown=await read(env.DB,prefix(id)+'shutdown');const heartbeat=await read(env.DB,prefix(id)+'client_activity');
      const active=url.searchParams.getAll('active_generation');
      if(active.length>8||active.some(owner=>!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner)))throw new HttpError(400,'bad_generation','Invalid personal generation lease.');
      const stopGenerations=[];
      if(active.length&&target?.target===url.searchParams.get('target')){
        const holder=await read(db,'gen_lock');
        if(holder&&active.includes(holder.owner)){
          if(holder.stop||shutdown||meta.ended_at)stopGenerations.push(holder.owner);
          else await db.prepare("UPDATE state SET v = json_set(v, '$.heartbeat', ?2), updated_at = ?2 WHERE k = ?1 AND json_extract(v, '$.owner') = ?3").bind('gen_lock',now(),holder.owner).run();
        }
      }
      return json({shutdown:!!shutdown||!!meta.ended_at||meta.launch_state==='failed',reason:shutdown?'requested':meta.ended_at?'completed':null,registered:!!target&&target.target===url.searchParams.get('target'),idle_minutes:PERSONAL_IDLE_MINUTES,client_active:!shutdown&&!meta.ended_at&&meta.launch_state!=='failed'&&clientActive(heartbeat),client_idle_seconds:clientAge(heartbeat)===null?null:Math.floor(clientAge(heartbeat)/1000),stop_generations:stopGenerations,mode:'chat'});
    }
    if(request.method!=='POST')throw new HttpError(404,'not_found','No such personal session operation.');
    const body=await readJsonObject(request,path==='/_relay/log'?96*1024:16*1024);
    if(path==='/_relay/register'){
      if(meta.ended_at||meta.launch_state==='failed')throw new HttpError(410,'personal_session_ended','This personal Kaggle session has ended.');
      const matchesModel=meta.model?body.quant===meta.model.quant&&[32768,24576,16384,8192].includes(body.num_ctx)&&body.num_ctx<=meta.model.context&&body.num_batch===128&&body.profile_id===meta.model.profile_id&&typeof body.thinking==='boolean'&&body.job_max_leg_seconds===300&&body.job_control===true:body.quant==='Q5_K_P'&&body.num_ctx===98304&&body.num_batch===256;
      if(typeof body.target!=='string'||!settings(env).targetPattern.test(body.target)||body.host!=='kaggle'||!matchesModel||body.inference_transport!=='jobs-v1'||body.vision!==false||body.mode!=='chat'||body.job_max_leg_seconds!==undefined&&!validJobLegSeconds(body.job_max_leg_seconds)||body.job_control!==undefined&&typeof body.job_control!=='boolean')throw new HttpError(400,'bad_personal_profile','The notebook must match the selected personal chat-only model profile.');
      const ownerTarget=await readTarget(env.DB);
      if(ownerTarget?.target===body.target)throw new HttpError(409,'target_in_use','The owner server cannot be registered as a personal coding session.');
      const targetKey='agent:target:'+await digest(body.target);
      const reserve=await env.DB.prepare('INSERT OR IGNORE INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)').bind(targetKey,JSON.stringify({id,expires_at:meta.expires_at}),now()).run();
      const reservation=reserve.meta.changes?{id}:await read(env.DB,targetKey);
      if(reservation.id!==id)throw new HttpError(409,'target_in_use','Another personal session owns that model connection.');
      await writeTarget(db,{target:body.target,host:'kaggle',num_ctx:body.num_ctx,num_batch:body.num_batch,inference_transport:'jobs-v1',job_max_leg_seconds:body.job_max_leg_seconds,job_control:body.job_control,quant:body.quant,vision:false,control:true,...(meta.model?{profile_id:meta.model.profile_id,thinking:body.thinking}: {})});
      await env.DB.prepare('DELETE FROM state WHERE k = ?1').bind(prefix(id)+'boot').run();
      return json({ok:true});
    }
    if(path==='/_relay/progress'){
      if(body.host!=='kaggle'||!['queued','installing','downloading','loading','connecting','failed'].includes(body.stage))throw new HttpError(400,'bad_progress','Bad personal startup progress.');
      const detail=typeof body.detail==='string'?body.detail.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\bKGAT_[A-Za-z0-9_-]+\b/g,'[redacted]').split(given).join('[redacted]').slice(0,180):null;
      await write(env.DB,prefix(id)+'boot',{host:'kaggle',stage:body.stage,detail,percent:Number.isInteger(body.percent)?Math.max(0,Math.min(100,body.percent)):null,at:now()});return json({ok:true});
    }
    if(path==='/_relay/log'){
      const batch=logBatch(body,[given]);if(batch.host!=='kaggle')throw new HttpError(400,'bad_host','Only Kaggle logs are supported here.');
      const key=prefix(id)+'server_log';
      for(let attempt=0;attempt<4;attempt++){
        const row=await env.DB.prepare('SELECT v FROM state WHERE k = ?1').bind(key).first();
        const previous=row?JSON.parse(row.v):null;const next=appendLog(previous,batch);
        if(next===previous)return json({ok:true,duplicate:true});
        const changed=row?await env.DB.prepare('UPDATE state SET v = ?1, updated_at = ?2 WHERE k = ?3 AND v = ?4').bind(JSON.stringify(next),now(),key,row.v).run():await env.DB.prepare('INSERT OR IGNORE INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)').bind(key,JSON.stringify(next),now()).run();
        if(changed.meta.changes){if(['COMPLETE','ERROR'].includes(batch.status))await write(env.DB,metaKey(id),{...meta,ended_at:now()});return json({ok:true});}
      }
      throw new HttpError(503,'log_busy','Personal log is busy. Retry the batch.');
    }
    if(path==='/_relay/unregister'){
      if(typeof body.target!=='string')throw new HttpError(400,'bad_target','Missing personal server target.');
      const removed=await clearTarget(db,body.target);
      if(removed)await write(env.DB,metaKey(id),{...meta,ended_at:now()});
      return json({ok:true,removed});
    }
    throw new HttpError(404,'not_found','No such personal session operation.');
  }catch(error){return errorJson(error instanceof HttpError?error:new HttpError(500,'personal_session_error','Personal Kaggle session operation failed. No owner connection was used.'));}
}

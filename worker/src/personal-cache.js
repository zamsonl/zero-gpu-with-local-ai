// Private per-account CPU cache preparation. No Kaggle API credential is persisted
// or embedded in a notebook. Opaque upload capabilities are temporary and never returned.
import {HttpError,errorJson,json,readJsonObject} from './http.js';
import {huggingFaceSource,resolveHuggingFaceModel} from './custom-model.js';
import {createPersonalCacheSpec,personalCacheBuilderScript} from './personal-cache-source.js';
import {cleanLogLine} from './notebook-log.js';

const TOKEN=/^KGAT_[A-Za-z0-9_-]{16,251}$/,ID=/^[a-f0-9]{40}$/;
const keyFor=id=>'agent:cache:'+id;
const terminal=state=>['ready','failed','cancelled'].includes(state);
const now=()=>new Date().toISOString();
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function sign(secret,value){if(typeof secret!=='string'||secret.length<16)throw new HttpError(503,'cache_configuration','Cache preparation is not configured.');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function uploadKey(env){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.RELAY_KEY+'\0personal-cache-upload'));return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
async function sealUpload(env,upload,record){const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(record.id+':'+record.build_id)},await uploadKey(env),new TextEncoder().encode(JSON.stringify(upload))));return {iv:btoa(String.fromCharCode(...iv)),data:btoa(Array.from(cipher,byte=>String.fromCharCode(byte)).join(''))};}
async function openUpload(env,record){const raw=record.upload,iv=Uint8Array.from(atob(raw.iv),c=>c.charCodeAt(0)),data=Uint8Array.from(atob(raw.data),c=>c.charCodeAt(0));const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(record.id+':'+record.build_id)},await uploadKey(env),data);return validateUpload(JSON.parse(new TextDecoder().decode(plain)));}
async function idFor(env,owner,cacheId){return (await sign(env.RELAY_KEY,'personal-cache:'+owner.toLowerCase()+':'+cacheId)).slice(0,40);}
async function read(db,key){const row=await db.prepare('SELECT v FROM state WHERE k = ?1').bind(key).first();return row?JSON.parse(row.v):null;}
async function insert(db,key,value){return (await db.prepare('INSERT OR IGNORE INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)').bind(key,JSON.stringify(value),now()).run()).meta.changes===1;}
async function change(db,key,fn){for(let attempt=0;attempt<5;attempt++){const row=await db.prepare('SELECT v FROM state WHERE k = ?1').bind(key).first();if(!row)throw new HttpError(404,'cache_missing','The cache preparation record is missing.');const next=fn(JSON.parse(row.v));if(!next)return JSON.parse(row.v);const result=await db.prepare('UPDATE state SET v = ?1, updated_at = ?2 WHERE k = ?3 AND v = ?4').bind(JSON.stringify(next),now(),key,row.v).run();if(result.meta.changes)return next;}throw new HttpError(503,'cache_busy','Cache preparation is busy. Retry the same setup.');}
async function call(env,token,service,method,body,fetcher){
  let response;try{response=await fetcher((env.KAGGLE_API_BASE||'https://api.kaggle.com')+'/v1/'+service+'/'+method,{method:'POST',redirect:'manual',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}catch{throw new HttpError(502,'cache_kaggle_unknown','Kaggle did not confirm cache preparation. The same build will be checked; no second notebook was submitted.');}
  if(!response.ok){await response.body?.cancel();const error=new HttpError(response.status===401||response.status===403?401:response.status===404?404:502,'cache_kaggle_refused',response.status===401||response.status===403?'Kaggle did not allow this cache operation. Check your account token and Dataset permissions.':'Kaggle refused cache preparation. Check account storage and the CPU cache notebook.');error.kaggleStatus=response.status;throw error;}
  let value;try{value=await response.json();}catch{throw new HttpError(502,'cache_kaggle_unknown','Kaggle returned an unreadable cache response. Retry the same setup.');}
  if(!value||value.error)throw new HttpError(502,'cache_kaggle_unknown','Kaggle did not confirm the cache operation. Retry the same setup.');return value;
}
async function identity(env,token,fetcher){if(typeof token!=='string'||!TOKEN.test(token))throw new HttpError(400,'personal_token_required','Enter your own Kaggle API token.');const info=await call(env,token,'security.OAuthService','IntrospectToken',{token},fetcher);if(info.active!==true||!/^[A-Za-z0-9_-]{1,64}$/.test(info.username||''))throw new HttpError(401,'personal_token_invalid','The Kaggle token is not active for a valid account.');return info.username;}
function legacy(env,owner,modelUrl){const dataset=env.KAGGLE_CACHE_DATASET;if(!modelUrl&&typeof dataset==='string'&&new RegExp('^'+owner+'/[A-Za-z0-9_-]+/[1-9][0-9]*$','i').test(dataset)&&typeof env.KAGGLE_CACHE_ID==='string'&&env.KAGGLE_CACHE_ID)return {cache_id:env.KAGGLE_CACHE_ID,dataset,model:null};return null;}
function publicState(record){return {owner:record.owner,cache_id:record.cache_id,state:record.state,phase:record.phase,detail:record.detail,model_url:record.spec.model?.url||null,...(record.state==='ready'?{dataset:record.dataset}:{}),notebook_url:'https://www.kaggle.com/code/'+record.owner+'/'+record.builder_slug};}
function marker(cacheId){return 'Private coding-agent cache: '+cacheId;}
function validateUpload(upload){
  let count=0;const tokens=new Set();
  const visit=(directory,depth)=>{if(depth>3||!directory||typeof directory!=='object'||!Array.isArray(directory.files)||!Array.isArray(directory.directories))throw new HttpError(400,'invalid_cache_upload','Invalid cache upload metadata.');const files=directory.files.map(file=>{if(!file||typeof file.token!=='string'||file.token.length<8||file.token.length>8192||/[\u0000-\u0020\u007f]/.test(file.token)||tokens.has(file.token)||++count>50)throw new HttpError(400,'invalid_cache_upload','Invalid cache upload metadata.');tokens.add(file.token);return {token:file.token};});const directories=directory.directories.map(child=>{if(typeof child.name!=='string'||!/^[-A-Za-z0-9_.]{1,120}$/.test(child.name)||['.','..'].includes(child.name))throw new HttpError(400,'invalid_cache_upload','Unsafe cache upload path.');return {name:child.name,...visit(child,depth+1)};});return {files,directories};};
  const safe=visit(upload,0);if(!count)throw new HttpError(400,'invalid_cache_upload','The cache upload has no files.');return safe;
}
async function datasetInfo(env,token,record,fetcher){try{return await call(env,token,'datasets.DatasetApiService','GetDataset',{ownerSlug:record.owner,datasetSlug:record.slug},fetcher);}catch(error){if(error.status===404)return null;throw error;}}
function datasetManifest(info){return /^Manifest-SHA256: ([a-f0-9]{64})$/m.exec(info?.description||'')?.[1];}
function verifiedDataset(info,record){if(!info||info.ref?.toLowerCase()!==(record.owner+'/'+record.slug).toLowerCase()||info.isPrivate!==true||typeof info.description!=='string'||!info.description.split('\n').includes(marker(record.cache_id))||!datasetManifest(info)||record.manifest_sha256&&record.manifest_sha256!==datasetManifest(info)||!Number.isSafeInteger(info.currentVersionNumber)||info.currentVersionNumber<1)throw new HttpError(409,'cache_identity_mismatch','An unrelated or public Dataset occupies this cache name. It was not modified.');return record.owner+'/'+record.slug+'/'+info.currentVersionNumber;}

export async function readyPersonalCache({env,owner,cacheId,modelUrl=null}){
  const old=legacy(env,owner,modelUrl);if(old?.cache_id===cacheId)return old;
  if(typeof cacheId!=='string'||!/^agent-cache-v1-[a-f0-9]{32}$/.test(cacheId))throw new HttpError(400,'invalid_cache','Invalid personal cache reference.');
  const record=await read(env.DB,keyFor(await idFor(env,owner,cacheId)));
  if(record?.owner.toLowerCase()!==owner.toLowerCase()||record.cache_id!==cacheId||record.state!=='ready'||(record.spec.model?.url||null)!==modelUrl||!/^[a-f0-9]{64}$/.test(record.manifest_sha256||''))throw new HttpError(409,'personal_cache_not_ready','Your private cache is not ready for this model. Run the updated setup before starting a GPU notebook.');
  return {cache_id:cacheId,dataset:record.dataset,model:record.spec.model,spec:{...record.spec,manifest_sha256:record.manifest_sha256}};
}

export async function preparePersonalCache({request,env,fetcher=fetch,resolveModel=resolveHuggingFaceModel}){
  try{
    const body=await readJsonObject(request,8192);if(body.consent!==true)throw new HttpError(400,'consent_required','Confirm creation of a private model/runtime cache in your Kaggle account.');
    const modelUrl=body.model_url===undefined||body.model_url===''?null:huggingFaceSource(body.model_url).url,owner=await identity(env,body.kaggle_token,fetcher);
    const old=legacy(env,owner,modelUrl);if(old&&(!body.cache_id||body.cache_id===old.cache_id))return json({state:'ready',phase:'ready',detail:'Your existing private model/runtime cache will be reused.',...old,model:undefined,owner,model_url:null});
    let record,id;
    if(body.cache_id){id=await idFor(env,owner,body.cache_id);record=await read(env.DB,keyFor(id));if(!record||record.owner.toLowerCase()!==owner.toLowerCase()||(record.spec.model?.url||null)!==modelUrl)throw new HttpError(404,'cache_missing','This account has no matching cache preparation.');}
    else{
      const model=modelUrl?await resolveModel(modelUrl,{fetcher}):null,spec=await createPersonalCacheSpec(model);id=await idFor(env,owner,spec.cache_id);record=await read(env.DB,keyFor(id));
      if(!record){
        const builderSlug='heretic-agent-cache-build-'+(await sign(env.RELAY_KEY,'cache-builder:'+owner.toLowerCase())).slice(0,12);
        const created={id,owner,cache_id:spec.cache_id,spec,slug:'heretic-agent-'+spec.cache_id.split('-').at(-1),builder_slug:builderSlug,state:'creating',phase:'preparing',detail:'Preparing your private CPU cache builder. No GPU is allocated.',created_at:now(),touched_at:now(),build_id:crypto.randomUUID().replaceAll('-',''),cancel_requested:false,commit_state:null};
        if(await insert(env.DB,keyFor(id),created))record=created;else record=await read(env.DB,keyFor(id));
      }
    }
    const key=keyFor(id);record=await change(env.DB,key,r=>({...r,touched_at:now()}));
    if(body.action==='cancel'){record=await change(env.DB,key,r=>r.state==='ready'?null:({...r,state:'cancelled',phase:'cancelled',cancel_requested:true,detail:'Cancellation requested for the CPU cache build. No GPU was started.',upload:undefined}));return json(publicState(record));}
    if(terminal(record.state)&&record.state!=='ready'&&body.retry===true){
      const run=await call(env,body.kaggle_token,'kernels.KernelsApiService','GetKernelSessionStatus',{userName:owner,kernelSlug:record.builder_slug},fetcher);
      if(!['COMPLETE','ERROR','CANCELED','CANCELLED','CANCEL_ACKNOWLEDGED'].includes(String(run.status).toUpperCase()))throw new HttpError(409,'cache_build_active','The earlier CPU builder has not stopped yet. Check its notebook before retrying.');
      if(Date.now()-Date.parse(record.created_at)<120000)throw new HttpError(429,'cache_retry_limit','Wait two minutes before explicitly retrying a failed cache build.');
      record=await change(env.DB,key,r=>terminal(r.state)&&r.state!=='ready'?{...r,state:'creating',phase:'preparing',detail:'Retrying the stopped CPU cache build.',created_at:now(),build_id:crypto.randomUUID().replaceAll('-',''),cancel_requested:false,commit_state:null,upload:undefined,manifest_sha256:undefined}:null);
    }
    if(terminal(record.state)&&record.state!=='ready')return json(publicState(record));
    if(record.cancel_requested)return json(publicState(record));
    if(record.state==='ready'){
      const info=await datasetInfo(env,body.kaggle_token,record,fetcher);if(!info)throw new HttpError(409,'cache_removed','The saved private cache Dataset was removed. Check Kaggle before rebuilding.');verifiedDataset(info,record);return json(publicState(record));
    }
    if(record.state==='creating'){
      // The Dataset survives reinstalls and even a new relay database. Its
      // private, owned identity plus stored manifest hash lets us reuse it
      // without another CPU build or download.
      const existingDataset=await datasetInfo(env,body.kaggle_token,record,fetcher);
      if(existingDataset){const dataset=verifiedDataset(existingDataset,record),status=await call(env,body.kaggle_token,'datasets.DatasetApiService','GetDatasetStatus',{ownerSlug:owner,datasetSlug:record.slug},fetcher);record=await change(env.DB,key,r=>({...r,state:String(status.status).toUpperCase()==='READY'||status.status===5?'ready':'processing',phase:'processing',detail:'Reusing the existing owned private cache Dataset.',manifest_sha256:datasetManifest(existingDataset),dataset,commit_state:'confirmed'}));if(record.state==='ready')return json(publicState(record));}
    }
    if(record.state==='creating'){
      const lockKey='agent:cache-owner:'+await hash(owner.toLowerCase()),holder=await read(env.DB,lockKey);
      if(holder?.id&&holder.id!==id){const other=await read(env.DB,keyFor(holder.id));if(other&&!terminal(other.state))throw new HttpError(409,'cache_build_active','This account already has a CPU cache build running. Finish or cancel it before preparing another model.');const run=await call(env,body.kaggle_token,'kernels.KernelsApiService','GetKernelSessionStatus',{userName:owner,kernelSlug:record.builder_slug},fetcher);if(!['COMPLETE','ERROR','CANCELED','CANCELLED','CANCEL_ACKNOWLEDGED'].includes(String(run.status).toUpperCase()))throw new HttpError(409,'cache_build_active','The previous CPU cache builder is still closing. Retry when it stops.');}
      if(!holder){await insert(env.DB,lockKey,{id});}
      else if(holder.id!==id){await change(env.DB,lockKey,current=>current.id===holder.id?{id}:null);}
      const held=await read(env.DB,lockKey);if(held?.id!==id)throw new HttpError(409,'cache_build_active','This account is preparing another cache.');
      const claim=crypto.randomUUID();record=await change(env.DB,key,r=>r.state==='creating'?{...r,state:'queued',phase:'queued',detail:'Waiting for Kaggle to run the CPU cache builder. No GPU is allocated.',save_state:'sending',save_owner:claim}:null);
      if(record.save_owner===claim){
        const token=await sign(env.RELAY_KEY,'cache-callback:'+id+':'+record.build_id),relay=new URL(request.url).origin+'/_agent-cache/'+id;
        try{
          const saved=await call(env,body.kaggle_token,'kernels.KernelsApiService','SaveKernel',{slug:owner+'/'+record.builder_slug,newTitle:record.builder_slug,text:personalCacheBuilderScript(record.spec,{owner,relay,token,buildId:record.build_id}),language:'python',kernelType:'script',isPrivate:true,enableGpu:false,enableInternet:true,kernelExecutionType:'SAVE_AND_RUN_ALL',datasetDataSources:[],kernelDataSources:[],competitionDataSources:[],modelDataSources:[],categoryIds:[]},fetcher);
          record=await change(env.DB,key,r=>({...r,version:saved.versionNumber??null,save_state:'sent'}));
        }catch(error){record=await change(env.DB,key,r=>({...r,state:error.code==='cache_kaggle_refused'?'failed':'unknown',phase:'queued',detail:error.code==='cache_kaggle_refused'?'Kaggle refused the CPU cache builder. Check your token, account access and CPU availability.':'CPU launch confirmation was lost. Checking the same builder; no second notebook will be submitted.',save_state:'unknown'}));}
      }
    }
    if(['uploaded','processing'].includes(record.state)){
      let info=await datasetInfo(env,body.kaggle_token,record,fetcher);
      if(info){verifiedDataset(info,record);record=await change(env.DB,key,r=>({...r,state:'processing',phase:'processing',detail:'Kaggle is processing your private cache Dataset.',commit_state:'confirmed',upload:undefined}));}
      else if(record.state==='uploaded'&&record.upload&&!record.commit_state){
        const claim=crypto.randomUUID();record=await change(env.DB,key,r=>!r.commit_state&&!r.cancel_requested?{...r,commit_state:'sending',commit_owner:claim}:null);
        if(record.commit_owner===claim){try{await call(env,body.kaggle_token,'datasets.DatasetApiService','CreateDataset',{ownerSlug:owner,slug:record.slug,title:('Agent cache - '+(record.spec.model?.label||'Qwen 27B Q5_K_P')).slice(0,65)+' - '+record.cache_id.slice(-8),description:marker(record.cache_id)+'\nManifest-SHA256: '+record.manifest_sha256+'\nPinned model/runtime files verified before upload. Original upstream licenses apply.',licenseName:'other',isPrivate:true,...await openUpload(env,record)},fetcher);record=await change(env.DB,key,r=>({...r,state:'processing',phase:'processing',detail:'Kaggle is processing your private cache Dataset.',commit_state:'confirmed',upload:undefined}));}catch(error){const refused=error.code==='cache_kaggle_refused'&&error.kaggleStatus!==409||error.name==='OperationError'||error instanceof SyntaxError;record=await change(env.DB,key,r=>({...r,state:refused?'failed':'processing',phase:'processing',detail:refused?'Kaggle refused the private cache Dataset or its upload could not be verified. Check Dataset storage and permissions.':'Dataset creation confirmation was lost. Checking the same private Dataset; no duplicate version will be created.',commit_state:'unknown',...(refused?{upload:undefined}:{})}));}}
      }
      const status=await call(env,body.kaggle_token,'datasets.DatasetApiService','GetDatasetStatus',{ownerSlug:owner,datasetSlug:record.slug},fetcher).catch(error=>{if(error.status===404)return null;throw error;});
      if(status&&(String(status.status).toUpperCase()==='READY'||status.status===5)){
        info=await datasetInfo(env,body.kaggle_token,record,fetcher);const dataset=verifiedDataset(info,record);
        if(!/^[a-f0-9]{64}$/.test(record.manifest_sha256||''))throw new HttpError(409,'cache_manifest_missing','The cache upload was not verified. No GPU was started.');
        record=await change(env.DB,key,r=>({...r,state:'ready',phase:'ready',detail:'Your private cache is ready. Later launches reuse these files.',dataset,upload:undefined}));
      }else if(status&&['ERROR','FAILED','FAILURE'].includes(String(status.status).toUpperCase()))record=await change(env.DB,key,r=>({...r,state:'failed',phase:'processing',detail:'Kaggle could not process the cache Dataset. Check Dataset storage and its error in Kaggle.',upload:undefined}));
    }
    if(!terminal(record.state)&&Date.now()-Date.parse(record.created_at)>3*3600000)record=await change(env.DB,key,r=>({...r,state:'failed',phase:'expired',cancel_requested:true,detail:'Cache preparation exceeded its three-hour limit. No GPU was started.',upload:undefined}));
    return json(publicState(record));
  }catch(error){return errorJson(error instanceof HttpError?error:new HttpError(500,'cache_error','Private cache preparation failed. No GPU notebook was started.'));}
}

export async function personalCacheCallback({request,env,id}){
  try{
    if(!ID.test(id||''))throw new HttpError(404,'cache_missing','No cache build.');const key=keyFor(id),record=await read(env.DB,key);if(!record)throw new HttpError(404,'cache_missing','No cache build.');
    const expected=await sign(env.RELAY_KEY,'cache-callback:'+id+':'+record.build_id),provided=request.headers.get('x-cache-token')||'';
    let different=provided.length^expected.length;for(let i=0;i<expected.length;i++)different|=expected.charCodeAt(i)^(provided.charCodeAt(i)||0);if(different)throw new HttpError(401,'unauthorized','Invalid cache callback.');
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path.endsWith('/command'))return json({cancel:record.cancel_requested||terminal(record.state)||Date.now()-Date.parse(record.touched_at)>10*60000});
    if(request.method!=='POST'||!path.endsWith('/report'))throw new HttpError(404,'not_found','No cache operation.');
    const body=await readJsonObject(request,512*1024);if(body.cache_id!==record.cache_id||body.build_id!==record.build_id||!['building','uploaded','failed','cancelled'].includes(body.state))throw new HttpError(400,'invalid_cache_report','Invalid cache report.');
    const upload=body.state==='uploaded'?validateUpload(body.upload):undefined;
    if(upload&&!/^[a-f0-9]{64}$/.test(body.manifest_sha256||''))throw new HttpError(400,'invalid_cache_manifest','Invalid cache manifest.');
    const sealed=upload?await sealUpload(env,upload,record):undefined;
    await change(env.DB,key,r=>{
      if(terminal(r.state)||['uploaded','processing'].includes(r.state)&&['building','uploaded'].includes(body.state))return null;
      if(r.cancel_requested&&body.state!=='cancelled')return null;
      return {...r,state:body.state,phase:typeof body.phase==='string'?body.phase.slice(0,80):body.state,detail:cleanLogLine(String(body.detail||'Preparing the private cache'),[provided]).slice(0,500),...(sealed?{upload:sealed,manifest_sha256:body.manifest_sha256}:{}),...(['failed','cancelled'].includes(body.state)?{upload:undefined}:{})};
    });return json({ok:true});
  }catch(error){return errorJson(error instanceof HttpError?error:new HttpError(500,'cache_callback_error','Cache report failed.'));}
}

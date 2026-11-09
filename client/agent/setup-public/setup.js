const $=id=>document.getElementById(id);
const phaseLabels={idle:'Not started',checking:'Checking local tools',installing:'Installing local tools',cache:'Preparing private cache',launching:'Starting Kaggle',queued:'Waiting for Kaggle',downloading:'Downloading on Kaggle',loading:'Loading Qwen',connecting:'Connecting',ready:'Qwen is ready',running:'OpenCode is open',stopping:'Stopping',stopped:'Stopped',error:'Needs attention'};
const activePhases=new Set(['checking','installing','cache','queued','downloading','loading','connecting','ready','starting','launching','stopping','cancelling']);
const terminalPhases=new Set(['idle','stopped','error']);
let state={phase:'idle',title:'Ready when you are',detail:'Choose your project and connect your Kaggle account.',events:[],rememberedToken:false,secureStorageAvailable:true,canRetry:true};
let actionError='',initialized=false,folderEdited=false,tokenChanged=false,submitting=false,eventSignature='',eventStream=null,reconnectTimer=null,reconnectAttempt=0,streamStopped=false,serverStartedAt=null,activityTouched=false,wasActive=false;
const storageKey='heretic-qwen-setup-capability';
const fragment=location.hash.slice(1),params=new URLSearchParams(fragment);
let capability=params.get('cap')||params.get('capability')||params.get('token')||fragment;
if(!/^[A-Za-z0-9_-]{32,200}$/.test(capability||'')){try{capability=sessionStorage.getItem(storageKey)||'';}catch{capability='';}}
if(/^[A-Za-z0-9_-]{32,200}$/.test(capability||'')){try{sessionStorage.setItem(storageKey,capability);}catch{};history.replaceState(null,'',location.pathname+location.search);}else capability='';

function busy(){return activePhases.has(state.phase)||submitting;}
function setError(element,message){element.textContent=message||'';element.hidden=!message;}
function clearErrors(){actionError='';for(const name of ['folder-error','token-error','model-error','form-error'])setError($(name),'');$('folder').removeAttribute('aria-invalid');$('token').removeAttribute('aria-invalid');}
function messageOf(error){return typeof error?.message==='string'?error.message:'The local setup request could not be completed.';}
function connectionNotice(message,{retry=false}={}){$('connection-message').textContent=message||'';$('connection-notice').hidden=!message;$('reconnect').hidden=!retry;}
function accessError(){$('workspace').hidden=true;$('access-error').hidden=false;$('local-connection').textContent='Local connection unavailable';}

async function api(path,body,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options.timeout||20000);
  let response;
  try{response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+capability,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin',signal:controller.signal});}
  catch{throw new Error('The local setup is not responding. Check that your launcher is still open.');}
  finally{clearTimeout(timer);}
  let value;
  try{value=await response.json();}catch{throw new Error('The local setup returned an unreadable response.');}
  if(!response.ok){const error=new Error(typeof value.error==='string'?value.error:value.error?.message||value.message||'The setup request was not accepted.');error.status=response.status;error.code=value.error?.code||value.code;throw error;}
  return value;
}

function formatTime(time){
  const date=new Date(time||Date.now());
  return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
}
function renderEvents(events){
  const rows=Array.isArray(events)?events.slice(-200):[];
  const signature=JSON.stringify(rows);if(signature===eventSignature)return;eventSignature=signature;
  const list=$('events'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<32,oldTop=list.scrollTop;
  const anchor=[...list.children].find(row=>row.offsetTop+row.offsetHeight>oldTop),anchorId=anchor?.dataset.eventId,offset=anchor?anchor.offsetTop-oldTop:0;
  const fragment=document.createDocumentFragment();
  for(const [index,event]of rows.entries()){
    const row=document.createElement('li');row.className='event-row';row.dataset.level=event.level||'info';row.dataset.eventId=String(event.id??index+'-'+event.time+'-'+event.text);
    const time=document.createElement('time');time.className='event-time';time.textContent=formatTime(event.time||event.at||event.timestamp);if(event.time)time.dateTime=String(event.time);
    const copy=document.createElement('p');copy.className='event-copy';copy.textContent=String(event.text||event.message||'');
    row.append(time,copy);fragment.append(row);
  }
  list.replaceChildren(fragment);$('empty-activity').hidden=!!rows.length;$('event-count').textContent=rows.length?String(rows.length):'';
  if(atBottom){list.scrollTop=list.scrollHeight;$('latest').hidden=true;}
  else{const next=[...list.children].find(row=>row.dataset.eventId===anchorId);list.scrollTop=next?next.offsetTop-offset:oldTop;$('latest').hidden=false;}
}

function render(next){
  if(!next||typeof next!=='object')return;
  state={...state,...(next.state&&typeof next.state==='object'?next.state:next)};
  const phase=typeof state.phase==='string'?state.phase:'idle',isBusy=busy(),running=phase==='running';
  document.body.dataset.phase=phase;
  $('status-label').textContent=phase==='installing'&&state.source==='notebook'?'Preparing cloud runtime':state.modelUrl&&phase==='loading'?'Loading selected model':state.modelUrl&&phase==='ready'?'Model is ready':phaseLabels[phase]||'In progress';
  $('status-heading').textContent=state.title||phaseLabels[phase]||'Setup in progress';
  $('status-detail').textContent=state.detail||'';
  $('setup-fields').disabled=isBusy||running;
  $('busy-mark').hidden=!isBusy||running||phase==='stopping';
  $('stop-actions').hidden=!(isBusy||running);
  $('cancel').textContent=running?'Stop notebook':phase==='stopping'?'Stopping…':'Cancel setup';
  $('cancel').disabled=phase==='stopping';
  $('close-help').textContent=running?'You can close this setup window. Exit OpenCode to stop your notebook.':'Closing setup during startup requests cancellation after a short reconnect grace period.';
  $('start').textContent=running?'OpenCode is running':isBusy?'Starting Qwen…':phase==='error'&&state.canRetry?'Try again':'Start Qwen';
  if(!isBusy&&!running){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M4 10h12m-5-5 5 5-5 5');svg.append(path);$('start').append(svg);}
  $('start').disabled=isBusy||running||(phase==='error'&&state.canRetry===false);
  $('start-help').textContent=phase==='error'&&state.canRetry===false?'Check your Kaggle notebook before starting another session.':running?'OpenCode owns this notebook now.':'OpenCode opens when your model is ready.';
  if(!initialized){if(state.folder){$('folder').value=state.folder;folderEdited=true;}if(typeof state.browser==='boolean')$('browser').checked=state.browser;if(state.modelUrl)$('model-url').value=state.modelUrl;initialized=true;}
  if(state.folder&&!folderEdited&&document.activeElement!==$('folder'))$('folder').value=state.folder;
  const saved=!!state.rememberedToken;
  $('saved-token').hidden=!saved||tokenChanged;$('token-entry').hidden=saved&&!tokenChanged;$('saved-token-actions').hidden=!saved;
  $('remember-token').disabled=isBusy||running||state.secureStorageAvailable===false;
  const rememberHelp=$('remember-token').nextElementSibling?.querySelector('.help');
  if(rememberHelp)rememberHelp.textContent=state.secureStorageAvailable===false?'Secure storage is unavailable. The token is used for this launch only.':'Protected with your Windows account encryption.';
  if(state.secureStorageAvailable===false)$('remember-token').checked=false;
  if(state.error){const message=typeof state.error==='string'?state.error:state.error.message;setError($('form-error'),message||'Setup could not finish. Check the activity log.');}
  else if(actionError)setError($('form-error'),actionError);else if(phase!=='error')setError($('form-error'),'');
  const notebook=validNotebook(state.notebookUrl||state.url),hasIdentity=!!(notebook||state.owner);
  $('runtime-links').hidden=!hasIdentity;$('account-name').textContent=state.owner||'—';$('notebook-link').hidden=!notebook;if(notebook)$('notebook-link').href=notebook;
  const journey=['tools','cache','notebook','runtime','model','terminal'];
  const reported=['error','stopping','stopped'].includes(phase)?state.lastStage:phase;
  const step=['checking','folder','browser','token','consent'].includes(reported)?0:reported==='cache'?1:reported==='installing'?(state.source==='notebook'?3:0):['queued','launching'].includes(reported)?2:reported==='downloading'?3:reported==='loading'?4:['connecting','ready','running'].includes(reported)?5:-1;
  for(const [index,name] of journey.entries()){const row=document.querySelector('[data-step="'+name+'"]');if(!row)continue;const status=running||index<step?'complete':index===step?(phase==='error'?'error':['stopping','stopped'].includes(phase)?'stopped':'active'):'pending';row.dataset.state=status;row.querySelector('small').textContent={complete:'Done',active:'In progress',error:'Needs attention',stopped:'Stopped',pending:'Pending'}[status];}
  renderEvents(state.events);
  if(!terminalPhases.has(phase)&&!running&&!wasActive){if(!serverStartedAt)serverStartedAt=Date.now();if(!activityTouched)$('activity').open=true;}
  if(phase==='idle'&&!state.startedAt&&!state.started_at)serverStartedAt=null;
  if(state.startedAt||state.started_at){const value=new Date(state.startedAt||state.started_at).getTime();if(Number.isFinite(value))serverStartedAt=value;}
  wasActive=isBusy;
  $('troubleshoot-forget').disabled=isBusy||running||!state.rememberedToken;
  $('model-summary').textContent=$('model-url').value.trim()?'Model · Custom Hugging Face GGUF':'Model · Default Qwen 27B';
  $('launch-model').textContent=state.modelUrl?'Custom GGUF · your account':'Qwen 27B · your account';
  const loadLabel=document.querySelector('[data-step="model"] span');if(loadLabel)loadLabel.textContent=state.modelUrl?'Load selected model':'Load Qwen 27B';
  $('selected-model-name').textContent=state.modelProfile?.label||(state.modelUrl?'Custom GGUF':'Qwen 27B');
  $('selected-context').textContent=state.modelProfile?state.modelProfile.context.toLocaleString()+' tokens':state.modelUrl?'Up to 32,768 · checked on GPU':'98,304 tokens';
  if(phase==='error')$('troubleshooting').open=true;
  $('local-connection').textContent=state.connection==='retrying'?'Local setup connected · retrying the notebook connection':state.connection==='queue_unavailable'?'Kaggle status check unavailable · startup logs remain visible':'Connected to local setup';
}
function validNotebook(value){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='www.kaggle.com'&&url.pathname.startsWith('/code/')?url.href:null;}catch{return null;}}

async function refresh(){const next=await api('/api/state');render(next);return next;}
function applyActionState(value){if(value?.phase||value?.state)render(value);}

async function connectEvents(){
  if(streamStopped||!capability)return;eventStream?.abort();const controller=new AbortController();eventStream=controller;
  try{
    const response=await fetch('/api/events',{headers:{authorization:'Bearer '+capability,accept:'text/event-stream'},cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(!response.ok||!response.body)throw new Error('Live setup updates are unavailable.');
    reconnectAttempt=0;connectionNotice('');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    try{while(!controller.signal.aborted){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});if(buffer.length>512*1024)throw new Error('Live setup updates exceeded the allowed size.');let boundary;
      while((boundary=buffer.search(/\r?\n\r?\n/))>=0){const match=/\r?\n\r?\n/.exec(buffer.slice(boundary));const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+match[0].length);const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;let value;try{value=JSON.parse(data);}catch{throw new Error('Live setup returned an unreadable update.');}if(value&&typeof value==='object'&&(value.phase||value.state))render(value);}
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!controller.signal.aborted)throw new Error('Live setup updates disconnected.');
  }catch(error){if(controller.signal.aborted||streamStopped)return;reconnectAttempt++;if(reconnectAttempt>6){connectionNotice('Live updates paused. Your last reported stage is shown.',{retry:true});$('local-connection').textContent='Live updates paused';return;}connectionNotice('Live updates disconnected. Reconnecting…');$('local-connection').textContent='Reconnecting to local setup…';clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>{void refresh().catch(()=>{});void connectEvents();},Math.min(1000*2**(reconnectAttempt-1),10000));}
}

$('folder').addEventListener('input',()=>{folderEdited=true;$('folder').removeAttribute('aria-invalid');setError($('folder-error'),'');});
$('browse').addEventListener('click',async()=>{
  clearErrors();const button=$('browse');button.disabled=true;button.setAttribute('aria-busy','true');
  try{const result=await api('/api/folder',{}, {timeout:300000});if(result.folder){$('folder').value=result.folder;folderEdited=true;}if(result.cancelled)$('folder').focus();applyActionState(result);}
  catch(error){setError($('folder-error'),messageOf(error));}
  finally{button.disabled=busy()||state.phase==='running';button.removeAttribute('aria-busy');}
});
$('open-kaggle').addEventListener('click',async()=>{try{await api('/api/open-kaggle',{});}catch(error){actionError=messageOf(error);setError($('form-error'),actionError);}});
$('troubleshoot-forget').addEventListener('click',()=>{$('forget-dialog').showModal();});
$('model-url').addEventListener('input',()=>{setError($('model-error'),'');$('model-summary').textContent=$('model-url').value.trim()?'Model · Custom Hugging Face GGUF':'Model · Default Qwen 27B';});
$('change-token').addEventListener('click',()=>{tokenChanged=true;render(state);$('token').focus();});
$('reveal-token').addEventListener('click',()=>{const show=$('token').type==='password';$('token').type=show?'text':'password';$('reveal-token').setAttribute('aria-label',show?'Hide token':'Show token');$('reveal-token').title=show?'Hide token':'Show token';});
$('forget-token').addEventListener('click',()=>{$('forget-dialog').showModal();});
$('forget-dialog').addEventListener('close',async()=>{if($('forget-dialog').returnValue!=='forget')return;try{const result=await api('/api/forget-token',{});tokenChanged=false;state.rememberedToken=false;render(result?.phase||result?.state?result:state);$('token').focus();}catch(error){actionError=messageOf(error);setError($('form-error'),actionError);}});
$('setup-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy()||state.phase==='running'||state.canRetry===false&&state.phase==='error')return;clearErrors();
  const folder=$('folder').value.trim(),token=$('token').value.trim(),modelUrl=$('model-url').value.trim();
  if(modelUrl){let valid=false;try{const u=new URL(modelUrl);valid=u.protocol==='https:'&&u.hostname==='huggingface.co'&&!u.port&&!u.username&&!u.password&&!u.hash&&[...u.searchParams].every(([k,v])=>k==='download'&&v==='true');}catch{}if(!valid){$('model-options').open=true;setError($('model-error'),'Hugging Face GGUF only. Paste a public https://huggingface.co/… model link without credentials.');$('model-url').focus();return;}}
  if(!folder){setError($('folder-error'),'Choose the project folder you want Qwen to work in.');$('folder').setAttribute('aria-invalid','true');$('folder').focus();return;}
  if((!state.rememberedToken||tokenChanged)&&!/^KGAT_[A-Za-z0-9_-]{16,251}$/.test(token)){setError($('token-error'),'Paste the complete modern API token beginning with KGAT_.');$('token').setAttribute('aria-invalid','true');$('token').focus();return;}
  if(!$('gpu-consent').checked){setError($('form-error'),'Confirm using your own Kaggle GPU allowance before starting.');$('gpu-consent').focus();return;}
  const payload={folder,modelUrl,token:(!state.rememberedToken||tokenChanged)?token:'',rememberToken:state.rememberedToken&&!tokenChanged?true:$('remember-token').checked&&state.secureStorageAvailable!==false,browser:$('browser').checked,installConsent:$('install-consent').checked,gpuConsent:true};
  submitting=true;serverStartedAt=Date.now();render(state);
  try{const result=await api('/api/start',payload,{timeout:30000});$('token').value='';payload.token='';applyActionState(result);if(!result?.phase&&!result?.state)await refresh();}
  catch(error){payload.token='';$('token').value='';actionError=messageOf(error);setError($('form-error'),actionError);try{await refresh();}catch{};}
  finally{submitting=false;render(state);}
});
$('cancel').addEventListener('click',async()=>{if(state.phase==='stopping')return;$('cancel').disabled=true;try{const result=await api('/api/cancel',{});applyActionState(result);if(!result?.phase&&!result?.state)await refresh();}catch(error){actionError=messageOf(error);setError($('form-error'),actionError);$('cancel').disabled=false;}});
$('reconnect').addEventListener('click',async()=>{reconnectAttempt=0;connectionNotice('Reconnecting…');try{await refresh();await connectEvents();}catch(error){connectionNotice(messageOf(error),{retry:true});}});
$('activity').addEventListener('toggle',()=>{if(initialized)activityTouched=true;});
$('events').addEventListener('scroll',()=>{if($('events').scrollHeight-$('events').scrollTop-$('events').clientHeight<28)$('latest').hidden=true;});
$('latest').addEventListener('click',()=>{$('events').scrollTop=$('events').scrollHeight;$('latest').hidden=true;});

setInterval(()=>{if(!serverStartedAt){$('elapsed').textContent='';return;}const seconds=Math.max(0,Math.floor(((state.endedAt?new Date(state.endedAt).getTime():Date.now())-serverStartedAt)/1000));$('elapsed').textContent=seconds<60?seconds+'s elapsed':Math.floor(seconds/60)+'m '+String(seconds%60).padStart(2,'0')+'s elapsed';},1000);
const ping=async()=>{if(!capability)return;try{await api('/api/ping',{});}catch{}};
setInterval(()=>{void ping();},10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void ping();});
window.addEventListener('beforeunload',event=>{if(activePhases.has(state.phase)&&state.phase!=='running'){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{streamStopped=true;eventStream?.abort();clearTimeout(reconnectTimer);$('token').value='';if(capability)navigator.sendBeacon('/api/leave',new Blob([JSON.stringify({capability})],{type:'application/json'}));});

if(matchMedia('(max-width:720px)').matches)$('activity').open=false;
if(!capability)accessError();
else{try{await refresh();await ping();void connectEvents();}catch(error){if(error.status===401||error.status===403)accessError();else connectionNotice(messageOf(error),{retry:true});}}

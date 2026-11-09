const $=id=>document.getElementById(id);
const key='qwen-local-'+location.port;
let token=location.hash.slice(1)||sessionStorage.getItem(key)||'';
if(location.hash){sessionStorage.setItem(key,token);history.replaceState(null,'',location.pathname);}
let state=null,lastEvent=0,pendingId=null,currentPath='',polling=false,submitting=false,viewEpoch=0,viewImageUrl=null;
async function api(route,body){const response=await fetch('/api/'+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error||'Request failed.');return value;}
function error(message){$('error').textContent=message;$('error').hidden=false;setTimeout(()=>$('error').hidden=true,8000);}
function node(tag,text,cls){const element=document.createElement(tag);element.textContent=text;if(cls)element.className=cls;return element;}
function clearImage(){if(viewImageUrl){URL.revokeObjectURL(viewImageUrl);viewImageUrl=null;}$('view-image').hidden=true;$('view-content').hidden=false;}
async function showBrowserImage(id){
  if(!/^[A-Za-z0-9-]{36}$/.test(id))return;
  try{const response=await fetch('/api/browser/screenshot/'+id,{headers:{authorization:'Bearer '+token}});if(!response.ok)throw new Error('This screenshot is no longer available.');const bytes=await response.blob();clearImage();viewImageUrl=URL.createObjectURL(bytes);$('view-image').src=viewImageUrl;$('view-image').hidden=false;$('view-content').hidden=true;$('view-title').textContent='Local browser screenshot';$('viewer').showModal();}catch(e){error(e.message);}
}
async function files(dir=''){
  try{
    const page=await api('files?path='+encodeURIComponent(dir));const entries=page.entries??page;currentPath=dir;$('breadcrumbs').replaceChildren();
    if(dir){const up=node('button','← Parent folder');up.onclick=()=>files(dir.split('/').slice(0,-1).join('/'));$('breadcrumbs').append(up);}
    $('breadcrumbs').append(node('span',dir||'Workspace root'));$('files').replaceChildren();
    if(page.truncated)$('files').append(node('p','Showing the first 400 entries. Open a subfolder or use Qwen search.','muted small'));
    for(const entry of entries){const button=node('button','','file');button.append(node('span',entry.type==='folder'?'▸':'·'),node('span',entry.name));button.onclick=async()=>{if(entry.type==='folder')return files(entry.path);try{const file=await api('file?path='+encodeURIComponent(entry.path));clearImage();$('view-title').textContent=file.path;$('view-content').textContent=file.content;$('viewer').showModal();}catch(e){error(e.message);}};$('files').append(button);}
    if(!entries.length)$('files').append(node('p','No accessible files here.','muted small'));
  }catch(e){error(e.message);}
}
function review(pending){
  pendingId=pending?.id||null;$('approval').hidden=!pending;if(!pending)return;
  const command=pending.action==='terminal',browser=pending.action.startsWith('browser_');$('approval-title').textContent=command?'Review terminal command':browser?'Review browser action':'Review edit · '+pending.path;$('approval-why').textContent=pending.message;$('command-warning').hidden=!command&&!browser;$('command-warning').textContent=browser?'This navigation or interaction can contact websites, submit data, or change an account. Approve only the exact displayed action.':'This command runs with your Windows user permissions. Its working folder is selected above, but it can access other locations. Approve only commands you understand.';$('approve').textContent=command?'Run command':browser?'Allow browser action':'Apply edit';$('review').replaceChildren();
  const figure=(title,content)=>{const element=document.createElement('figure');element.append(node('figcaption',title),node('pre',content));$('review').append(element);};
  if(command)figure('PowerShell command',pending.command);else if(browser)figure('Exact browser action',JSON.stringify(pending.browser_review,null,2));else{figure('Current file',pending.before||'(new file)');figure('Proposed replacement',pending.content);}
  $('approve').disabled=false;$('reject').disabled=false;
}
async function refresh(){
  if(polling)return;polling=true;
  const epoch=viewEpoch;
  try{
    const next=await api('state');if(epoch!==viewEpoch)return;const cloudBlocked=next.cloud&&(next.cloud.server!=='ready'||next.cloud.shutting_down);$('folder').textContent=next.folder;$('phase').textContent=next.phase;$('stop').disabled=!next.busy;$('send').disabled=next.busy||submitting||!!cloudBlocked;$('new').disabled=next.busy||submitting;
    $('cloud').hidden=!next.cloud;if(next.cloud){$('cloud-owner').textContent=next.cloud.owner;$('cloud-state').textContent=next.cloud.detail||next.cloud.server;$('cloud-shutdown').disabled=!!next.cloud.shutdown_acknowledged;$('cloud-shutdown').textContent=next.cloud.shutdown_error?'Retry Kaggle shutdown':'Shut down my Kaggle server';}
    if(state&&(next.session_id!==state.session_id||next.events.length===0&&state.events.length)){$('events').replaceChildren();lastEvent=0;}
    for(const event of next.events){if(event.id<=lastEvent)continue;if(lastEvent===0)$('events').replaceChildren();const atBottom=$('events').scrollHeight-$('events').scrollTop-$('events').clientHeight<80;const item=node('article','','event '+event.kind);item.append(node('span',event.kind==='user'?'You':event.kind==='assistant'?'Qwen · '+event.action:event.kind==='tool'?'Tool result · '+event.action:'Attention','by'));if(event.kind==='tool'){const details=document.createElement('details');details.append(node('summary',event.path||'View result'),node('pre',event.text));item.append(details);if(event.action==='browser_screenshot'){try{const image=JSON.parse(event.text);if(image.image_id){const button=node('button','View local screenshot');button.onclick=()=>showBrowserImage(image.image_id);item.append(button);}}catch{}}}else item.append(node('p',event.text));$('events').append(item);lastEvent=event.id;if(atBottom)$('events').scrollTop=$('events').scrollHeight;}
    if((next.pending?.id||null)!==pendingId)review(next.pending);state=next;
  }catch(e){$('phase').textContent=e.message;}finally{polling=false;}
}
$('task-form').onsubmit=async event=>{event.preventDefault();if(submitting||state?.busy||state?.cloud&&(state.cloud.server!=='ready'||state.cloud.shutting_down))return;const draft=$('task').value,task=draft.trim();if(!task)return;submitting=true;$('send').disabled=true;$('new').disabled=true;try{await api('task',{task});if($('task').value===draft)$('task').value='';await refresh();}catch(e){error(e.message);}finally{submitting=false;$('send').disabled=!!state?.busy||!!(state?.cloud&&(state.cloud.server!=='ready'||state.cloud.shutting_down));$('new').disabled=!!state?.busy;}};
$('task').onkeydown=event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey))$('task-form').requestSubmit();};
for(const [id,approve]of [['approve',true],['reject',false]])$(id).onclick=async()=>{const own=pendingId;$('approve').disabled=true;$('reject').disabled=true;try{await api('decide',{id:own,approve});await refresh();if(approve)await files(currentPath);}catch(e){error(e.message);$('approve').disabled=false;$('reject').disabled=false;}};
$('stop').onclick=async()=>{try{await api('stop',{});await refresh();}catch(e){error(e.message);}};
$('cloud-shutdown').onclick=async()=>{if(!state?.cloud)return;try{$('cloud-shutdown').disabled=true;await api('cloud/shutdown',{});await refresh();}catch(e){error(e.message);$('cloud-shutdown').disabled=false;}};
$('new').onclick=async()=>{try{await api('reset',{});viewEpoch++;state=null;lastEvent=0;$('events').replaceChildren();review(null);await refresh();}catch(e){error(e.message);}};
$('refresh').onclick=()=>files(currentPath);$('close-view').onclick=()=>{clearImage();$('viewer').close();};$('viewer').onclose=clearImage;
await refresh();await files();setInterval(()=>{if(!document.hidden)void refresh();},1000);

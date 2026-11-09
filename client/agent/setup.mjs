import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {launchOpenCode,openProjectFolder,openKaggleTokenPage,chooseBrowserChannel} from './opencode.mjs';
import {cleanChildEnvironment,OPENCODE_VERSION,PLAYWRIGHT_MCP_VERSION} from './opencode-config.mjs';
import {DEFAULT_CREDENTIAL_PATH,secureTokenStorageAvailable,forgetKaggleToken} from './credential-store.mjs';
import {validateModelUrl} from './kaggle-session.mjs';
import {chooseModernFolder} from './folder-picker.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const ACTIVE=new Set(['checking','installing','cache','queued','downloading','loading','connecting','ready','running','stopping']);
const TITLES={idle:'Set up your coding workspace',checking:'Checking your local tools',installing:'Installing local tools',cache:'Preparing your private Kaggle cache',launching:'Starting your Kaggle notebook',queued:'Waiting for Kaggle startup',downloading:'Downloading the cloud runtime',loading:'Loading Qwen on the GPUs',connecting:'Connecting to Qwen',ready:'Opening OpenCode',running:'OpenCode is open',stopping:'Stopping your personal session',stopped:'Session closed',error:'Setup needs attention'};
export function safeSetupText(value){return String(value??'').replace(/\bKGAT_[A-Za-z0-9_-]+\b/g,'[redacted]').replace(/\b[a-f0-9]{64}\b/gi,'[redacted]').replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\S*/gi,'[private model connection]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,2000);}
function failure(message,code='setup_error',status=400){return Object.assign(new Error(message),{code,status});}
async function remembered(file=DEFAULT_CREDENTIAL_PATH){try{const s=await fs.lstat(file);return s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=16384;}catch{return false;}}
async function readPreferences(file){try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)return {};const v=JSON.parse(await fs.readFile(file,'utf8'));return {folder:typeof v.folder==='string'?v.folder.slice(0,32768):'',browser:v.browser!==false,modelUrl:typeof v.modelUrl==='string'?validateModelUrl(v.modelUrl):'',...(/^[A-Za-z0-9_-]{16,80}$/.test(v.pendingLaunch?.id||'')?{pendingLaunch:{id:v.pendingLaunch.id,modelUrl:validateModelUrl(v.pendingLaunch.modelUrl||'')}}:{})};}catch{return {};}}

export async function createSetupController(deps={}){
  const preferenceFile=deps.preferenceFile||path.join(os.homedir(),'.qwen','setup-preferences.json');
  const preferences=await readPreferences(preferenceFile);
  let pendingLaunch=preferences.pendingLaunch||null;
  let state={phase:'idle',title:TITLES.idle,detail:pendingLaunch?'An earlier launch needs confirmation. Check the same saved launch before starting another notebook.':'Choose your project, connect Kaggle, then open OpenCode.',retrySameLaunch:!!pendingLaunch,folder:preferences.folder||'',browser:preferences.browser!==false,modelUrl:preferences.modelUrl||'',rememberedToken:await (deps.hasRememberedToken||remembered)(),secureStorageAvailable:secureTokenStorageAvailable(),canRetry:true,running:false,events:[],error:null};
  let sequence=0,active=false,abort=null,launch=null,work=null,closed=false,uncertain=false,pickerAbort=null,lastProgress='';const listeners=new Map();
  const snapshot=()=>structuredClone(state);
  const publish=()=>{for(const [listener,needsSnapshot] of listeners){try{listener(needsSnapshot?snapshot():undefined);}catch{}}};
  const set=(patch)=>{state={...state,...patch};publish();};
  const event=(text,{stage=state.phase,level='info',source}={})=>{const line=safeSetupText(text);if(!line)return;state.events.push({id:++sequence,time:new Date().toISOString(),level,stage,text:line,...(source?{source}:{})});state.events=state.events.slice(-180);publish();};
  const progress=value=>{
    if(!value||closed)return;
    let phase=value.stage;
    if(['folder','browser','token','consent'].includes(phase))phase='checking';
    if(!(phase in TITLES))phase=state.phase;
    if(phase==='running')phase=state.running?'running':'ready';
    if(value.state==='error')phase='error';
    if(state.phase==='stopping'&&!['stopped','error'].includes(phase))return;
    const detail=safeSetupText(value.detail||TITLES[phase]);
    const patch={phase,title:phase==='installing'&&value.source==='notebook'?'Preparing the cloud runtime':state.modelUrl&&phase==='loading'?'Loading your selected model on the GPUs':state.modelUrl&&phase==='connecting'?'Connecting to your selected model':TITLES[phase],detail,connection:value.connection||null,source:value.source||null,lastStage:value.stage,percent:Number.isFinite(value.percent)?Math.max(0,Math.min(100,value.percent)):null};
    if(typeof value.owner==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value.owner))patch.owner=value.owner;
    if(typeof value.notebookUrl==='string'&&/^https:\/\/www\.kaggle\.com\/code\/[A-Za-z0-9_/-]+$/.test(value.notebookUrl))patch.notebookUrl=value.notebookUrl;
    set(patch);const key=JSON.stringify([value.stage,detail,value.line||'',value.percent??null,value.connection||null,value.source||null]);if(key===lastProgress)return;lastProgress=key;event(value.line||detail,{stage:value.stage,level:value.state==='error'?'error':'info',source:value.source});
  };
  const savePreferences=async()=>{await fs.mkdir(path.dirname(preferenceFile),{recursive:true});const temporary=preferenceFile+'.'+randomBytes(8).toString('hex')+'.tmp';try{await fs.writeFile(temporary,JSON.stringify({version:1,folder:state.folder,browser:state.browser,modelUrl:state.modelUrl,...(pendingLaunch?{pendingLaunch}:{})})+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,preferenceFile);}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}};
  const controller={
    snapshot,subscribe(fn,{snapshot:needsSnapshot=true}={}){listeners.set(fn,needsSnapshot);return()=>listeners.delete(fn);},get busy(){return active;},get work(){return work;},get running(){return state.running;},
    async folder(input={}){if(active||pickerAbort)throw failure('Stop the current setup before changing its project.','setup_busy',409);pickerAbort=new AbortController();try{if(input.path!==undefined&&(typeof input.path!=='string'||input.path.length>32768))throw failure('Choose an existing project folder.');const selected=input.path?.trim()||await(deps.chooseFolder||chooseModernFolder)({initialFolder:state.folder,signal:deps.signal?AbortSignal.any([deps.signal,pickerAbort.signal]):pickerAbort.signal});if(!selected||pickerAbort.signal.aborted)return {folder:state.folder,cancelled:true};const folder=await(deps.openFolder||openProjectFolder)(selected);set({folder});await savePreferences();return {folder,cancelled:false};}finally{pickerAbort=null;}},
    async forgetToken(){if(active)throw failure('Stop the current setup before changing credentials.','setup_busy',409);await(deps.forgetToken||forgetKaggleToken)();set({rememberedToken:false});event('Saved Kaggle token removed. No notebook was started.');return snapshot();},
    async openKaggle(){await(deps.openTokenPage||openKaggleTokenPage)({log:()=>{}});return {opened:true};},
    terminalStarted(){if(!active||abort?.signal.aborted)return;set({phase:'running',title:TITLES.running,detail:'You can close this setup window. Exit OpenCode to stop your personal notebook.',running:true});event('OpenCode started in its own terminal. Your project and account history are retained.');},
    start(input){
      if(closed||active||pickerAbort)throw failure('A setup or coding session is already active.','setup_busy',409);
      if(!input||typeof input!=='object'||Array.isArray(input))throw failure('Supply your setup choices.');
      for(const key of Object.keys(input))if(!['folder','token','rememberToken','browser','installConsent','gpuConsent','modelUrl'].includes(key))throw failure('Unsupported setup choice.');
      if(typeof input.folder!=='string'||!input.folder.trim()||input.folder.length>32768)throw failure('Choose an existing project folder.','folder_required');
      if(input.gpuConsent!==true)throw failure('Confirm using your own Kaggle GPU allowance before starting.','consent_required');
      if(input.token!==undefined&&(typeof input.token!=='string'||input.token.length>300))throw failure('Enter your Kaggle token in the password field.','invalid_token');
      let token=(input.token||'').trim();input.token='';
      if(token&&!/^KGAT_[A-Za-z0-9_-]{16,251}$/.test(token))throw failure('Enter a modern Kaggle API token starting with KGAT_.','invalid_token');
      if(!token&&!state.rememberedToken)throw failure('Enter your Kaggle API token, or create one using Open token settings.','token_required');
      const modelUrl=validateModelUrl(input.modelUrl===undefined?'':input.modelUrl);
      if(pendingLaunch&&pendingLaunch.modelUrl!==modelUrl)throw failure('Retry the pending launch with its original model before choosing another model. This prevents a duplicate notebook.','launch_model_pending',409);
      const retrying=!!pendingLaunch;set({retrySameLaunch:retrying});
      pendingLaunch??={id:randomBytes(16).toString('hex'),modelUrl};
      lastProgress='';active=true;uncertain=false;abort=new AbortController();let blockedInstall=false;
      set({phase:'checking',title:TITLES.checking,detail:'Validating the selected project and reviewed local tools.',folder:input.folder.trim(),modelUrl,browser:input.browser!==false,running:false,canRetry:false,error:null,notebookUrl:null,owner:null,percent:null,startedAt:new Date().toISOString(),endedAt:null});event('Setup started. GPU usage requires your confirmed personal account.');
      const args=['--setup','--launch-id',pendingLaunch.id,'--folder',state.folder,...(modelUrl?['--model-url',modelUrl]:[]),...(!state.browser?['--no-browser']:[]),...(input.rememberToken===false?['--no-remember-token']:[])];
      work=(async()=>{
        try{
          // Persist the non-secret identity before any remote launch. Explicit
          // retries, including after closing this UI, reconcile this same job.
          await savePreferences();
          if(retrying)event('Retrying the saved launch reference. The connector checks the same notebook before any new allocation.');
          const folder=await(deps.openFolder||openProjectFolder)(state.folder);set({folder});args[args.indexOf('--folder')+1]=folder;await savePreferences();
          const launchDeps={...deps.launchDependencies,isInteractive:()=>true,signal:abort.signal,log:line=>event(line),onProgress:progress,
            askSetup:async question=>{if(!question.startsWith('Install the missing reviewed local tools:'))return false;blockedInstall=input.installConsent!==true;return !blockedInstall;},
            promptToken:async()=>token,confirmUsage:async()=>input.gpuConsent===true,
            ...(token?{loadSavedToken:async()=>null}:{}),
            ...(deps.spawnTerminal?{spawnProcess:deps.spawnTerminal}:{}),
          };
          launch=await(deps.launch||launchOpenCode)(args,launchDeps);token='';
          set({rememberedToken:await(deps.hasRememberedToken||remembered)()});
          if(!launch){pendingLaunch=null;await savePreferences();set({retrySameLaunch:false});set({phase:'stopped',title:TITLES.stopped,detail:abort.signal.aborted?'Setup cancelled. Shutdown was requested for any confirmed personal notebook.':blockedInstall?'Missing local tools need your approval. Select Allow installing missing local tools, then start again.':'Setup did not start a coding session. Review required tool installation and try again.',canRetry:true,running:false,endedAt:new Date().toISOString()});return;}
          if(abort.signal.aborted)await launch.close();
          if(launch.session)set({owner:launch.session.owner,notebookUrl:launch.session.url,modelProfile:launch.session.model_profile||null});
          if(!state.running&&!abort.signal.aborted)set({phase:'ready',title:TITLES.ready,detail:'Starting the reviewed OpenCode terminal with your private Qwen connection.'});
          const result=await launch.done;
          pendingLaunch=null;await savePreferences();set({retrySameLaunch:false});
          set({phase:result?.code===0||abort.signal.aborted?'stopped':'error',title:result?.code===0||abort.signal.aborted?TITLES.stopped:TITLES.error,detail:result?.code===0||abort.signal.aborted?'OpenCode closed. Shutdown was requested; check Kaggle to confirm it stopped.':'OpenCode exited with an error. Shutdown was requested; review the event log and check Kaggle.',running:false,canRetry:true,endedAt:new Date().toISOString()});
        }catch(error){
          token='';uncertain=typeof error?.launchUncertain==='boolean'?error.launchUncertain:/unconfirmed|uncertain|did not confirm|could not be confirmed|check your own kaggle|launch confirmation|unreadable personal-session|invalid personal kaggle|invalid personal-session/i.test(error?.message||'')||error?.code==='kaggle_unknown';
          if(!uncertain)pendingLaunch=null;
          await savePreferences().catch(()=>{});
          const message=safeSetupText(error?.message||'Setup failed. Review the last completed stage.');
          set({phase:abort.signal.aborted?'stopped':'error',title:abort.signal.aborted?TITLES.stopped:TITLES.error,detail:message+(uncertain?' Retry checks the same saved launch reference.':''),retrySameLaunch:uncertain,running:false,canRetry:true,endedAt:new Date().toISOString(),error:{message,code:typeof error?.code==='string'?error.code:'setup_failed'}});event(message,{level:'error'});
        }finally{token='';launch=null;active=false;publish();}
      })();
      return snapshot();
    },
    async cancel(){pickerAbort?.abort();if(!active)return snapshot();set({phase:'stopping',title:TITLES.stopping,detail:'Cancelling local work and requesting shutdown of this personal notebook.'});abort.abort();await launch?.close();return snapshot();},
    async close(){if(closed)return;await controller.cancel();await work;closed=true;listeners.clear();},
  };
  return controller;
}

export function windowsArgument(value){const text=String(value);return '"'+text.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\*)$/,'$1$1')+'"';}
export function spawnTerminalHost({origin,capability,folder,spawnProcess=spawn,platform=process.platform}){
  const host=path.join(HERE,'terminal-host.mjs');
  if(platform!=='win32')throw failure('This guided terminal handoff currently supports Windows. Run node opencode.mjs --setup in your terminal on this system.');
  const script="$ErrorActionPreference='Stop';try{$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=New-Object System.Diagnostics.ProcessStartInfo;$s.FileName=$p.file;$s.Arguments=$p.arguments;$s.WorkingDirectory=$p.cwd;$s.UseShellExecute=$true;$s.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Normal;$c=[System.Diagnostics.Process]::Start($s);if(!$c){throw 'Start failed'};$c.WaitForExit();exit $c.ExitCode}catch{[Console]::Error.Write('The OpenCode terminal could not be opened.');exit 1}";
  const binary=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawnProcess(binary,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','ignore','pipe'],env:cleanChildEnvironment()});
  child.stderr?.resume();child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify({file:process.execPath,arguments:[host,origin,capability].map(windowsArgument).join(' '),cwd:folder}));return child;
}

export async function startSetupServer(options={}){
  const capability=randomBytes(32).toString('hex'),terminals=new Map(),clients=new Set();let origin,leaveAt=null,timer,publishTimer,lastPing=Date.now(),shutting=false;
  const controller=await createSetupController({...options.controllerDependencies,spawnTerminal:(command,args,spawnOptions)=>{
    const hostKey=randomBytes(32).toString('hex');terminals.set(hostKey,{payload:{command,args,env:spawnOptions.env,cwd:spawnOptions.cwd},used:false});
    const child=(options.spawnTerminalHost||spawnTerminalHost)({origin,capability:hostKey,folder:spawnOptions.cwd});child.once('close',()=>terminals.delete(hostKey));child.once('error',()=>terminals.delete(hostKey));return child;
  }});
  const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
  const read=async(req)=>{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>65536)throw failure('Setup request exceeds its limit.','body_limit',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw failure('Expected a JSON setup request.');}if(!value||typeof value!=='object'||Array.isArray(value))throw failure('Expected setup choices.');return value;};
  const notify=()=>{if(publishTimer)return;publishTimer=setTimeout(()=>{publishTimer=null;const bytes='event: state\ndata: '+JSON.stringify(controller.snapshot())+'\n\n';for(const response of clients){if(response.writableLength>512*1024){response.destroy();continue;}response.write(bytes);}},100);};
  const unsubscribe=controller.subscribe(notify,{snapshot:false});
  const server=http.createServer(async(req,res)=>{
    const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return json(403,{error:{message:'Wrong local setup origin.'}});
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
      const url=new URL(req.url,origin),given=(req.headers.authorization||'').replace(/^Bearer /,'');
      if(url.pathname.startsWith('/terminal/')){
        const entry=terminals.get(given);if(!entry)return json(401,{error:{message:'Invalid terminal handoff.'}});
        if(url.pathname==='/terminal/bootstrap'&&req.method==='GET'&&!entry.used){entry.used=true;const payload=entry.payload;entry.payload=null;return json(200,payload);}
        if(url.pathname==='/terminal/started'&&req.method==='POST'&&entry.used){const report=await read(req);if(report.tty!==true){void controller.cancel();throw failure('OpenCode did not receive an interactive terminal.','terminal_unavailable',409);}controller.terminalStarted();return json(200,{ok:true});}
        return json(409,{error:{message:'The terminal handoff is already consumed.'}});
      }
      if(!url.pathname.startsWith('/api/')){
        if(req.method!=='GET')return json(405,{error:{message:'Expected GET.'}});
        const asset={'/':'index.html','/setup.js':'setup.js','/setup.css':'setup.css','/logo.svg':'logo.svg','/mark.png':'mark.png'}[url.pathname];if(!asset)return json(404,{error:{message:'Not found.'}});
        const content=await fs.readFile(path.join(HERE,'setup-public',asset));res.writeHead(200,{'content-type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}[path.extname(asset)],'cache-control':'no-store'});return res.end(content);
      }
      let input;
      if(url.pathname==='/api/leave'&&req.method==='POST'){input=await read(req);if(!same(input.capability,capability))return json(401,{error:{message:'Invalid setup session.'}});}else if(!same(given,capability))return json(401,{error:{message:'Open setup using its private launch window.'}});
      if(req.method==='GET'&&url.pathname==='/api/state')return json(200,controller.snapshot());
      if(req.method==='GET'&&url.pathname==='/api/events'){
        leaveAt=null;lastPing=Date.now();res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store, no-transform','x-accel-buffering':'no'});res.write('event: state\ndata: '+JSON.stringify(controller.snapshot())+'\n\n');clients.add(res);
        req.once('close',()=>{clients.delete(res);if(!clients.size)leaveAt=Date.now()+10000;});return;
      }
      if(req.method!=='POST'||!(req.headers['content-type']||'').startsWith('application/json'))return json(405,{error:{message:'Expected a JSON POST.'}});
      input??=await read(req);
      if(url.pathname==='/api/ping'){leaveAt=null;lastPing=Date.now();return json(200,{ok:true});}
      if(url.pathname==='/api/leave'){leaveAt=Date.now()+10000;return json(200,{ok:true});}
      if(url.pathname==='/api/folder')return json(200,await controller.folder(input));
      if(url.pathname==='/api/open-kaggle')return json(200,await controller.openKaggle());
      if(url.pathname==='/api/forget-token')return json(200,await controller.forgetToken());
      if(url.pathname==='/api/start')return json(202,controller.start(input));
      if(url.pathname==='/api/cancel'){void controller.cancel();return json(202,controller.snapshot());}
      return json(404,{error:{message:'No such setup action.'}});
    }catch(error){if(!res.headersSent)json(error.status||400,{error:{message:safeSetupText(error.message),code:error.code||'setup_error'}});else res.end();}
  });
  server.headersTimeout=10000;server.requestTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port||0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
  let closing;
  const close=()=>closing||=(async()=>{shutting=true;clearInterval(timer);clearTimeout(publishTimer);unsubscribe();await controller.close();terminals.clear();for(const response of clients)response.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));})();
  timer=setInterval(()=>{for(const response of clients){if(response.writableLength>512*1024)response.destroy();else response.write(': keep-alive\n\n');}if(!shutting&&!controller.running&&((leaveAt&&Date.now()>leaveAt)||(!clients.size&&Date.now()-lastPing>5*60_000)))void close().then(()=>options.onIdleClose?.());},5000);timer.unref();
  return {origin,capability,url:origin+'/#'+capability,controller,server,close};
}

export async function openSetupWindow(url,{spawnProcess=spawn}={}){
  const selection=await chooseBrowserChannel().catch(()=>null);
  if(selection?.executablePath){const profile=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-setup-ui-'));const child=spawnProcess(selection.executablePath,['--app='+url,'--new-window','--no-first-run','--disable-extensions','--user-data-dir='+profile],{shell:false,windowsHide:false,stdio:'ignore',env:cleanChildEnvironment()});child.on('error',()=>{});child.unref();return {child,profile};}
  const command=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];const child=spawnProcess(command,args,{shell:false,windowsHide:true,stdio:'ignore',env:cleanChildEnvironment()});child.on('error',()=>{});child.unref();return {child};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let local,window;
  const stop=async()=>{await local?.close();if(window?.profile){const root=path.resolve(os.tmpdir()),target=path.resolve(window.profile);if(target.startsWith(root+path.sep)&&path.basename(target).startsWith('qwen-setup-ui-')){try{window.child.kill();}catch{}await fs.rm(target,{recursive:true,force:true,maxRetries:2}).catch(()=>{});}}};
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
  startSetupServer({onIdleClose:()=>void stop()}).then(async value=>{local=value;window=await openSetupWindow(local.url);}).catch(error=>{console.error(safeSetupText(error.message));process.exitCode=1;void stop();});
}

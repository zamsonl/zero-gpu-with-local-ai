import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import readline from 'node:readline';
import {DEFAULT_CREDENTIAL_PATH,loadSavedKaggleToken,saveKaggleToken,forgetKaggleToken,secureTokenStorageAvailable} from './credential-store.mjs';
import {chooseFolder} from './start.mjs';
import {createOwnKaggleSession,requestOwnShutdown,promptHiddenToken,confirmGpuUsage,validatePersonalSession,validateModelUrl,probeOwnNotebook} from './kaggle-session.mjs';
import {prepareOwnCache} from './cache.mjs';
import {requireRelayOrigin} from './deployment.mjs';
import {ownCloudRequest,startPersonalKeepAlive} from './cloud.mjs';
import {OPENCODE_VERSION,PLAYWRIGHT_MCP_VERSION,BROWSER_CHANNELS,MODEL,OPEN_CODE_REQUEST_TIMEOUT_MS,cleanChildEnvironment,assertNoManagedOpenCode,createOpenCodeRuntime} from './opencode-config.mjs';

export function parseOpenCodeOptions(args){
  const values=new Set(['--folder','--tools-dir','--state-dir','--opencode-bin','--kaggle-token-file','--launch-id','--session','--browser','--model-url']);
  const flags=new Set(['--setup','--no-browser','--no-remember-token','--forget-kaggle-token','--install-opencode','--install-browser','--with-browser','--consent-kaggle-gpu','--continue','--help']);
  const options={};
  for(let i=0;i<args.length;i++){
    const name=args[i];
    if(flags.has(name)){if(options[name])throw new Error('Duplicate launcher option.');options[name]=true;continue;}
    if(!values.has(name))throw new Error('Unknown OpenCode launcher option. Use --help. Owner connection files, arbitrary model flags, and --auto are not accepted.');
    if(options[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing or duplicate launcher option.');
    options[name]=args[++i];
  }
  if(options['--launch-id']&&!/^[A-Za-z0-9_-]{16,80}$/.test(options['--launch-id']))throw new Error('Invalid launch reference.');
  if(options['--session']&&!/^[A-Za-z0-9_-]{1,160}$/.test(options['--session']))throw new Error('Invalid OpenCode session reference.');
  if(options['--session']&&options['--continue'])throw new Error('Choose --continue or --session, not both.');
  if(options['--browser']&&!BROWSER_CHANNELS.includes(options['--browser']))throw new Error('Choose chromium, chrome or msedge with --browser.');
  if(options['--browser']&&!options['--with-browser']&&!options['--setup'])throw new Error('--browser requires --with-browser or --setup.');
  if(options['--no-browser']&&(options['--with-browser']||options['--install-browser']||options['--browser']))throw new Error('Choose --no-browser or browser options, not both.');
  if(options['--forget-kaggle-token']&&Object.keys(options).length!==1)throw new Error('--forget-kaggle-token is a standalone action; run it without other options.');
  return options;
}

const help=`Run OpenCode with Qwen in your own private Kaggle notebook.
  node opencode.mjs --folder "path/to/project"
  --setup                  Guided interactive setup, tool installation and Kaggle token help
  --no-browser             Skip browser tools in guided setup
  --no-remember-token      Do not read or save a remembered Kaggle token
  --forget-kaggle-token    Remove only the saved token, then exit without starting a notebook
  --install-opencode       Explicitly install OpenCode ${OPENCODE_VERSION} in your user-local tools folder
  --install-browser        Explicitly install Playwright MCP ${PLAYWRIGHT_MCP_VERSION}; Chromium when selected
  --with-browser           Enable the already installed isolated Playwright browser
  --browser CHANNEL        Use chromium, chrome or msedge; Windows prefers installed Chrome, then Edge
  --tools-dir PATH         Use another local tools folder
  --state-dir PATH         Store isolated local project/account history under this folder
  --continue               Resume the most recent OpenCode conversation for this project/account
  --model-url URL          Optional public Hugging Face GGUF only; blank uses default Qwen
  --session ID             Resume a specific local OpenCode conversation
  --opencode-bin PATH      Use an existing native OpenCode ${OPENCODE_VERSION} executable
  --kaggle-token-file PATH Read your own private token file instead of hidden entry
  --consent-kaggle-gpu     Explicit consent to use your own Kaggle GPU allowance
  --launch-id ID           Reuse a printed launch reference only for an explicit retry
Without --folder, Windows shows a folder picker. Ctrl+C or exiting OpenCode requests
shutdown of this personal notebook. Other providers and automatic approvals are disabled.`;

export const KAGGLE_TOKEN_SETTINGS_URL='https://www.kaggle.com/settings/api';

const PROGRESS_STAGES=new Set(['folder','checking','installing','browser','token','consent','cache','launching','queued','downloading','loading','connecting','ready','running','stopping','stopped','error']);
const BOOT_STAGES=new Set(['queued','installing','downloading','loading','connecting']);
const STAGE_LABELS={folder:'Choose a project folder',checking:'Checking local tools',installing:'Installing local tools',browser:'Checking isolated browser',token:'Connect your Kaggle account',consent:'Review GPU usage',cache:'Preparing your private cache',launching:'Starting your private Kaggle notebook',queued:'Queued on Kaggle',downloading:'Downloading model files',loading:'Loading Qwen on the GPUs',connecting:'Connecting to Qwen',ready:'Qwen is ready',running:'OpenCode is running',stopping:'Stopping your personal session',stopped:'Personal session stopped',error:'Setup stopped'};

/** Public setup output is bounded and never includes credentials or private tunnels. */
export function sanitizeSetupText(value,secrets=[],{maxLength=800,multiline=false}={}){
  let text=typeof value==='string'?value:'';
  text=text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g,'');
  for(const secret of secrets)if(typeof secret==='string'&&secret.length>=8)text=text.split(secret).join('[redacted]');
  text=text.replace(/\bKGAT_[A-Za-z0-9_-]+/g,'[redacted]')
    .replace(/\b[a-f0-9]{64}\b/gi,'[redacted]')
    .replace(/\b(?:authorization|x-relay-key|x-launch-token)\s*[:=]\s*[^\r\n]+/gi,'[redacted credential]')
    .replace(/\bBearer\s+[A-Za-z0-9_.~-]+/gi,'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]*\.trycloudflare\.com[^\s"'<>]*/gi,'[private tunnel]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'');
  if(!multiline)text=text.replace(/[\r\n\t]+/g,' ');
  return text.trim().slice(0,maxLength);
}

export function emitSetupProgress(observer,event,secrets=[]){
  if(typeof observer!=='function')return;
  const value={stage:PROGRESS_STAGES.has(event.stage)?event.stage:'checking',state:['pending','running','complete','error'].includes(event.state)?event.state:'running',detail:sanitizeSetupText(event.detail,secrets)};
  for(const name of ['line','item','folder'])if(typeof event[name]==='string')value[name]=sanitizeSetupText(event[name],secrets,{maxLength:name==='folder'?4096:800});
  if(event.source==='notebook'||event.source==='installer')value.source=event.source;
  if(['connected','retrying','stale'].includes(event.connection))value.connection=event.connection;
  if(Number.isFinite(event.elapsedSeconds)&&event.elapsedSeconds>=0)value.elapsedSeconds=Math.floor(event.elapsedSeconds);
  if(Number.isFinite(event.percent)&&event.percent>=0&&event.percent<=100)value.percent=event.percent;
  if(typeof event.owner==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(event.owner))value.owner=event.owner;
  if(typeof event.notebookUrl==='string'){
    try{const url=new URL(event.notebookUrl);if(url.origin==='https://www.kaggle.com'&&url.pathname.startsWith('/code/')&&!url.search&&!url.hash)value.notebookUrl=url.href;}catch{}
  }
  if(typeof event.launchId==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(event.launchId))value.launchId=event.launchId;
  if(PROGRESS_STAGES.has(event.failedStage))value.failedStage=event.failedStage;
  try{const pending=observer(value);pending?.catch?.(()=>{});}catch{/* Rendering cannot abort or repeat setup. */}
}

function safeSetupError(error,secrets,fallback){
  const detail=sanitizeSetupText(error?.message,secrets,{maxLength:600});
  return detail.replace(/\[(?:redacted|redacted credential|private tunnel)\]/g,'').replace(/[\s:;,.\-]+/g,'').length>=4?detail:fallback;
}


export async function confirmSetupStep(question,{input=process.stdin,output=process.stdout,defaultYes=false,signal}={}){
  if(!input.isTTY||!output.isTTY)throw new Error('Guided setup needs an interactive terminal. Use the regular explicit launcher options in scripts.');
  if(signal?.aborted)return null;
  const prompt=readline.createInterface({input,output,terminal:true});
  let abort;
  try{return await new Promise(resolve=>{
    let finished=false;const finish=value=>{if(finished)return;finished=true;resolve(value);};
    abort=()=>{finish(null);prompt.close();};signal?.addEventListener('abort',abort,{once:true});
    prompt.question(question+(defaultYes?' [Y/n] ':' [y/N] '),answer=>finish(answer.trim()?/^y(?:es)?$/i.test(answer.trim()):defaultYes));
    prompt.once('close',()=>finish(null));
    if(signal?.aborted)abort();
  });}finally{signal?.removeEventListener('abort',abort);prompt.close();}
}

/** Opens only the official token settings, with no token or user data in the URL. */
export async function openKaggleTokenPage({platform=process.platform,spawnProcess=spawn,log=console.log}={}){
  const command=platform==='win32'?'rundll32.exe':platform==='darwin'?'open':'xdg-open';
  const args=platform==='win32'?['url.dll,FileProtocolHandler',KAGGLE_TOKEN_SETTINGS_URL]:[KAGGLE_TOKEN_SETTINGS_URL];
  log('Kaggle API-token settings: '+KAGGLE_TOKEN_SETTINGS_URL);
  const opened=await new Promise(resolve=>{
    let child,finished=false;const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>finish(false),10000);
    try{child=spawnProcess(command,args,{shell:false,windowsHide:true,stdio:'ignore',env:cleanChildEnvironment()});}
    catch{finish(false);return;}
    child.once('error',()=>finish(false));child.once('close',code=>finish(code===0));child.unref?.();
  });
  if(!opened)log('The browser could not be opened. Open the fixed link above manually, then run setup again. No GPU notebook was launched.');
  return opened;
}

export function runCommand(command,args,{spawnProcess=spawn,onOutput,signal,terminate=terminateOwnedChild,...options}={}){
  return new Promise((resolve,reject)=>{
    let child,finished=false,output='',lastOutput='';const buffers={stdout:'',stderr:''};
    const cancelled=()=>Object.assign(new Error('The local tool operation was cancelled.'),{name:'AbortError',code:'ABORT_ERR'});
    const finish=(error,value)=>{if(finished)return;finished=true;signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const line=(text,stream)=>{
      const safe=sanitizeSetupText(text);if(!safe)return;lastOutput=safe;
      try{const pending=onOutput?.(safe,{stream});pending?.catch?.(()=>{});}catch{}
    };
    const append=(chunk,stream)=>{
      const text=String(chunk);if(stream==='stdout'&&output.length<8192)output+=text.slice(0,8192-output.length);
      if(!onOutput)return;
      buffers[stream]+=text.replace(/\r/g,'\n');let end;
      while((end=buffers[stream].indexOf('\n'))>=0){line(buffers[stream].slice(0,end),stream);buffers[stream]=buffers[stream].slice(end+1);}
      if(buffers[stream].length>16384){line(buffers[stream].slice(0,16384),stream);buffers[stream]='';}
    };
    const abort=()=>{if(finished)return;void Promise.resolve().then(()=>terminate(child)).catch(()=>{}).finally(()=>finish(cancelled()));};
    if(signal?.aborted){finish(cancelled());return;}
    try{child=spawnProcess(command,args,{shell:false,windowsHide:true,...options});}
    catch{finish(new Error('Could not start the requested local tool.'));return;}
    child.stdout?.on('data',chunk=>append(chunk,'stdout'));
    if(onOutput)child.stderr?.on('data',chunk=>append(chunk,'stderr'));else child.stderr?.resume();
    child.once('error',()=>finish(signal?.aborted?cancelled():new Error('Could not start the requested local tool.')));
    child.once('close',code=>{
      if(onOutput)for(const stream of ['stdout','stderr'])if(buffers[stream])line(buffers[stream],stream);
      if(signal?.aborted){finish(cancelled());return;}
      const error=code===0?null:Object.assign(new Error('The requested local tool failed'+(Number.isInteger(code)?' (exit '+code+')':'')+'. Check its installation.'),{exitCode:code,lastOutput});
      finish(error,output.trim());
    });
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}

async function npmInvocation(){
  if(process.platform!=='win32')return {command:'npm',args:[]};
  // Invoke npm's JS entry directly; never put user paths through cmd.exe quoting.
  const candidates=[path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')];
  if(process.env.npm_execpath?.endsWith('npm-cli.js'))candidates.push(process.env.npm_execpath);
  for(const file of candidates){try{await fs.access(file);return {command:process.execPath,args:[file]};}catch{}}
  throw new Error('Could not locate npm. Install Node.js with npm, or install the pinned packages manually in your --tools-dir.');
}

export async function installLocalTools(directory,{opencode=false,browser=false,browserRuntimeOnly=false,browserChannel='chromium',run=runCommand,log=console.log,onProgress,signal}={}){
  const progress=event=>emitSetupProgress(onProgress,event);
  const install=async(command,args,item)=>{
    if(signal?.aborted)throw Object.assign(new Error('Local tool installation cancelled.'),{name:'AbortError'});
    progress({stage:'installing',state:'running',item,detail:'Installing '+item+'.'});
    try{
      await run(command,args,{stdio:onProgress?['ignore','pipe','pipe']:'inherit',env:cleanChildEnvironment(),signal,...(onProgress?{onOutput:line=>progress({stage:'installing',state:'running',source:'installer',item,line,detail:line})}:{})});
      if(signal?.aborted)throw Object.assign(new Error('Local tool installation cancelled.'),{name:'AbortError'});
      progress({stage:'installing',state:'complete',item,detail:item+' installation completed.'});
    }catch(error){
      const detail=error?.name==='AbortError'?'Local tool installation cancelled.':item+' installation failed. '+safeSetupError(error,[],'Check the installer log and retry.');
      progress({stage:signal?.aborted?'stopped':'installing',state:signal?.aborted?'complete':'error',item,detail});
      if(error?.name==='AbortError'||signal?.aborted)throw Object.assign(new Error(detail),{name:'AbortError',stage:'installing'});
      throw Object.assign(new Error(detail),{stage:'installing',exitCode:error?.exitCode});
    }
  };
  progress({stage:'installing',state:'running',detail:'Preparing the local package installer.'});
  const npm=await npmInvocation();
  for(const [enabled,name,version,prefix] of [[opencode,'opencode-ai',OPENCODE_VERSION,'opencode'],[browser&&!browserRuntimeOnly,'@playwright/mcp',PLAYWRIGHT_MCP_VERSION,'browser']]){
    if(!enabled)continue;
    log('Installing '+name+'@'+version+' locally (explicit installation requested).');
    await install(npm.command,[...npm.args,'install','--prefix',path.join(directory,prefix),'--no-audit','--no-fund','--save-exact',name+'@'+version],name+' '+version);
  }
  if(browser&&browserChannel==='chromium'){
    log('Installing the local Chromium browser (explicit installation requested).');
    await install(process.execPath,[path.join(directory,'browser','node_modules','playwright','cli.js'),'install','chromium'],'Chromium browser');
  }
}

async function checkPackage(file,version){
  try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(value.version!==version)throw new Error();return value;}
  catch{throw new Error('The pinned local tool is missing or has a different version. First run: node opencode.mjs --install-opencode (add --install-browser for optional browser tools). Use --help for details.');}
}

export async function resolveOpenCode(options,directory,{run=runCommand}={}){
  let invocation;
  if(options['--opencode-bin']){
    const binary=path.resolve(options['--opencode-bin']);
    if(/\.(?:cmd|bat|ps1)$/i.test(binary))throw new Error('--opencode-bin needs a native executable, not a shell script. Use the pinned local installation option instead.');
    invocation={command:binary,args:[]};
  }else{
    const root=path.join(directory,'opencode','node_modules','opencode-ai');
    const metadata=await checkPackage(path.join(root,'package.json'),OPENCODE_VERSION);
    const relative=typeof metadata.bin==='string'?metadata.bin:metadata.bin?.opencode;
    if(typeof relative!=='string')throw new Error('The installed OpenCode package has no supported CLI entry. Reinstall the pinned release.');
    const entry=path.resolve(root,relative),inside=path.relative(root,entry);
    if(inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside)||/\.(?:cmd|bat|ps1)$/i.test(entry))throw new Error('The installed OpenCode CLI entry is unsupported. Reinstall the pinned release.');
    await fs.access(entry);
    // npm's postinstall may replace the entry with a native binary. POSIX can
    // also execute the original shebang wrapper directly; Windows needs node
    // only when the entry remains that JavaScript wrapper.
    invocation=/\.exe$/i.test(entry)||process.platform!=='win32'?{command:entry,args:[]}:{command:process.execPath,args:[entry]};
  }
  const version=await run(invocation.command,[...invocation.args,'--version'],{stdio:['ignore','pipe','pipe'],env:cleanChildEnvironment()});
  if(version.trim()!==OPENCODE_VERSION)throw new Error('This launcher requires the reviewed OpenCode '+OPENCODE_VERSION+' release. No Kaggle notebook was launched.');
  return invocation;
}

export async function resolveBrowser(directory){
  const root=path.join(directory,'browser','node_modules','@playwright','mcp');
  await checkPackage(path.join(root,'package.json'),PLAYWRIGHT_MCP_VERSION);
  const entry=path.join(root,'cli.js');await fs.access(entry);return entry;
}

export async function chooseBrowserChannel(preferred,{platform=process.platform,env=process.env,exists=async file=>{try{await fs.access(file);return true;}catch{return false;}}}={}){
  if(preferred&&!BROWSER_CHANNELS.includes(preferred))throw new Error('Choose chromium, chrome or msedge with --browser.');
  if(platform!=='win32'||preferred==='chromium')return {channel:preferred||'chromium'};
  const roots=[env.ProgramFiles||'C:\\Program Files',env['ProgramFiles(x86)']||'C:\\Program Files (x86)'];
  const paths={
    chrome:[...roots.map(root=>path.win32.join(root,'Google','Chrome','Application','chrome.exe')),...(env.LOCALAPPDATA?[path.win32.join(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')]:[])],
    msedge:[...roots.map(root=>path.win32.join(root,'Microsoft','Edge','Application','msedge.exe'))],
  };
  for(const channel of preferred?[preferred]:['chrome','msedge'])for(const executablePath of paths[channel])if(await exists(executablePath))return {channel,executablePath};
  if(preferred)throw new Error('The selected '+preferred+' browser is not installed. Install it yourself or use --browser chromium with --install-browser. No Kaggle notebook was launched.');
  return {channel:'chromium'};
}

export async function preflightBrowser({entry,channel,executablePath},{loadPlaywright=async()=>createRequire(entry)('playwright')}={}){
  let browser;
  try{
    const playwright=await loadPlaywright();
    // Use the installed full Chromium in new headless mode, matching the
    // headed MCP runtime, rather than requiring a separate headless shell.
    browser=await playwright.chromium.launch({headless:true,chromiumSandbox:true,timeout:15000,channel,...(executablePath?{executablePath}:{}),env:cleanChildEnvironment()});
    const context=await browser.newContext({acceptDownloads:false,permissions:[]});
    const page=await context.newPage();
    await page.goto('about:blank',{timeout:5000});
    await page.title();
  }catch{throw new Error('The isolated sandboxed '+channel+' browser could not start. No Kaggle notebook was launched. On Windows, try --with-browser --browser chrome or --browser msedge with an installed official browser. Use --setup --no-browser to skip browser tools in guided setup, or omit --with-browser in a regular launch.');}
  finally{await browser?.close().catch(()=>{});}
}

export async function browserRuntimeAvailable({entry,channel},{loadPlaywright=async()=>createRequire(entry)('playwright'),exists=async file=>{try{await fs.access(file);return true;}catch{return false;}}}={}){
  if(channel!=='chromium')return true; // Official executable paths were checked during channel selection.
  try{const playwright=await loadPlaywright();return await exists(playwright.chromium.executablePath());}
  catch{return false;}
}

export async function openProjectFolder(folder){
  let root;
  try{root=await fs.realpath(folder);if(!(await fs.stat(root)).isDirectory())throw new Error();}
  catch{throw new Error('Choose an existing project folder. No Kaggle notebook was launched.');}
  return root;
}

function pauseUntilPoll(ms,signal){
  if(signal?.aborted)return Promise.resolve();
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,ms);signal?.addEventListener('abort',finish,{once:true});
  });
}

export async function waitForOwnReady(session,{signal,log=console.log,onProgress,probeNotebook,onReady,request=ownCloudRequest,pause=pauseUntilPoll,now=Date.now,timeoutMs=OPEN_CODE_REQUEST_TIMEOUT_MS,pollMs=5000}={}){
  const start=now(),secrets=[session?.key];let reported='',lastReport=0,lastBootAt=-Infinity,lastLogPoll=-Infinity,lastQueueProbe=-Infinity,queueResult=null;
  let current={stage:'connecting',detail:'Waiting for the notebook to report its startup stage.'};const seenLines=new Set();
  const elapsed=()=>Math.floor(Math.max(0,now()-start)/1000);
  const publish=event=>emitSetupProgress(onProgress,{source:'notebook',...event,elapsedSeconds:elapsed()},secrets);
  const failure=(message,stage=current.stage)=>{
    const error=Object.assign(new Error(message),{name:'LaunchReadinessError',stage});
    publish({stage,state:'error',detail:message});throw error;
  };
  while(!signal?.aborted&&now()-start<timeoutMs){
    let status,connection='connected';
    try{status=await request(session,'/v1/status',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});}
    catch(error){
      if(signal?.aborted)return false;
      if([401,403].includes(error?.status))failure('Your personal Kaggle session credential was rejected. Close this setup and connect your account again.');
      if([409,410].includes(error?.status))failure('Your personal Kaggle session has ended or was asked to stop. Check its notebook before another launch.');
      connection='retrying';
    }
    if(status?.shutting_down)failure('Your personal Kaggle notebook was asked to stop. Check its notebook page.');
    if(status?.boot?.stage==='failed')failure('Kaggle startup failed. '+safeSetupError({message:status.boot.detail},secrets,'The notebook reported a startup failure. Check its log.'));
    if(status?.server==='ready'){
      if(status.num_ctx!==undefined&&(session.model_profile?![8192,16384,24576,32768].includes(status.num_ctx):status.num_ctx!==98304))failure('The personal Qwen server reported a different context profile. Check its notebook before retrying.');
      if(session.model_profile&&(!status.model_profile||status.model_profile.source_url!==session.model_profile.source_url||status.model_profile.profile_id!==session.model_profile.profile_id||status.model_profile.context!==status.num_ctx))failure('The custom model readiness profile could not be confirmed. Check the notebook and update the connector/service before another launch.');
      onReady?.(status);
      publish({stage:'ready',state:'complete',detail:session.model_profile?'Your selected private Kaggle model is ready.':'Your private Kaggle Qwen server is ready.',connection:'connected'});
      log(session.model_profile?'Your selected private Kaggle model is ready.':'Your private Kaggle Qwen server is ready.');return true;
    }
    if(status){
      const boot=status.boot,stamp=Date.parse(boot?.at);
      if(BOOT_STAGES.has(boot?.stage)){
        if(Number.isFinite(stamp)&&stamp<lastBootAt)connection='stale';
        else{
          if(Number.isFinite(stamp))lastBootAt=stamp;
          current={stage:boot.stage,detail:sanitizeSetupText(boot.detail,secrets)||STAGE_LABELS[boot.stage],...(Number.isFinite(boot.percent)&&boot.percent>=0&&boot.percent<=100?{percent:boot.percent}:{})};
        }
      }else if(status.server==='idle')current={stage:'loading',detail:'Loading Qwen on your own Kaggle GPU.'};
    }
    if(probeNotebook&&status?.server==='starting'){
      if(now()-lastQueueProbe>=30000){lastQueueProbe=now();try{queueResult=await probeNotebook();}catch(error){if([401,403].includes(error?.status))failure('Kaggle rejected the token while checking this notebook. Check the notebook first; then Forget saved token and reconnect with a new token.');queueResult=null;connection='queue_unavailable';}}
      if(['ERROR','COMPLETE','CANCELED','CANCELLED','CANCEL_ACKNOWLEDGED'].includes(queueResult?.status))failure('Kaggle reports this notebook '+queueResult.status.toLowerCase()+'. Open its notebook logs to check quota, GPU availability or startup errors before retrying.');
      if(queueResult?.status==='QUEUED'&&(!status.boot||status.boot.stage==='queued'))current={stage:'queued',detail:'Kaggle confirmed this notebook is queued for GPUs. Model installation and loading have not started.'};
      else if(queueResult?.status==='RUNNING'&&(!status.boot||status.boot.stage==='queued'))current={stage:'connecting',detail:'Kaggle reports the notebook is running. Waiting for its first Python startup log; the model is not ready yet.'};
    }
    const event={...current,state:'running',connection};
    publish(event);
    const line=STAGE_LABELS[current.stage]+': '+current.detail+(connection==='retrying'?' Connection interrupted; checking again.':connection==='stale'?' Waiting for newer progress.':'');
    if(!onProgress&&(line!==reported||now()-lastReport>=30000)){log(line+' '+elapsed()+'s elapsed. Ctrl+C cancels and requests shutdown.');reported=line;lastReport=now();}
    if(onProgress&&status&&now()-lastLogPoll>=pollMs){
      lastLogPoll=now();
      try{
        const result=await request(session,'/v1/server/log',{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
        const lines=typeof result?.log==='string'?result.log.slice(-32768).split(/\r?\n/).slice(-120):[];
        for(const raw of lines){
          const safe=sanitizeSetupText(raw,secrets);if(!safe||seenLines.has(safe))continue;
          seenLines.add(safe);if(seenLines.size>500)seenLines.delete(seenLines.values().next().value);
          publish({stage:current.stage,state:'running',source:'notebook',line:safe,detail:current.detail,connection});
        }
      }catch{/* Log access is secondary; the actual startup status remains authoritative. */}
    }
    await pause(pollMs,signal);
  }
  if(signal?.aborted)return false;
  failure('Your personal Kaggle notebook did not become ready within two hours. Check its notebook page before retrying.');
}

export async function terminateOwnedChild(child,{platform=process.platform,spawnProcess=spawn,timeoutMs=5000}={}){
  if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)return;
  if(platform==='win32'&&Number.isSafeInteger(child.pid)&&child.pid>0){
    // This PID came from our spawn call. /T also stops the npm CLI's native child.
    await runCommand('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{spawnProcess,stdio:['ignore','pipe','pipe']}).catch(()=>{});
  }else{try{child.kill('SIGTERM');}catch{}}
  await new Promise(resolve=>{
    if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode){resolve();return;}
    const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},timeoutMs);
    child.once('close',()=>{clearTimeout(timer);resolve();});
  });
}

export async function launchOpenCode(args=process.argv.slice(2),dependencies={}){
  const secrets=new Set();let stage='checking';
  const progress=event=>{if(PROGRESS_STAGES.has(event.stage))stage=event.stage;emitSetupProgress(dependencies.onProgress,event,[...secrets]);};
  const context={progress,secrets};
  const originalLog=dependencies.log||console.log;
  const deps={...dependencies,...(typeof dependencies.onProgress==='function'?{onProgress:dependencies.onProgress?progress:undefined}:{}),log:value=>originalLog(sanitizeSetupText(value,[...secrets],{maxLength:2000,multiline:true}))};
  try{return await launchOpenCodeInner(args,deps,context);}
  catch(error){
    const failedStage=PROGRESS_STAGES.has(error?.stage)?error.stage:stage;
    if(dependencies.signal?.aborted||error?.name==='AbortError'){
      progress({stage:'stopped',state:'complete',detail:'Setup cancelled. Any created personal notebook was asked to stop.'});return null;
    }
    const message=safeSetupError(error,[...secrets],'OpenCode startup failed during '+STAGE_LABELS[failedStage].toLowerCase()+'.');
    progress({stage:failedStage,state:'error',detail:message,failedStage});
    throw Object.assign(new Error(message),{name:error?.name||'Error',stage:failedStage,...(error?.code?{code:error.code}:{})});
  }
}

async function launchOpenCodeInner(args,dependencies,context){
  const options=parseOpenCodeOptions(args),log=dependencies.log||console.log,progress=context.progress;
  let currentStage='checking';const stage=(name,state,detail,extra={})=>{currentStage=name;progress({stage:name,state,detail,...extra});};
  if(options['--help']){log(help);return null;}
  if(options['--forget-kaggle-token']){
    const removed=await(dependencies.forgetSavedToken||forgetKaggleToken)();
    log(removed?'Saved Kaggle token removed. No notebook was started.':'No saved Kaggle token was found. No notebook was started.');return null;
  }
  requireRelayOrigin();
  const modelUrl=validateModelUrl(options['--model-url']||'');
  let setupCancelled=false;
  const cancelled=()=>setupCancelled||!!dependencies.signal?.aborted;
  const setup=options['--setup']===true;
  if(setup&&!(dependencies.isInteractive||(()=>process.stdin.isTTY&&process.stdout.isTTY))())throw new Error('Guided setup needs an interactive terminal. Use the regular explicit launcher options in scripts.');
  const askSetup=async(question,defaultYes=false)=>{
    const answer=await(dependencies.askSetup||confirmSetupStep)(question,{defaultYes,signal:dependencies.signal});
    if(answer==null)setupCancelled=true;
    return answer===true;
  };
  const cancelSetup=()=>{log('Setup cancelled. No GPU notebook was launched.');stage('stopped','complete','Setup cancelled before GPU launch.');return null;};
  if(setup)log('Qwen OpenCode setup · choose a folder, prepare local tools, then connect YOUR Kaggle account.');
  stage('folder','running','Choose the project folder for OpenCode.');
  const selected=options['--folder']||await(dependencies.chooseFolder||chooseFolder)();
  if(!selected||cancelled())return null;
  const folder=await(dependencies.openFolder||openProjectFolder)(selected);
  stage('folder','complete','Project folder selected.',{folder});
  stage('checking','running','Checking reviewed local tools and policy.');
  const directory=path.resolve(options['--tools-dir']||path.join(os.homedir(),'.qwen','opencode-tools'));
  await(dependencies.checkManaged||assertNoManagedOpenCode)();
  let invocation,browserSelection,browserEntry;
  if(setup){
    log('Step 1/3 · Check local OpenCode and isolated browser tools.');
    const install=dependencies.installTools||installLocalTools;
    const resolveCLI=dependencies.resolveCLI||resolveOpenCode;
    const withBrowser=!options['--no-browser'];
    if(withBrowser)browserSelection=await(dependencies.chooseBrowser||chooseBrowserChannel)(options['--browser']);
    try{invocation=await resolveCLI(options,directory);}
    catch(error){
      if(options['--opencode-bin'])throw error;
    }
    if(withBrowser){
      try{browserEntry=await(dependencies.resolveBrowser||resolveBrowser)(directory);}
      catch{/* A reviewed missing or different-version package is offered below. */}
    }
    if(cancelled())return cancelSetup();
    const missingCLI=!invocation,missingMCP=withBrowser&&!browserEntry;
    const missingBrowserRuntime=withBrowser&&browserEntry&&!await(dependencies.browserRuntimeAvailable||browserRuntimeAvailable)({entry:browserEntry,...browserSelection});
    const missingBrowser=missingMCP||missingBrowserRuntime;
    const missing=[...(missingCLI?['OpenCode '+OPENCODE_VERSION]:[]),...(missingMCP?['Playwright MCP '+PLAYWRIGHT_MCP_VERSION+(browserSelection.channel==='chromium'?' and Chromium':'')]:missingBrowserRuntime?['Chromium browser runtime']:[])];
    if((missingCLI&&!options['--install-opencode']||missingBrowser&&!options['--install-browser'])&&(!await askSetup('Install the missing reviewed local tools: '+missing.join(' + ')+'? This is a one-time download.',true)||cancelled()))return cancelSetup();
    const installCLI=missingCLI||!!options['--install-opencode'],installBrowser=missingBrowser||!!options['--install-browser'];
    if(installCLI||installBrowser){stage('installing','running','Installing the missing reviewed tools.');await install(directory,{opencode:installCLI,browser:installBrowser,browserRuntimeOnly:!missingMCP&&missingBrowserRuntime&&!options['--install-browser'],browserChannel:browserSelection?.channel,log,onProgress:dependencies.onProgress?progress:undefined,signal:dependencies.signal});}
    if(cancelled())return cancelSetup();
    if(installCLI)invocation=await resolveCLI(options,directory);
    if(installBrowser)browserEntry=await(dependencies.resolveBrowser||resolveBrowser)(directory);
  }else{
    browserSelection=options['--with-browser']||options['--install-browser']?await(dependencies.chooseBrowser||chooseBrowserChannel)(options['--browser']):undefined;
    if(options['--install-opencode']||options['--install-browser']){stage('installing','running','Installing the explicitly requested local tools.');await(dependencies.installTools||installLocalTools)(directory,{opencode:!!options['--install-opencode'],browser:!!options['--install-browser'],browserChannel:browserSelection?.channel,log,onProgress:dependencies.onProgress?progress:undefined,signal:dependencies.signal});}
    invocation=await(dependencies.resolveCLI||resolveOpenCode)(options,directory);
    browserEntry=options['--with-browser']?await(dependencies.resolveBrowser||resolveBrowser)(directory):undefined;
  }
  if(browserEntry){stage('browser','running','Checking the isolated sandboxed '+browserSelection.channel+' browser.');await(dependencies.preflightBrowser||preflightBrowser)({entry:browserEntry,...browserSelection});log('Isolated sandboxed browser ready: '+browserSelection.channel+'.');stage('browser','complete','Isolated '+browserSelection.channel+' browser ready.');}
  stage('checking','complete','Reviewed local tools are ready.');
  if(cancelled())return null;
  stage('token','pending','Connect your own Kaggle account.');
  let token,remembered=false,manualToken=false;
  if(options['--kaggle-token-file']){
    try{
      const read=dependencies.readTokenFile||(async file=>{const stat=await fs.stat(file);if(!stat.isFile()||stat.size>2048)throw new Error();return fs.readFile(file,'utf8');});
      token=(await read(options['--kaggle-token-file'])).trim().replace(/^\uFEFF/,'');
    }catch{throw new Error('Could not read your private Kaggle token file. Use a text file containing only your own token.');}
  }else{
    if(!options['--no-remember-token']){
      try{token=await(dependencies.loadSavedToken||loadSavedKaggleToken)();}
      catch(error){
        if(error?.code==='SECURE_STORAGE_UNAVAILABLE')log('Secure token storage is unavailable on this system. Paste your token for this run; no plaintext copy will be saved.');
        else throw new Error('The saved Kaggle token could not be opened for this user. Run node opencode.mjs --forget-kaggle-token, then run setup again. No notebook was launched.');
      }
      remembered=Boolean(token);
    }
    if(remembered){log('Using your securely remembered Kaggle token. GPU usage still requires consent.');stage('token','running','Using your securely remembered Kaggle token.');}
    else{
      if(setup){
        log('Step 2/3 · Connect your Kaggle account. Sign in to Kaggle, create an API token, copy its KGAT_ value, then return here.');
        const open=await askSetup('Open Kaggle API-token settings in your default browser? Choose No if you already have your token.',true);
        if(cancelled())return cancelSetup();
        if(open){
          let opened=false;
          try{opened=await(dependencies.openTokenPage||openKaggleTokenPage)({log});}
          catch{log('Open '+KAGGLE_TOKEN_SETTINGS_URL+' manually, then run setup again. No GPU notebook was launched.');}
          if(!opened||cancelled())return cancelSetup();
        }
        if(!options['--no-remember-token'])log((dependencies.secureStorageAvailable||secureTokenStorageAvailable)()?'Your token will be encrypted for this Windows user and remembered. Use --no-remember-token for a single run.':'Secure saved-token storage is unavailable on this system. Your token will be used only for this run.');
      }
      stage('token','pending','Enter your Kaggle API token in the secure field.');
      token=await(dependencies.promptToken||promptHiddenToken)();manualToken=true;
    }
  }
  if(cancelled()){token='';return null;}
  if((setup||remembered)&&(typeof token!=='string'||!/^KGAT_[A-Za-z0-9_-]{16,251}$/.test(token.trim()))){token='';throw new Error(remembered?'The saved Kaggle token is invalid. Run node opencode.mjs --forget-kaggle-token, then run setup again. No GPU notebook was launched.':'Copy the modern KGAT_ token value from '+KAGGLE_TOKEN_SETTINGS_URL+' and run setup again. No GPU notebook was launched.');}
  if(cancelled()){token='';return null;}
  if(typeof token==='string')context.secrets.add(token);
  stage('consent','pending','Confirm use of your own Kaggle GPU allowance.');
  if(setup)log('Step 3/3 · Review GPU usage. The token value stays out of logs, OpenCode settings and model messages.');
  const consent=options['--consent-kaggle-gpu']===true||await(dependencies.confirmUsage||confirmGpuUsage)();
  if(!consent||cancelled()){token='';log('Cancelled. No GPU notebook was launched.');return null;}
  stage('consent','complete','Use of your own Kaggle GPU allowance confirmed.');
  const clientId=options['--launch-id']||randomUUID();
  stage('cache','running','Checking your private cache before any GPU allocation.',{launchId:clientId});
  log('Launch reference (safe to keep for an explicit retry): '+clientId);
  log('Preparing '+(modelUrl?'your selected Hugging Face GGUF':'Qwen')+' in YOUR Kaggle account. First use builds a private cache on CPU; GPU allocation begins afterward.');
  let session,startupToken='';
  // Do not abort this request halfway through: a queued launch still needs its
  // personal session identity so cancellation can record a shutdown request.
  try{
    stage('cache','running','Checking your private persistent cache. First use prepares it on a CPU notebook before allocating GPUs.');
    const cache=await(dependencies.prepareCache||prepareOwnCache)({token,consent:true,modelUrl,signal:dependencies.signal,onProgress:progress});
    if(cancelled())return null;
    stage('launching','running','Starting your private GPU notebook with the prepared cache.');
    session=await(dependencies.createSession||createOwnKaggleSession)({token,consent:true,clientId,...(cache?.cache_id?{cacheId:cache.cache_id}:{}),...(modelUrl?{modelUrl}:{})});
    if(typeof session?.key==='string')context.secrets.add(session.key);
    session=validatePersonalSession(session,{requireFresh:false});
    startupToken=token;
    stage('token','complete','Kaggle accepted the token for '+session.owner+'.');
    stage('queued','running','Kaggle accepted your private notebook. Waiting for its first startup report.',{owner:session.owner,notebookUrl:session.url,launchId:clientId});
    if(!cancelled()&&setup&&manualToken&&!options['--no-remember-token']&&(dependencies.secureStorageAvailable||secureTokenStorageAvailable)()){
      try{await(dependencies.saveSavedToken||saveKaggleToken)(token);log('Kaggle token accepted and remembered with Windows user encryption.');}
      catch{log('Your token was accepted but could not be remembered securely. This run can continue; enter it again next time. No plaintext token was saved.');}
    }
  }
  catch(error){
    if(remembered&&(error?.status===401||error?.status===403||/^Your Kaggle token was not accepted\./.test(error?.message||'')))throw new Error('The saved Kaggle token was rejected. Run node opencode.mjs --forget-kaggle-token, then run setup again. No owner account fallback was used.');
    throw error;
  }
  finally{if(!startupToken)context.secrets.delete(token);token='';}
  let runtime,child,keepAlive,closing,shutdownRequested=false,exit={code:0,signal:null};
  let finish;const done=new Promise(resolve=>finish=resolve);
  const shutdown=()=> (dependencies.shutdownSession||requestOwnShutdown)(session);
  const onAbort=()=>{void close().catch(()=>{});};
  const close=({terminate=true}={})=>closing||=Promise.resolve().then(async()=>{
    dependencies.signal?.removeEventListener('abort',onAbort);
    let failed=false;stage('stopping','running','Stopping local tools and requesting personal notebook shutdown.');
    try{keepAlive?.stop();}
    catch{failed=true;log('Could not stop the local personal-session heartbeat.');}
    try{if(terminate&&child)await(dependencies.terminateChild||terminateOwnedChild)(child);}
    catch{failed=true;log('Could not confirm the local OpenCode process stopped.');}
    try{await shutdown();shutdownRequested=true;log('Shutdown requested for your personal Kaggle notebook. Check Kaggle to confirm it stopped.');}
    catch{failed=true;log('Could not confirm notebook shutdown. Stop the qwen-agent notebook from your own Kaggle account.');}
    try{await runtime?.cleanup();}catch{failed=true;log('Could not remove the temporary OpenCode session directory.');}
    const result={...exit,code:failed?1:exit.code};stage('stopped',failed?'error':'complete',failed?'Personal session cleanup could not be fully confirmed. Check the notebook in Kaggle.':'Shutdown requested. Your local conversation remains saved.');finish(result);return result;
  });
  if(cancelled()){await close();return null;}
  try{
    let keepAliveWarning=false;
    keepAlive=(dependencies.startKeepAlive||startPersonalKeepAlive)(session,{signal:dependencies.signal,onError:()=>{
      if(keepAliveWarning)return;keepAliveWarning=true;
      log('Could not refresh your personal notebook keep-alive. Check the connection; the two-hour idle safeguard still applies.');
    }});
    stage('connecting','running','Checking the personal notebook startup report.');
    let ready;try{ready=await(dependencies.waitForReady||waitForOwnReady)(session,{signal:dependencies.signal,log,onProgress:dependencies.onProgress?progress:undefined,probeNotebook:()=> (dependencies.probeNotebook||probeOwnNotebook)(session,{token:startupToken,signal:dependencies.signal?AbortSignal.any([dependencies.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)}),onReady:value=>{if(session.model_profile&&value.model_profile)session=validatePersonalSession({...session,model_profile:value.model_profile},{requireFresh:false});}});}finally{context.secrets.delete(startupToken);startupToken='';}
    if(!ready){await close();return null;}
    stage('ready','complete','Your private Kaggle Qwen server is ready.');
    stage('running','running','Preparing the isolated OpenCode session.');
    runtime=await(dependencies.createRuntime||createOpenCodeRuntime)(session,{projectFolder:folder,stateDirectory:options['--state-dir'],browserEntry,browserChannel:browserSelection?.channel,browserExecutablePath:browserSelection?.executablePath,tokenFile:options['--kaggle-token-file'],credentialFile:DEFAULT_CREDENTIAL_PATH});
    if(cancelled()){await close();return null;}
    log('OpenCode · '+folder+'\nYour Kaggle account: '+session.owner+'\nYour notebook: '+session.url);
    log((session.model_profile?session.model_profile.label+' · '+session.model_profile.context.toLocaleString()+' context':'Qwen only · 98,304 context')+' · '+(session.model_profile?.thinking===false?'This model does not advertise thinking.':'Reasoning is enabled and expanded by default. Use /thinking to collapse or expand it.'));
    log('Automatic context compaction uses the same hosted model and continues from saved session notes. Original local history remains saved.');
    log('Edits, shell commands and browser actions ask for approval. Exit OpenCode or press Ctrl+C to request notebook shutdown.');
    log('The connector keeps your personal notebook online while this window is open. Requests may run for up to two hours; Kaggle runtime and quota limits still apply.');
    const resume=options['--continue']?['--continue']:options['--session']?['--session',options['--session']]:[];
    child=(dependencies.spawnProcess||spawn)(invocation.command,[...invocation.args,folder,'--model',MODEL,'--agent','build',...resume],{cwd:folder,env:runtime.env,stdio:'inherit',shell:false,windowsHide:false});
    child.once('close',(code,signal)=>{exit={code:Number.isInteger(code)?code:signal?1:0,signal};void close({terminate:false}).catch(()=>{});});
    child.once('error',()=>{exit={code:1,signal:null};log('OpenCode could not start. Check its pinned installation.');stage('running','error','OpenCode could not start. Check its pinned installation.');void close({terminate:false}).catch(()=>{});});
    dependencies.signal?.addEventListener('abort',onAbort,{once:true});
    if(cancelled())onAbort();
    else stage('running','complete','OpenCode opened in your selected project.',{owner:session.owner,notebookUrl:session.url,folder});
    return {child,session,runtimeDirectory:runtime.directory,historyDirectory:runtime.historyDirectory,close,done};
  }catch(error){
    context.secrets.delete(startupToken);startupToken='';
    const failedStage=error?.stage||currentStage;const detail=safeSetupError(error,[...context.secrets],'OpenCode startup failed.');
    await close();throw Object.assign(new Error(detail+(shutdownRequested?' Shutdown was requested for the personal notebook; check Kaggle to confirm.':' Shutdown could not be confirmed; stop the personal notebook in Kaggle.')),{name:error?.name||'Error',stage:failedStage});
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const cancellation=new AbortController();let running=null;
  const stop=()=>{if(!cancellation.signal.aborted){cancellation.abort();if(!running)console.log('Cancellation requested. Waiting for any queued personal launch so its shutdown can be requested.');}};
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
  launchOpenCode(process.argv.slice(2),{signal:cancellation.signal}).then(async value=>{
    running=value;if(!value)return;if(cancellation.signal.aborted)await value.close();
    const result=await value.done;process.exitCode=result.code;
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}

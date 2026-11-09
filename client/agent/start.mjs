// The helper always launches a personal Kaggle session; it never loads the owner's relay config.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Workspace} from './workspace.mjs';
import {startLocalServer} from './server.mjs';
import {createOwnKaggleSession,requestOwnShutdown,promptHiddenToken,confirmGpuUsage} from './kaggle-session.mjs';

export function parseOptions(args){
  const values=new Set(['--folder','--state','--port','--kaggle-token-file','--launch-id']);
  const flags=new Set(['--no-browser','--consent-kaggle-gpu']);const result={};
  for(let i=0;i<args.length;i++){
    const name=args[i];if(flags.has(name)){result[name]=true;continue;}
    if(!values.has(name))throw new Error('Unknown launcher option. The old --config owner-connection option is no longer supported.');
    if(result[name]!==undefined||typeof args[i+1]!=='string'||args[i+1].startsWith('--'))throw new Error('Missing or duplicate launcher option.');
    result[name]=args[++i];
  }
  const port=result['--port']===undefined?0:Number(result['--port']);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Choose a local port between 0 and 65535.');
  if(result['--launch-id']&&!/^[A-Za-z0-9_-]{16,80}$/.test(result['--launch-id']))throw new Error('Invalid launch reference.');
  return {...result,port};
}

export async function chooseFolder({spawnProcess=spawn,platform=process.platform}={}){
  if(platform!=='win32')throw new Error('Start with: node start.mjs --folder /path/to/project');
  const script='Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "Choose the folder for Heretic Qwen"; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Write($picker.SelectedPath) }';
  const picker=spawnProcess('powershell.exe',['-NoLogo','-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{let output='';picker.stdout.on('data',value=>output+=value);picker.once('error',()=>reject(new Error('Folder picker failed. Use --folder with a quoted path.')));picker.once('close',code=>code===0?resolve(output.trim().replace(/^\uFEFF/,'')):reject(new Error('Folder picker failed. Use --folder with a quoted path.')));});
}

export async function launchAgent(args=process.argv.slice(2),dependencies={}){
  const options=parseOptions(args);
  const log=dependencies.log||console.log;
  const cancelled=()=>!!dependencies.signal?.aborted;
  const folder=options['--folder']||await(dependencies.chooseFolder||chooseFolder)();
  if(!folder||cancelled())return null;
  const state=options['--state']||path.join(os.homedir(),'.qwen','agent');
  // Resolve the folder before any credential prompt or cloud allocation.
  const workspace=await(dependencies.openWorkspace||Workspace.open)(folder,path.join(state,'backups'));
  if(cancelled())return null;
  let token;
  if(options['--kaggle-token-file']){
    try{
      const read=dependencies.readTokenFile||(async file=>{const stat=await fs.stat(file);if(!stat.isFile()||stat.size>2048)throw new Error();return fs.readFile(file,'utf8');});
      token=(await read(options['--kaggle-token-file'])).trim().replace(/^\uFEFF/,'');
    }catch{throw new Error('Could not read your private Kaggle token file. Use a text file containing only your own token.');}
  }else token=await(dependencies.promptToken||promptHiddenToken)();
  if(cancelled()){token='';log('Cancelled. No GPU notebook was launched.');return null;}
  const consent=options['--consent-kaggle-gpu']===true||await(dependencies.confirmUsage||confirmGpuUsage)();
  if(!consent||cancelled()){token='';log('Cancelled. No GPU notebook was launched.');return null;}
  const clientId=options['--launch-id']||randomUUID();
  log('Launch reference (safe to keep for an explicit retry): '+clientId);
  log('Launching a private notebook in your Kaggle account. First starts may download cloud runtime/model files; your PC does not download a model.');
  let config;
  try{config=await(dependencies.createSession||createOwnKaggleSession)({token,consent:true,clientId});}
  finally{token='';}
  let local;
  const shutdown=()=> (dependencies.shutdownSession||requestOwnShutdown)(config);
  if(cancelled()){
    await shutdown().catch(()=>log('Could not confirm shutdown after cancellation. Stop the qwen-agent notebook in your Kaggle account.'));
    log('Cancelled. Shutdown requested for this personal notebook; check Kaggle to confirm.');return null;
  }
  try{local=await(dependencies.startServer||startLocalServer)({workspace,config,stateDir:state,port:options.port});}
  catch(error){await shutdown().catch(()=>log('Could not confirm cloud cleanup. Stop the qwen-agent notebook in your Kaggle account.'));throw error;}
  log('Heretic Qwen local agent · '+workspace.root);
  log('Your Kaggle account: '+config.owner);
  log('Your notebook: '+config.url);
  log('Your GPU allowance is used while its notebook is allocated, including approval waits.');
  log('Private local launch link (do not share): '+local.url);
  log('Keep this helper open. Ctrl+C requests shutdown of this personal notebook.');
  if(!options['--no-browser']){
    const platform=dependencies.platform||process.platform;
    const browser=(dependencies.spawnProcess||spawn)(platform==='win32'?'rundll32.exe':platform==='darwin'?'open':'xdg-open',platform==='win32'?['url.dll,FileProtocolHandler',local.url]:[local.url],{windowsHide:true,stdio:'ignore'});
    browser.on('error',()=>log('Open the private local launch link printed above.'));
  }
  let closing;
  const close=()=>closing||=(async()=>{
    const results=await Promise.allSettled([local.close(),shutdown()]);
    if(results[1].status==='rejected')log('Could not confirm shutdown of your personal notebook. Stop it in your Kaggle account.');
    else log('Shutdown requested for your personal Kaggle notebook. Check Kaggle to confirm it has stopped.');
  })();
  return {local,config,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const cancellation=new AbortController();let running=null,closing=false;
  const stop=()=>{
      if(closing)return;
      if(!running){cancellation.abort();console.log('Cancellation requested. Waiting for any personal launch confirmation so its shutdown can be requested.');return;}
      closing=true;
      const deadline=setTimeout(()=>{console.error('Shutdown confirmation timed out. Stop the qwen-agent notebook from your Kaggle account.');process.exit(1);},15000);
      void running.close().then(()=>{clearTimeout(deadline);process.exit(0);},()=>{clearTimeout(deadline);console.error('Local cleanup failed. Check your personal Kaggle notebook.');process.exit(1);});
  };
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
  launchAgent(process.argv.slice(2),{signal:cancellation.signal}).then(value=>{
    running=value;if(running&&cancellation.signal.aborted)stop();
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}

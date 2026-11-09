import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validatePersonalSession} from './kaggle-session.mjs';

// This launcher deliberately targets the reviewed OpenCode 1 schema, not OpenCode 2.
export const OPENCODE_VERSION='1.19.5';
export const PLAYWRIGHT_MCP_VERSION='0.0.84';
export const BROWSER_CHANNELS=['chromium','chrome','msedge'];
export const PROVIDER_ID='personal-kaggle-qwen';
export const MODEL_ID='qwen3.8-hauhau';
export const MODEL=PROVIDER_ID+'/'+MODEL_ID;
export const RELAY_KEY_ENV='QWEN_AGENT_RELAY_KEY';
export const OPEN_CODE_REQUEST_TIMEOUT_MS=2*60*60*1000;
const THINKING_VISIBILITY_VERSION=1;

export function credentialRules(defaultAction='allow',extraPaths=[]){
  const rules={'*':defaultAction};
  // OpenCode uses simple wildcards, not globstar semantics. '*' also spans '/'.
  for(const pattern of ['*.env','*.env.*','*.dev.vars','*.dev.vars.*','*.dpapi.json','*/.wrangler/*','*\\.wrangler\\*','*.pem','*.key','*.p12','*.pfx','*id_rsa*','*id_ed25519*','*kaggle.json','*.npmrc','*.pypirc','*.netrc','*_netrc','*.git-credentials','*credentials.json','*service-account*.json','*token*.txt','*/.ssh/*','*/.aws/*','*/.azure/*','*/.config/gcloud/*','*/.kaggle/*','*/.qwen/*','*/.codex/*','*/opencode/auth.json','*\\.ssh\\*','*\\.aws\\*','*\\.kaggle\\*','*\\.qwen\\*','*\\.codex\\*'])rules[pattern]='deny';
  for(const file of extraPaths){
    rules[file]='deny';rules[file+'/*']='deny';rules[file+'\\*']='deny';
    const normalized=file.replaceAll('\\','/');rules[normalized]='deny';rules[normalized+'/*']='deny';
  }
  return rules;
}

export function createOpenCodeConfig(session,{browserCommand,privatePaths=[]}={}){
  const own=validatePersonalSession(session,{requireFresh:false});
  const profile=own.model_profile,capacity=profile?.context||98304,custom=!!profile;
  const permission={
    '*':'ask',read:credentialRules('allow',privatePaths),edit:credentialRules('ask',privatePaths),
    write:'ask',patch:'ask',bash:'ask',glob:'allow',grep:'ask',
    external_directory:'ask',webfetch:'ask',websearch:'deny',codesearch:'deny',task:'ask',skill:'ask',
    question:'allow',todowrite:'allow',doom_loop:'ask',
    'playwright_*':'ask',
    'playwright_browser_evaluate':'deny','playwright_browser_run_code':'deny',
    'playwright_browser_file_upload':'deny','playwright_browser_drop':'deny',
  };
  const agent={};
  for(const name of ['build','plan','general','explore','title','summary','compaction'])agent[name]={model:MODEL};
  // Short metadata and compaction outputs need their budget for the actual
  // title/notes. Interactive coding agents retain the model's Balanced effort.
  for(const name of ['title','summary','compaction'])agent[name].reasoningEffort='none';
  agent.compaction.prompt='Summarize this coding session for continuation using the exact section structure requested. Preserve the current user goal, explicit constraints, later corrections, exact file paths and identifiers, changes made, commands and test results, unresolved errors, and concrete next steps. Distinguish verified facts from tentative assistant suggestions. Keep important numerical values and the latest request exact. Do not invent progress or reproduce credentials. Do not continue the task inside the summary.';
  agent.plan.permission={edit:'deny',write:'deny',patch:'deny',bash:'ask'};
  agent.explore.permission={edit:'deny',write:'deny',patch:'deny',bash:'ask'};
  return {
    $schema:'https://opencode.ai/config.json',
    model:MODEL,small_model:MODEL,default_agent:'build',
    enabled_providers:[PROVIDER_ID],autoupdate:false,share:'disabled',
    compaction:{auto:true,prune:false,reserved:custom?Math.min(6144,Math.floor(capacity/4)):12288,preserve_recent_tokens:custom?Math.min(8192,Math.floor(capacity/4)):16384,tail_turns:2},
    plugin:[],instructions:[],lsp:false,formatter:false,experimental:{openTelemetry:false},
    provider:{[PROVIDER_ID]:{
      npm:'@ai-sdk/openai-compatible',name:custom?'Your private Kaggle model':'Your private Kaggle Qwen',
      options:{baseURL:own.relay+'/v1',apiKey:'{env:'+RELAY_KEY_ENV+'}',timeout:OPEN_CODE_REQUEST_TIMEOUT_MS},
      models:{[MODEL_ID]:{
        name:profile?.label||'Qwen 27B · your Kaggle GPU',tool_call:true,attachment:false,reasoning:custom?profile.thinking===true:true,
        interleaved:{field:'reasoning_content'},options:{reasoningEffort:'medium'},
        modalities:{input:['text'],output:['text']},limit:{context:capacity,input:capacity,output:custom?Math.min(4096,Math.floor(capacity/4)):8192},
        cost:{input:0,output:0},
      }},
    }},
    agent,permission,
    mcp:browserCommand?{playwright:{type:'local',command:browserCommand,enabled:true,
      // A local MCP inherits OpenCode's environment. Blank these so it does not
      // receive even the scoped relay credential or inherited browser settings.
      environment:{[RELAY_KEY_ENV]:'',PLAYWRIGHT_MCP_CDP_ENDPOINT:'',PLAYWRIGHT_MCP_EXTENSION:'',PLAYWRIGHT_MCP_STORAGE_STATE:'',PLAYWRIGHT_MCP_USER_DATA_DIR:'',PLAYWRIGHT_MCP_INIT_SCRIPT:'',PLAYWRIGHT_MCP_INIT_PAGE:''},
    }}:{},
  };
}

export function cleanChildEnvironment(source=process.env){
  const result={};
  for(const [name,value] of Object.entries(source)){
    // Never import provider credentials, Kaggle credentials, OpenCode overrides,
    // or browser connection/profile overrides into this isolated run.
    if(/^(OPENCODE_|PLAYWRIGHT_MCP_|KAGGLE_|QWEN_|CODEX_|OTEL_)/i.test(name)||/(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(name))continue;
    result[name]=value;
  }
  return result;
}

export function isolatedEnvironment(directory,config,key,source=process.env,{historyDirectory=directory}={}){
  return {...cleanChildEnvironment(source),
    XDG_CONFIG_HOME:path.join(directory,'config'),XDG_DATA_HOME:path.join(historyDirectory,'data'),
    XDG_CACHE_HOME:path.join(historyDirectory,'cache'),XDG_STATE_HOME:path.join(historyDirectory,'state'),
    OPENCODE_TEST_HOME:path.join(directory,'home'),
    OPENCODE_CONFIG:path.join(directory,'opencode.json'),OPENCODE_CONFIG_DIR:path.join(directory,'config','opencode'),
    OPENCODE_CONFIG_CONTENT:JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_PURE:'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',
    OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',
    OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',
    OPENCODE_DISABLE_TERMINAL_TITLE:'true',OPENCODE_LOG_LEVEL:'ERROR',
    [RELAY_KEY_ENV]:key,
  };
}

export async function assertNoManagedOpenCode({platform=process.platform,env=process.env,username=os.userInfo().username,exists=async file=>{try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}}={}){
  const managed=platform==='win32'?path.join(env.ProgramData||'C:\\ProgramData','opencode'):platform==='darwin'?'/Library/Application Support/opencode':'/etc/opencode';
  const files=[path.join(managed,'opencode.json'),path.join(managed,'opencode.jsonc')];
  if(platform==='darwin')files.push('/Library/Managed Preferences/'+username+'/ai.opencode.managed.plist','/Library/Managed Preferences/ai.opencode.managed.plist');
  for(const file of files)if(await exists(file))throw new Error('Managed OpenCode settings are present. This launcher cannot guarantee its Qwen-only provider and approval policy, so no Kaggle notebook was launched. Ask your administrator to review the setup.');
}

export async function findWorktreeRoot(folder){
  let candidate=path.resolve(folder);
  for(;;){
    try{await fs.stat(path.join(candidate,'.git'));return candidate;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
    const parent=path.dirname(candidate);if(parent===candidate)return path.resolve(folder);candidate=parent;
  }
}

/** Migrate only this connector's isolated TUI state to expanded reasoning once. */
export async function initializeThinkingVisibility(stateDirectory){
  const directory=path.join(stateDirectory,'opencode');
  const file=path.join(directory,'kv.json');
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  let current={};
  try{
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('Invalid Qwen UI preferences.');
    current=JSON.parse(await fs.readFile(file,'utf8'));
    if(!current||typeof current!=='object'||Array.isArray(current))throw new Error('Invalid Qwen UI preferences.');
  }catch(error){if(error.code!=='ENOENT')throw new Error('Could not read the isolated Qwen UI preferences. No global OpenCode settings were changed.');}
  if(current.qwen_thinking_visibility_version===THINKING_VISIBILITY_VERSION)return {file,changed:false};
  const next={...current,thinking_mode:'show',qwen_thinking_visibility_version:THINKING_VISIBILITY_VERSION};
  const temporary=file+'.'+process.pid+'.'+Date.now()+'.tmp';
  try{
    await fs.writeFile(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});
    await fs.rename(temporary,file);
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  return {file,changed:true};
}

export async function createOpenCodeRuntime(session,{baseDirectory=os.tmpdir(),stateDirectory=path.join(os.homedir(),'.qwen','opencode-projects'),projectFolder=process.cwd(),browserEntry,browserChannel='chromium',browserExecutablePath,tokenFile,credentialFile=path.join(os.homedir(),'.qwen','kaggle-token.dpapi.json'),sourceEnvironment=process.env}={}){
  if(!BROWSER_CHANNELS.includes(browserChannel))throw new Error('Choose chromium, chrome or msedge for the isolated browser.');
  const own=validatePersonalSession(session,{requireFresh:false});
  const folder=await fs.realpath(projectFolder),worktree=await findWorktreeRoot(folder);
  const identity=process.platform==='win32'?folder.toLowerCase():folder;
  const namespace=createHash('sha256').update(own.owner+'\0'+identity).digest('hex').slice(0,32);
  const historyDirectory=path.join(path.resolve(stateDirectory),namespace);
  await fs.mkdir(baseDirectory,{recursive:true});
  const directory=await fs.mkdtemp(path.join(baseDirectory,'qwen-opencode-'));
  try{
    for(const name of ['config/opencode','home','browser'])await fs.mkdir(path.join(directory,name),{recursive:true,mode:0o700});
    for(const name of ['data','cache','state'])await fs.mkdir(path.join(historyDirectory,name),{recursive:true,mode:0o700});
    await initializeThinkingVisibility(path.join(historyDirectory,'state'));
    const browserCommand=browserEntry?[process.execPath,browserEntry,'--isolated','--sandbox','--no-webmcp','--image-responses','omit','--browser',browserChannel,...(browserExecutablePath?['--executable-path',browserExecutablePath]:[]),'--output-dir',path.join(directory,'browser')]:undefined;
    const privatePaths=[directory,historyDirectory,path.resolve(credentialFile),...(tokenFile?[await fs.realpath(tokenFile)]:[])];
    const patterns=[...privatePaths];
    for(const root of new Set([folder,worktree]))for(const file of privatePaths)patterns.push(path.relative(root,file));
    const config=createOpenCodeConfig(own,{browserCommand,privatePaths:patterns});
    await fs.writeFile(path.join(directory,'opencode.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
    const env=isolatedEnvironment(directory,config,own.key,sourceEnvironment,{historyDirectory});
    let cleaned=false;
    return {directory,historyDirectory,config,env,async cleanup(){delete env[RELAY_KEY_ENV];if(cleaned)return;cleaned=true;await fs.rm(directory,{recursive:true,force:true});}};
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}

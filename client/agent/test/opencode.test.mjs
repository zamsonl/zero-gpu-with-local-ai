import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RELAY_ORIGIN} from '../kaggle-session.mjs';
import {createOpenCodeConfig,createOpenCodeRuntime,cleanChildEnvironment,isolatedEnvironment,assertNoManagedOpenCode,initializeThinkingVisibility,OPEN_CODE_REQUEST_TIMEOUT_MS,OPEN_CODE_TRANSPORT_TIMEOUT_MS,MODEL,MODEL_ID,PROVIDER_ID,RELAY_KEY_ENV,OPENCODE_VERSION} from '../opencode-config.mjs';
import {launchOpenCode,parseOpenCodeOptions,resolveOpenCode,installLocalTools,waitForOwnReady,chooseBrowserChannel,preflightBrowser,browserRuntimeAvailable,openKaggleTokenPage,KAGGLE_TOKEN_SETTINGS_URL,confirmSetupStep} from '../opencode.mjs';

const TOKEN='KGAT_test_personal_token_123456789012345';
const ID='personal_session_1234567890';
const CLIENT_ID='launch_attempt_123456789012345';
const CACHE_ID='fixture-private-cache';
const readyCache=()=>({cache_id:CACHE_ID,owner:'testuser',dataset:'testuser/private-cache/2',model_url:null});
const session=()=>({session_id:ID,relay:RELAY_ORIGIN+'/_agent/'+ID,key:'scoped_private_key_12345678901234567890',host:'kaggle',owner:'testuser',expires_at:new Date(Date.now()+12*3600000).toISOString(),url:'https://www.kaggle.com/code/testuser/qwen-agent-'+ID});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('the generated config allows only personal Qwen for every AI role and states accurate tool/context metadata',()=>{
  const own=session(),config=createOpenCodeConfig(own);
  assert.equal(config.model,MODEL);assert.equal(config.small_model,MODEL);
  assert.deepEqual(config.enabled_providers,[PROVIDER_ID]);assert.deepEqual(Object.keys(config.provider),[PROVIDER_ID]);
  const provider=config.provider[PROVIDER_ID];assert.equal(provider.npm,'@ai-sdk/openai-compatible');
  assert.equal(provider.options.baseURL,own.relay+'/v1');assert.equal(provider.options.apiKey,'{env:'+RELAY_KEY_ENV+'}');
  assert.deepEqual(Object.keys(provider.models),[MODEL_ID]);
  assert.deepEqual(provider.models[MODEL_ID].limit,{context:98304,input:98304,output:16384});
  assert.deepEqual(config.compaction,{auto:true,prune:false,reserved:12288,preserve_recent_tokens:16384,tail_turns:2});
  assert(config.agent.compaction.prompt.includes('later corrections'));assert(config.agent.compaction.prompt.includes('commands and test results'));
  assert.equal(provider.models[MODEL_ID].tool_call,true);assert.equal(provider.models[MODEL_ID].attachment,false);
  assert.equal(provider.models[MODEL_ID].reasoning,true);assert.deepEqual(provider.models[MODEL_ID].interleaved,{field:'reasoning_content'});
  assert.equal(provider.models[MODEL_ID].options.reasoningEffort,'medium');assert.equal(OPEN_CODE_REQUEST_TIMEOUT_MS,2*60*60*1000);
  // Ctrl+T in OpenCode cycles these thinking modes; none chosen behaves like normal.
  assert.deepEqual(provider.models[MODEL_ID].variants,{fast:{reasoningEffort:'none'},light:{reasoningEffort:'low'},normal:{reasoningEffort:'medium'},deep:{reasoningEffort:'high'}});
  assert.equal(createOpenCodeConfig({...own,model_profile:{label:'Selected GGUF',context:8192,quant:'Q4_K_M',num_batch:128,profile_id:'hfgguf:'+'a'.repeat(24),thinking:false}}).provider[PROVIDER_ID].models[MODEL_ID].variants,undefined);
  assert.equal(OPEN_CODE_TRANSPORT_TIMEOUT_MS,OPEN_CODE_REQUEST_TIMEOUT_MS+30_000);assert.equal(provider.options.timeout,OPEN_CODE_TRANSPORT_TIMEOUT_MS);
  for(const name of ['build','plan','general','explore','title','summary','compaction'])assert.equal(config.agent[name].model,MODEL);
  for(const name of ['title','summary','compaction'])assert.equal(config.agent[name].reasoningEffort,'none');
  for(const name of ['build','plan','general','explore'])assert.equal(config.agent[name].reasoningEffort,undefined);
  assert.equal(config.permission.read['*.dev.vars'],'deny');assert.equal(config.permission.edit['*.dpapi.json'],'deny');assert.equal(config.share,'disabled');assert.equal(config.experimental.openTelemetry,false);
  assert(!JSON.stringify(config).includes(own.key));assert(!JSON.stringify(config).includes(TOKEN));
  assert.throws(()=>createOpenCodeConfig({...own,relay:RELAY_ORIGIN}));
});

test('reasoning visibility migrates once inside the private Qwen namespace and preserves unrelated preferences',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-thinking-ui-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=path.join(root,'state');const first=await initializeThinkingVisibility(state);
  let kv=JSON.parse(await fs.readFile(first.file,'utf8'));assert.equal(kv.thinking_mode,'show');assert.equal(kv.qwen_thinking_visibility_version,1);assert.equal(first.changed,true);
  kv={...kv,thinking_mode:'hide',sidebar:'auto'};await fs.writeFile(first.file,JSON.stringify(kv));
  assert.equal((await initializeThinkingVisibility(state)).changed,false);assert.deepEqual(JSON.parse(await fs.readFile(first.file,'utf8')),kv,'A later explicit user collapse must persist');
  await fs.writeFile(first.file,JSON.stringify({thinking_mode:'hide',sidebar:'show',other_preference:true}));
  await initializeThinkingVisibility(state);kv=JSON.parse(await fs.readFile(first.file,'utf8'));
  assert.equal(kv.thinking_mode,'show');assert.equal(kv.sidebar,'show');assert.equal(kv.other_preference,true);
  const other=path.join(root,'unrelated-global','kv.json');await fs.mkdir(path.dirname(other),{recursive:true});await fs.writeFile(other,'{"thinking_mode":"hide"}');
  await initializeThinkingVisibility(state);assert.equal(await fs.readFile(other,'utf8'),'{"thinking_mode":"hide"}');
});

test('invalid isolated UI preference data is rejected rather than overwriting existing data',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-thinking-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'opencode');await fs.mkdir(directory);const file=path.join(directory,'kv.json');
  for(const content of ['broken json','[]','null','x'.repeat(65537)]){await fs.writeFile(file,content);await assert.rejects(initializeThinkingVisibility(root),/isolated Qwen UI preferences/);assert.equal(await fs.readFile(file,'utf8'),content);}
});

test('permissions require changes, shell and browser approval and deny credentials and external search services',()=>{
  const p=createOpenCodeConfig(session(),{privatePaths:['C:\\private\\token.txt']}).permission;
  for(const name of ['*','edit','write','patch','bash','webfetch','external_directory','playwright_*'])assert.equal(typeof p[name]==='object'?p[name]['*']:p[name],'ask');
  assert.equal(p.read['*'],'allow');assert.equal(p.read['*.env'],'deny');assert.equal(p.read['*.env.*'],'deny');
  assert.equal(p.read['*/.ssh/*'],'deny');assert.equal(p.read['*kaggle.json'],'deny');
  assert.equal(p.read['C:\\private\\token.txt'],'deny');assert.equal(p.read['C:/private/token.txt'],'deny');
  for(const name of ['websearch','codesearch','playwright_browser_evaluate','playwright_browser_run_code','playwright_browser_file_upload','playwright_browser_drop'])assert.equal(p[name],'deny');
});

test('runtime environment excludes inherited providers, credentials, browser profiles, telemetry and approval overrides',()=>{
  const source={PATH:'safe-path',SystemRoot:'C:\\Windows',HOME:'real-home',KAGGLE_KEY:TOKEN,KAGGLE_API_TOKEN:TOKEN,OPENAI_API_KEY:'other-ai-key',ANTHROPIC_AUTH_TOKEN:'other',OPENCODE_PERMISSION:'allow',OPENCODE_CONFIG:'owner.json',OPENCODE_CONFIG_CONTENT:'{}',OPENCODE_TEST_MANAGED_CONFIG_DIR:'bypass',PLAYWRIGHT_MCP_CDP_ENDPOINT:'http://shared-profile',OTEL_EXPORTER_OTLP_ENDPOINT:'http://collector'};
  assert.deepEqual(cleanChildEnvironment(source),{PATH:'safe-path',SystemRoot:'C:\\Windows',HOME:'real-home'});
  const env=isolatedEnvironment('temporary-run',createOpenCodeConfig(session()),session().key,source);
  assert.equal(env[RELAY_KEY_ENV],session().key);assert.equal(env.OPENCODE_PERMISSION,undefined);
  assert.equal(env.OPENCODE_TEST_MANAGED_CONFIG_DIR,undefined);assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG,'true');
  assert.equal(env.OPENCODE_TEST_HOME,path.join('temporary-run','home'));assert.equal(env.OPENCODE_PURE,'true');
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH,'true');assert.equal(source.KAGGLE_KEY,TOKEN);
});

test('ephemeral config has no secret, history persists and browser uses installed isolated local MCP',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'opencode-runtime-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project');await fs.mkdir(project);await fs.writeFile(path.join(root,'token.txt'),TOKEN);
  const own=session();const credentialFile=path.join(project,'.qwen','kaggle-token.dpapi.json');const options={baseDirectory:root,stateDirectory:path.join(root,'history'),projectFolder:project,browserEntry:path.join(root,'installed','cli.js'),tokenFile:path.join(root,'token.txt'),credentialFile,sourceEnvironment:{PATH:process.env.PATH,PLAYWRIGHT_MCP_STORAGE_STATE:'shared.json'}};
  const runtime=await createOpenCodeRuntime(own,options);
  const raw=await fs.readFile(path.join(runtime.directory,'opencode.json'),'utf8');
  assert(!raw.includes(own.key));assert(!raw.includes(TOKEN));
  const mcp=runtime.config.mcp.playwright;assert.deepEqual(mcp.command.slice(0,2),[process.execPath,path.join(root,'installed','cli.js')]);
  assert(mcp.command.includes('--isolated'));assert(mcp.command.includes('--no-webmcp'));assert(!mcp.command.includes('npx'));
  assert(mcp.command.includes('--sandbox'));assert(!mcp.command.includes('--no-sandbox'));
  for(const forbidden of ['--cdp-endpoint','--extension','--storage-state','--user-data-dir'])assert(!mcp.command.includes(forbidden));
  assert.equal(mcp.environment[RELAY_KEY_ENV],'');assert.equal(runtime.env.PLAYWRIGHT_MCP_STORAGE_STATE,undefined);
  assert.equal(runtime.config.permission.read[path.relative(project,path.join(root,'token.txt'))],'deny');
  assert.equal(runtime.config.permission.read[credentialFile],'deny');assert.equal(runtime.config.permission.edit[credentialFile],'deny');
  assert.equal(runtime.config.permission.read[path.relative(project,credentialFile)],'deny');assert.equal(runtime.config.permission.edit[path.relative(project,credentialFile)],'deny');
  const saved=path.join(runtime.env.XDG_DATA_HOME,'synthetic-history.txt');await fs.writeFile(saved,'keep local conversation');
  await runtime.cleanup();await runtime.cleanup();assert.equal(runtime.env[RELAY_KEY_ENV],undefined);await assert.rejects(fs.stat(runtime.directory),{code:'ENOENT'});
  assert.equal(await fs.readFile(saved,'utf8'),'keep local conversation');
  const again=await createOpenCodeRuntime({...own,session_id:'another_session_1234567890',relay:RELAY_ORIGIN+'/_agent/another_session_1234567890',url:'https://www.kaggle.com/code/testuser/qwen-agent-another_session_1234567890'},options);
  assert.equal(again.historyDirectory,runtime.historyDirectory);await again.cleanup();
  const otherOwner=await createOpenCodeRuntime({...own,owner:'otheruser',url:'https://www.kaggle.com/code/otheruser/qwen-agent-'+ID},options);
  assert.notEqual(otherOwner.historyDirectory,runtime.historyDirectory);await otherOwner.cleanup();
});

test('managed policy files fail closed using existence checks before reading any account config',async()=>{
  const checked=[];
  await assert.rejects(assertNoManagedOpenCode({platform:'win32',env:{ProgramData:'C:\\ProgramData'},exists:async file=>{checked.push(file);return file.endsWith('opencode.jsonc');}}),/Managed OpenCode/);
  assert.equal(checked.length,2);assert(checked.every(file=>file.includes('ProgramData')));
  await assertNoManagedOpenCode({platform:'linux',exists:async()=>false});
});

function fixture(){
  const calls=[],logs=[],own=session(),child=new EventEmitter();child.pid=12345;child.exitCode=null;
  let shutdown=0,cleanup=0,terminated=0,keepAliveStops=0,spawned;
  const deps={
    log:value=>logs.push(value),openFolder:async()=>{calls.push('folder');return 'selected-project';},
    loadSavedToken:async()=>null,saveSavedToken:async()=>({protected:true}),forgetSavedToken:async()=>false,secureStorageAvailable:()=>true,
    checkManaged:async()=>{calls.push('managed');},resolveCLI:async()=>{calls.push('cli');return {command:'installed-opencode',args:[]};},
    promptToken:async()=>{calls.push('token');return TOKEN;},confirmUsage:async()=>{calls.push('consent');return true;},
    prepareCache:async()=>readyCache(),
    createSession:async value=>{calls.push('launch');assert.deepEqual(value,{token:TOKEN,consent:true,clientId:CLIENT_ID,cacheId:CACHE_ID});return own;},
    startKeepAlive:(value,options)=>{calls.push('keepalive');assert.equal(value.relay,own.relay);assert.equal(typeof options.onError,'function');return {stop(){keepAliveStops++;},ready:Promise.resolve(true)};},
    waitForReady:async value=>{calls.push('ready');assert.equal(value.relay,own.relay);return true;},
    createRuntime:async value=>{calls.push('runtime');assert.equal(value.relay,own.relay);return {directory:'temporary-run',env:{[RELAY_KEY_ENV]:own.key},cleanup:async()=>{cleanup++;}};},
    spawnProcess:(command,args,options)=>{calls.push('spawn');spawned={command,args,options};return child;},
    shutdownSession:async value=>{assert.equal(value.relay,own.relay);shutdown++;},
    terminateChild:async value=>{assert.equal(value,child);terminated++;child.exitCode=0;child.emit('close',0,null);},
  };
  return {deps,calls,logs,own,child,get spawned(){return spawned;},get shutdown(){return shutdown;},get cleanup(){return cleanup;},get terminated(){return terminated;},get keepAliveStops(){return keepAliveStops;}};
}
const launchArgs=['--folder','selected-project','--launch-id',CLIENT_ID];

function guidedFixture(answers=[]){
  const f=fixture(),questions=[];f.deps.isInteractive=()=>true;
  f.deps.chooseBrowser=async()=>({channel:'chrome',executablePath:'official-chrome'});
  f.deps.resolveBrowser=async()=>{f.calls.push('browser');return 'installed-mcp';};
  f.deps.preflightBrowser=async()=>{f.calls.push('preflight');};
  f.deps.askSetup=async(question,options)=>{questions.push({question,options});if(!answers.length)throw new Error('Unexpected setup question');return answers.shift();};
  f.deps.openTokenPage=async()=>{f.calls.push('open-token-page');return true;};
  return Object.assign(f,{questions});
}

test('guided setup rejects noninteractive use before local checks and leaves ordinary explicit options available',async()=>{
  assert.equal(parseOpenCodeOptions(['--setup'])['--setup'],true);
  const f=fixture();f.deps.isInteractive=()=>false;
  await assert.rejects(launchOpenCode([...launchArgs,'--setup'],f.deps),/interactive terminal/);
  assert.deepEqual(f.calls,[]);assert(!f.logs.join('\n').includes(TOKEN));
  await assert.rejects(confirmSetupStep('test',{input:{isTTY:false},output:{isTTY:false}}),/interactive terminal/);
});

test('guided setup skips installed-tool downloads and opens only token help before hidden entry and separate GPU consent',async()=>{
  const f=guidedFixture([true]);f.deps.installTools=async()=>{throw new Error('No installation expected');};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);
  assert.deepEqual(f.calls,['folder','managed','cli','browser','preflight','open-token-page','token','consent','launch','keepalive','ready','runtime','spawn']);
  assert.equal(f.questions.length,1);assert(f.questions.every(item=>item.options.defaultYes===true));
  assert(!f.questions.some(item=>item.question.includes(TOKEN)));assert(!f.logs.join('\n').includes(TOKEN));assert(!f.logs.join('\n').includes(f.own.key));
  await running.close();assert.equal(f.shutdown,1);
});

test('guided setup installs a missing reviewed CLI only after confirmation and can use an existing token without opening Kaggle',async()=>{
  const f=guidedFixture([true,false]);let resolutions=0,installed=0;
  f.deps.resolveCLI=async()=>{f.calls.push('cli');if(++resolutions===1)throw new Error('missing');return {command:'reviewed',args:[]};};
  f.deps.installTools=async(directory,options)=>{f.calls.push('install');installed++;assert.equal(options.opencode,true);assert.equal(options.browser,false);assert(!f.calls.includes('token'));assert(!f.calls.includes('launch'));};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);
  assert.equal(installed,1);assert.equal(resolutions,2);assert(!f.calls.includes('open-token-page'));
  assert(f.calls.indexOf('install')<f.calls.indexOf('token'));await running.close();
});

test('guided browser setup detects the pinned MCP and installs only missing browser tools before sandbox preflight',async()=>{
  for(const missing of [false,true]){
    const f=guidedFixture(missing?[true,false]:[false]);let resolutions=0,installs=0;
    f.deps.chooseBrowser=async()=>({channel:'chrome',executablePath:'official-chrome'});
    f.deps.resolveBrowser=async()=>{f.calls.push('browser');if(missing&&++resolutions===1)throw new Error('missing');return 'installed-mcp';};
    f.deps.installTools=async(directory,options)=>{installs++;f.calls.push('install-browser');assert.equal(options.opencode,false);assert.equal(options.browser,true);assert.equal(options.browserChannel,'chrome');};
    f.deps.preflightBrowser=async options=>{f.calls.push('preflight');assert.equal(options.channel,'chrome');assert.equal(options.entry,'installed-mcp');assert(!f.calls.includes('token'));assert(!f.calls.includes('launch'));};
    const running=await launchOpenCode([...launchArgs,'--setup','--with-browser'],f.deps);
    assert.equal(installs,missing?1:0);assert(f.calls.indexOf('preflight')<f.calls.indexOf('token'));await running.close();
  }
});

test('declining required guided installations or GPU consent cannot allocate a notebook',async()=>{
  for(const stage of ['cli','browser','gpu']){
    const f=guidedFixture([false]);
    const args=[...launchArgs,'--setup'];
    if(stage==='cli')f.deps.resolveCLI=async()=>{throw new Error('missing');};
    if(stage==='browser'){args.push('--with-browser');f.deps.chooseBrowser=async()=>({channel:'chrome'});f.deps.resolveBrowser=async()=>{throw new Error('missing');};}
    if(stage==='gpu')f.deps.confirmUsage=async()=>{f.calls.push('consent');return false;};
    f.deps.installTools=async()=>{throw new Error('Declined install must not run');};
    assert.equal(await launchOpenCode(args,f.deps),null);assert(!f.calls.includes('launch'));
    if(stage!=='gpu')assert(!f.calls.includes('token'));
  }
});

test('guided cancellation and browser-opener failure stop before secret entry or GPU allocation',async()=>{
  for(const failure of ['cancel','opener-false','opener-error']){
    const f=guidedFixture([true]),cancellation=new AbortController();f.deps.signal=cancellation.signal;
    f.deps.openTokenPage=async()=>{if(failure==='cancel'){cancellation.abort();return true;}if(failure==='opener-error')throw new Error('opener unavailable');return false;};
    assert.equal(await launchOpenCode([...launchArgs,'--setup'],f.deps),null);assert(!f.calls.includes('token'));assert(!f.calls.includes('launch'));assert(!f.logs.join('\n').includes(TOKEN));
  }
});

test('closing a guided prompt is cancellation rather than No, including with a private token file and explicit consent',async()=>{
  const f=guidedFixture([null]);f.deps.readTokenFile=async()=>{throw new Error('Closed wizard must not read credentials');};
  f.deps.resolveCLI=async()=>{throw new Error('missing');};
  assert.equal(await launchOpenCode([...launchArgs,'--setup','--kaggle-token-file','private.txt','--consent-kaggle-gpu'],f.deps),null);
  assert(!f.calls.includes('token'));assert(!f.calls.includes('launch'));
});

test('a wrong guided token paste fails before GPU consent without printing the pasted value',async()=>{
  const f=guidedFixture([false]),wrong='PRIVATE_WRONG_PASTE_123';f.deps.promptToken=async()=>wrong;
  f.deps.confirmUsage=async()=>{throw new Error('Invalid token must not ask for GPU consent');};
  await assert.rejects(launchOpenCode([...launchArgs,'--setup'],f.deps),error=>error.message.includes('KGAT_')&&!error.message.includes(wrong));
  assert(!f.calls.includes('launch'));assert(!f.logs.join('\n').includes(wrong));
});

test('explicit private token files skip guided web/token questions and keep explicit GPU consent semantics',async()=>{
  const f=guidedFixture([]);f.deps.readTokenFile=async()=>TOKEN;
  f.deps.loadSavedToken=async()=>{throw new Error('Token files bypass the vault');};f.deps.saveSavedToken=async()=>{throw new Error('Token files are never saved');};
  f.deps.promptToken=async()=>{throw new Error('Do not prompt');};f.deps.openTokenPage=async()=>{throw new Error('Do not open Kaggle');};f.deps.confirmUsage=async()=>{throw new Error('Explicit consent already given');};
  const running=await launchOpenCode([...launchArgs,'--setup','--kaggle-token-file','private.txt','--consent-kaggle-gpu'],f.deps);
  assert.equal(f.questions.length,0);await running.close();
});

test('Kaggle helper opens only the fixed official API page with clean shell-free arguments and safe failure guidance',async()=>{
  for(const [platform,exitCode]of[['win32',0],['darwin',0],['linux',1]]){
    let request;const logs=[];
    const result=await openKaggleTokenPage({platform,log:line=>logs.push(line),spawnProcess:(command,args,options)=>{request={command,args,options};const child=new EventEmitter();queueMicrotask(()=>child.emit('close',exitCode));return child;}});
    assert.equal(result,exitCode===0);assert.equal(request.options.shell,false);assert.equal(request.options.windowsHide,true);
    assert.equal(request.args.at(-1),KAGGLE_TOKEN_SETTINGS_URL);assert.equal(KAGGLE_TOKEN_SETTINGS_URL,'https://www.kaggle.com/settings/api');
    assert(!new URL(KAGGLE_TOKEN_SETTINGS_URL).search);assert(!Object.keys(request.options.env).some(key=>/^(?:KAGGLE_|QWEN_|OPENCODE_)/i.test(key)));
    assert(logs.some(line=>line.includes(KAGGLE_TOKEN_SETTINGS_URL)));assert(!logs.join('\n').includes(TOKEN));
    if(exitCode!==0)assert(logs.some(line=>line.includes('manually')));
  }
});

test('guided setup probes both missing tools and installs them once after a single approval',async()=>{
  const f=guidedFixture([true,false]);let installed=false,installs=0;
  f.deps.resolveCLI=async()=>{f.calls.push('cli');if(!installed)throw new Error('missing CLI');return {command:'reviewed',args:[]};};
  f.deps.resolveBrowser=async()=>{f.calls.push('browser');if(!installed)throw new Error('missing MCP');return 'reviewed-mcp';};
  f.deps.installTools=async(directory,options)=>{installs++;assert.equal(options.opencode,true);assert.equal(options.browser,true);assert.equal(options.browserChannel,'chrome');assert(f.calls.includes('cli')&&f.calls.includes('browser'));assert(!f.calls.includes('token'));installed=true;};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);
  assert.equal(installs,1);assert.equal(f.questions.length,2);assert(f.questions[0].question.includes(OPENCODE_VERSION));assert(f.questions[0].question.includes('Playwright MCP'));
  await running.close();
});

test('guided setup repairs a missing Chromium runtime without reinstalling an already pinned MCP',async()=>{
  const f=guidedFixture([true,false]);let installed=false,installs=0;
  f.deps.chooseBrowser=async()=>({channel:'chromium'});f.deps.browserRuntimeAvailable=async()=>false;
  f.deps.installTools=async(directory,options)=>{installs++;assert.equal(options.opencode,false);assert.equal(options.browser,true);assert.equal(options.browserRuntimeOnly,true);assert.equal(options.browserChannel,'chromium');installed=true;};
  f.deps.preflightBrowser=async()=>{assert(installed);f.calls.push('preflight');};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);assert.equal(installs,1);assert(f.questions[0].question.includes('Chromium browser runtime'));assert(!f.questions[0].question.includes('Playwright MCP'));await running.close();
  const calls=[];await installLocalTools('local-tools',{browser:true,browserRuntimeOnly:true,browserChannel:'chromium',log(){},run:async(command,args)=>calls.push({command,args})});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args.slice(-2),['install','chromium']);
});

test('Chromium runtime presence is checked independently of the MCP package',async()=>{
  const options={entry:'pinned-cli',channel:'chromium'},fake={chromium:{executablePath:()=>'/browser/chromium'}};
  assert.equal(await browserRuntimeAvailable(options,{loadPlaywright:async()=>fake,exists:async file=>file==='/browser/chromium'}),true);
  assert.equal(await browserRuntimeAvailable(options,{loadPlaywright:async()=>fake,exists:async()=>false}),false);
  assert.equal(await browserRuntimeAvailable({...options,channel:'chrome'},{loadPlaywright:async()=>{throw new Error('Official channel was already checked');}}),true);
});

test('guided browser is on by default, and --no-browser skips browser detection without changing the Qwen tool policy',async()=>{
  const f=guidedFixture([false]);f.deps.chooseBrowser=async()=>{throw new Error('Browser disabled');};f.deps.resolveBrowser=async()=>{throw new Error('Browser disabled');};f.deps.preflightBrowser=async()=>{throw new Error('Browser disabled');};
  const running=await launchOpenCode([...launchArgs,'--setup','--no-browser'],f.deps);assert(!f.calls.includes('browser'));await running.close();
  assert.equal(parseOpenCodeOptions(['--setup','--browser','chrome'])['--browser'],'chrome');
  for(const extra of [['--with-browser'],['--install-browser'],['--browser','chrome']])assert.throws(()=>parseOpenCodeOptions(['--setup','--no-browser',...extra]),/not both/);
});

test('a remembered token skips Kaggle and hidden entry while keeping local browser preflight and GPU consent',async()=>{
  for(const setup of [false,true]){
    const f=guidedFixture([]);f.deps.loadSavedToken=async()=>TOKEN;
    f.deps.promptToken=async()=>{throw new Error('Saved token must skip prompt');};f.deps.openTokenPage=async()=>{throw new Error('Saved token must skip web page');};f.deps.saveSavedToken=async()=>{throw new Error('Do not rewrite the saved token');};
    const running=await launchOpenCode([...launchArgs,...(setup?['--setup']:[])],f.deps);
    assert(f.calls.includes('consent'));assert.equal(f.questions.length,0);assert(f.logs.some(line=>line.includes('securely remembered')));
    assert(!f.logs.join('\n').includes(TOKEN));await running.close();
  }
});

test('new guided tokens are remembered once after authenticated cache readiness and before GPU submission',async()=>{
  const f=guidedFixture([false]);let saves=0,cacheReady=false;f.deps.prepareCache=async()=>{cacheReady=true;return readyCache();};f.deps.saveSavedToken=async value=>{assert.equal(value,TOKEN);assert(cacheReady);assert(!f.calls.includes('launch'));saves++;return {protected:true};};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);assert.equal(saves,1);await running.close();
});

test('declined consent and token or cache failures never save the manually entered token',async()=>{
  for(const failure of ['consent','token','cache']){
    const g=guidedFixture([false]);let saves=0;g.deps.saveSavedToken=async()=>{saves++;};
    if(failure==='consent')g.deps.confirmUsage=async()=>false;
    if(failure==='token')g.deps.prepareCache=async()=>{throw Object.assign(new Error('Kaggle did not accept the token.'),{status:401});};
    if(failure==='cache')g.deps.prepareCache=async()=>{throw new Error('Private Dataset preparation failed.');};
    if(failure==='consent')assert.equal(await launchOpenCode([...launchArgs,'--setup'],g.deps),null);
    else await assert.rejects(launchOpenCode([...launchArgs,'--setup'],g.deps));
    assert.equal(saves,0);assert(!g.calls.includes('launch'));
  }
});

test('an authenticated manual token stays remembered when a later GPU status lookup fails',async()=>{
  const f=guidedFixture([false]);let saved='',saves=0;
  f.deps.saveSavedToken=async value=>{saved=value;saves++;};
  f.deps.createSession=async()=>{assert.equal(saved,TOKEN);throw Object.assign(new Error('Kaggle did not confirm GetKernelSessionStatus (HTTP 403).'),{code:'personal_launch_unconfirmed',launchUncertain:true,operation:'GetKernelSessionStatus',upstreamStatus:403,retryAfter:30,providerBody:TOKEN});};
  await assert.rejects(launchOpenCode([...launchArgs,'--setup'],f.deps),error=>{
    assert.equal(error.launchUncertain,true);assert.equal(error.operation,'GetKernelSessionStatus');assert.equal(error.upstreamStatus,403);assert.equal(error.retryAfter,30);assert.equal(error.providerBody,undefined);assert(!JSON.stringify(error).includes(TOKEN));return true;
  });
  assert.equal(saves,1);assert.equal(saved,TOKEN);assert(!f.logs.join('\n').includes(TOKEN));assert(!f.calls.includes('spawn'));
});

test('cancellation at cache readiness saves no token and cancellation during secure save submits no GPU notebook',async()=>{
  for(const when of ['cache','save']){
    const f=guidedFixture([false]),cancellation=new AbortController();let saves=0;f.deps.signal=cancellation.signal;
    f.deps.prepareCache=async()=>{if(when==='cache')cancellation.abort();return readyCache();};
    f.deps.saveSavedToken=async()=>{saves++;cancellation.abort();};
    assert.equal(await launchOpenCode([...launchArgs,'--setup'],f.deps),null);assert.equal(saves,when==='save'?1:0);assert(!f.calls.includes('launch'));
  }
});

test('no-remember and ordinary manual launches do not save tokens even when the GPU launch fails',async()=>{
  for(const args of [[...launchArgs,'--setup','--no-remember-token'],launchArgs]){
    const f=guidedFixture([false]);let saves=0;f.deps.saveSavedToken=async()=>{saves++;};f.deps.createSession=async()=>{throw new Error('Notebook permission lookup failed.');};
    await assert.rejects(launchOpenCode(args,f.deps),/permission lookup failed/);assert.equal(saves,0);
  }
});

test('secure-save failure remains actionable when GPU launch also fails, without a plaintext fallback',async()=>{
  const f=guidedFixture([false]);let saves=0;
  f.deps.saveSavedToken=async()=>{saves++;throw new Error(TOKEN);};f.deps.createSession=async()=>{assert.equal(saves,1);throw new Error('Notebook lookup failed.');};
  await assert.rejects(launchOpenCode([...launchArgs,'--setup'],f.deps),/Notebook lookup failed/);assert.equal(saves,1);
  assert(f.logs.some(line=>line.includes('could not be remembered securely')&&line.includes('enter it again next time')&&line.includes('No plaintext token was saved')));assert(!f.logs.join('\n').includes(TOKEN));
});

test('launcher error diagnostics accept only bounded public recovery fields',async()=>{
  const f=fixture();f.deps.createSession=async()=>{throw Object.assign(new Error('Notebook lookup failed.'),{launchUncertain:'yes',operation:TOKEN,upstreamStatus:200,retryAfter:86401,providerBody:TOKEN});};
  await assert.rejects(launchOpenCode(launchArgs,f.deps),error=>{for(const field of ['launchUncertain','operation','upstreamStatus','retryAfter','providerBody'])assert.equal(error[field],undefined);return true;});
});

test('deleted-notebook confirmation reaches GPU setup only with its explicit CLI flag',async()=>{
  assert.equal(parseOpenCodeOptions(['--confirm-deleted-notebooks'])['--confirm-deleted-notebooks'],true);
  for(const confirmed of [false,true]){
    const f=fixture();f.deps.createSession=async options=>{assert.equal(options.confirmDeletedNotebooks,confirmed?true:undefined);return f.own;};
    const running=await launchOpenCode([...launchArgs,...(confirmed?['--confirm-deleted-notebooks']:[])],f.deps);await running.close();
  }
});

test('deleted-notebook recovery survives the launcher only for its specific code and a safe notebook URL',async()=>{
  const notebookUrl='https://www.kaggle.com/code/testuser/qwen-agent-'+'a'.repeat(24);
  for(const patch of [{},{code:'kaggle_unknown'},{canConfirmDeleted:false},{notebookUrl:'https://evil.invalid/code/testuser/qwen-agent-old'},{notebookUrl:notebookUrl+'?token='+TOKEN},{notebookUrl:'https://secret@www.kaggle.com/code/testuser/qwen-agent-old'}]){
    const f=fixture();f.deps.createSession=async()=>{throw Object.assign(new Error('The old notebook could not be checked.'),{code:'personal_notebook_inaccessible',launchUncertain:true,canConfirmDeleted:true,notebookUrl,...patch});};
    await assert.rejects(launchOpenCode(launchArgs,f.deps),error=>{const allowed=Object.keys(patch).length===0;assert.equal(error.canConfirmDeleted,allowed?true:undefined);assert.equal(error.notebookUrl,allowed?notebookUrl:undefined);assert.equal(error.launchUncertain,true);assert(!JSON.stringify(error).includes(TOKEN));return true;});
  }
});

test('secure save failure is visible without secrets and does not strand the valid owned session',async()=>{
  const f=guidedFixture([false]);f.deps.saveSavedToken=async()=>{throw new Error(TOKEN+f.own.key);};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);assert(f.logs.some(line=>line.includes('could not be remembered securely')));
  assert(!f.logs.join('\n').includes(TOKEN));assert(!f.logs.join('\n').includes(f.own.key));await running.close();assert.equal(f.shutdown,1);
});

test('secure storage unavailability continues only in memory and never writes a plaintext fallback',async()=>{
  const f=guidedFixture([false]);f.deps.secureStorageAvailable=()=>false;f.deps.saveSavedToken=async()=>{throw new Error('No secure save available');};
  f.deps.loadSavedToken=async()=>{const error=new Error('unavailable');error.code='SECURE_STORAGE_UNAVAILABLE';throw error;};
  const running=await launchOpenCode([...launchArgs,'--setup'],f.deps);assert(f.logs.some(line=>line.includes('no plaintext copy')));await running.close();
});

test('no-remember mode bypasses both vault operations and forget is an isolated no-GPU action',async()=>{
  const f=guidedFixture([false]);f.deps.loadSavedToken=async()=>{throw new Error('Vault opt-out');};f.deps.saveSavedToken=async()=>{throw new Error('Vault opt-out');};
  const running=await launchOpenCode([...launchArgs,'--setup','--no-remember-token'],f.deps);await running.close();
  for(const removed of [false,true]){
    const g=fixture();let forgets=0;g.deps.forgetSavedToken=async()=>{forgets++;return removed;};
    assert.equal(await launchOpenCode(['--forget-kaggle-token'],g.deps),null);assert.equal(forgets,1);assert.deepEqual(g.calls,[]);assert.equal(g.shutdown,0);
  }
  assert.throws(()=>parseOpenCodeOptions(['--forget-kaggle-token','--setup']),/standalone/);
});

test('corrupt or rejected remembered tokens provide reset guidance without retrying, deleting or exposing them',async()=>{
  const corrupt=guidedFixture([]);corrupt.deps.loadSavedToken=async()=>{const error=new Error(TOKEN);error.code='SAVED_TOKEN_UNAVAILABLE';throw error;};
  await assert.rejects(launchOpenCode([...launchArgs,'--setup'],corrupt.deps),error=>error.message.includes('--forget-kaggle-token')&&!error.message.includes(TOKEN));assert(!corrupt.calls.includes('token'));assert(!corrupt.calls.includes('launch'));
  const rejected=guidedFixture([]);rejected.deps.loadSavedToken=async()=>TOKEN;let launches=0;
  rejected.deps.createSession=async()=>{launches++;const error=new Error(TOKEN);error.status=401;throw error;};rejected.deps.forgetSavedToken=async()=>{throw new Error('Do not delete automatically');};
  await assert.rejects(launchOpenCode([...launchArgs,'--setup'],rejected.deps),error=>error.message.includes('--forget-kaggle-token')&&!error.message.includes(TOKEN));assert.equal(launches,1);
});

test('launcher validates local prerequisites before personal credentials and never reads an owner config',async()=>{
  const f=fixture();const running=await launchOpenCode(launchArgs,f.deps);
  assert.deepEqual(f.calls,['folder','managed','cli','token','consent','launch','keepalive','ready','runtime','spawn']);
  assert.deepEqual(f.spawned.args,['selected-project','--model',MODEL,'--agent','build']);assert(!f.spawned.args.includes('--auto'));
  assert.equal(f.spawned.options.cwd,'selected-project');assert.equal(f.spawned.options.shell,false);
  assert.equal(f.spawned.options.env.KAGGLE_KEY,undefined);assert(!f.logs.join('\n').includes(TOKEN));assert(!f.logs.join('\n').includes(f.own.key));
  await Promise.all([running.close(),running.close()]);assert.equal(f.shutdown,1);assert.equal(f.cleanup,1);assert.equal(f.terminated,1);assert.equal((await running.done).code,0);
  for(const args of [['--config','owner.json'],['--model','external/free'],['--auto'],['--with-browser','--with-browser']])assert.throws(()=>parseOpenCodeOptions(args));
});

test('missing CLI, managed config, invalid folder or declined consent cannot launch a GPU notebook',async()=>{
  for(const stage of ['openFolder','checkManaged','resolveCLI']){
    const f=fixture();f.deps[stage]=async()=>{throw new Error('blocked');};await assert.rejects(launchOpenCode(launchArgs,f.deps),/blocked/);assert(!f.calls.includes('launch'));assert(!f.calls.includes('token'));
  }
  const f=fixture();f.deps.confirmUsage=async()=>false;assert.equal(await launchOpenCode(launchArgs,f.deps),null);assert(!f.calls.includes('launch'));
});

test('explicit token file and GPU consent still create only the personal session',async()=>{
  const f=fixture();f.deps.readTokenFile=async file=>{assert.equal(file,'private.txt');return '\uFEFF'+TOKEN+'\n';};
  f.deps.promptToken=async()=>{throw new Error('must not prompt');};f.deps.confirmUsage=async()=>{throw new Error('explicit consent');};
  const running=await launchOpenCode([...launchArgs,'--kaggle-token-file','private.txt','--consent-kaggle-gpu'],f.deps);await running.close();assert.equal(f.shutdown,1);
});

test('cancellation during a queued bootstrap waits for its own identity and requests shutdown without opening OpenCode',async()=>{
  const f=fixture(),waiting=deferred(),entered=deferred(),cancellation=new AbortController();
  f.deps.signal=cancellation.signal;f.deps.createSession=async()=>{entered.resolve();return waiting.promise;};
  const starting=launchOpenCode(launchArgs,f.deps);await entered.promise;cancellation.abort();waiting.resolve(f.own);
  assert.equal(await starting,null);assert.equal(f.shutdown,1);assert.equal(f.cleanup,0);assert(!f.calls.includes('runtime'));assert(!f.calls.includes('spawn'));
});

test('resume arguments keep the configured Qwen model and fresh personal connection',async()=>{
  const f=fixture();const running=await launchOpenCode([...launchArgs,'--continue'],f.deps);
  assert.equal(f.spawned.args.at(-1),'--continue');assert(f.spawned.args.includes(MODEL));await running.close();
  const g=fixture();const resumed=await launchOpenCode([...launchArgs,'--session','ses_local_example'],g.deps);
  assert.deepEqual(g.spawned.args.slice(-2),['--session','ses_local_example']);await resumed.close();
  assert.throws(()=>parseOpenCodeOptions(['--continue','--session','ses_local_example']));
});

test('personal readiness polls before inference, emits no remote credential text and respects cancellation',async()=>{
  let now=0,calls=0;const logs=[],own=session();
  assert.equal(await waitForOwnReady(own,{log:line=>logs.push(line),now:()=>now,pause:async()=>{now+=5000;},request:async(config,route)=>{
    assert.equal(config,own);assert.equal(route,'/v1/status');calls++;return calls===3?{server:'ready',num_ctx:98304}:{server:calls===1?'starting':'idle',boot:{detail:TOKEN}};
  }}),true);
  assert.equal(calls,3);assert(!logs.join('\n').includes(TOKEN));assert(logs.some(line=>line.includes('ready')));
  const signal=new AbortController();let polls=0;
  assert.equal(await waitForOwnReady(own,{signal:signal.signal,log:()=>{},request:async()=>{polls++;return {server:'starting'};},pause:async()=>signal.abort()}),false);assert.equal(polls,1);
  await assert.rejects(waitForOwnReady(own,{log:()=>{},request:async()=>({server:'offline',boot:{stage:'failed',detail:TOKEN}})}),error=>error.name==='LaunchReadinessError'&&!error.message.includes(TOKEN));
  now=0;await assert.rejects(waitForOwnReady(own,{log:()=>{},now:()=>now,timeoutMs:10000,pause:async()=>{now+=5000;},request:async()=>({server:'starting'})}),/did not become ready/);
});

test('cancelling or failing during cloud readiness still records personal shutdown before spawn',async()=>{
  for(const mode of ['cancel','fail']){
    const f=fixture(),signal=new AbortController();f.deps.signal=signal.signal;
    f.deps.waitForReady=async()=>{if(mode==='cancel'){signal.abort();return false;}throw new Error(TOKEN);};
    const start=launchOpenCode(launchArgs,f.deps);
    if(mode==='cancel')assert.equal(await start,null);else await assert.rejects(start,error=>!error.message.includes(TOKEN));
    assert.equal(f.shutdown,1);assert(!f.calls.includes('spawn'));
  }
});

test('child exit, child startup failure and cancellation each shut down once and erase the isolated run',async()=>{
  for(const mode of ['exit','error','cancel']){
    const f=fixture(),cancellation=new AbortController();f.deps.signal=cancellation.signal;
    const running=await launchOpenCode(launchArgs,f.deps);
    if(mode==='exit'){f.child.exitCode=7;f.child.emit('close',7,null);}
    if(mode==='error'){f.child.emit('error',new Error(TOKEN));f.child.emit('close',1,null);}
    if(mode==='cancel')cancellation.abort();
    const result=await running.done;assert.equal(f.shutdown,1);assert.equal(f.cleanup,1);assert.equal(result.code,mode==='exit'?7:mode==='error'?1:0);
    assert(!f.logs.join('\n').includes(TOKEN));assert.equal(cancellation.signal.onabort,null);
  }
});

test('the owning window keeps the personal session alive through startup and stops heartbeats before shutdown',async()=>{
  const f=fixture(),order=[];
  f.deps.startKeepAlive=(own,options)=>{assert.equal(own.relay,f.own.relay);assert.equal(options.signal,undefined);order.push('keepalive');return {ready:Promise.resolve(true),stop(){order.push('heartbeat-stop');}};};
  f.deps.waitForReady=async()=>{assert.deepEqual(order,['keepalive']);return true;};
  f.deps.terminateChild=async()=>{order.push('child-stop');f.child.exitCode=0;f.child.emit('close',0,null);};
  f.deps.shutdownSession=async()=>{order.push('shutdown');};
  const run=await launchOpenCode(launchArgs,f.deps);await Promise.all([run.close(),run.close()]);
  assert.deepEqual(order,['keepalive','heartbeat-stop','child-stop','shutdown']);
});

test('a failed readiness check still stops its heartbeat and requests only its personal shutdown',async()=>{
  const f=fixture();f.deps.waitForReady=async()=>{throw Object.assign(Error('ready failed'),{name:'LaunchReadinessError'});};
  await assert.rejects(launchOpenCode(launchArgs,f.deps),/ready failed/);assert.equal(f.keepAliveStops,1);assert.equal(f.shutdown,1);assert(!f.calls.includes('spawn'));
});

test('startup readiness permits a slow response past the former twenty-minute cap and has a two-hour upper bound',async()=>{
  let now=0;
  assert.equal(await waitForOwnReady(session(),{now:()=>now,log(){},pause:async()=>{now+=21*60000;},request:async()=>now>=21*60000?{server:'ready',num_ctx:98304}:{server:'starting'}}),true);
  now=0;let requests=0;
  await assert.rejects(waitForOwnReady(session(),{now:()=>now,log(){},pause:async()=>{now+=60*60000;},request:async()=>{requests++;return {server:'starting'};}}),/within two hours/);assert.equal(requests,2);
});

test('runtime or spawn failure cleans the exact personal notebook without exposing raw errors',async()=>{
  for(const stage of ['createRuntime','spawnProcess']){
    const f=fixture();f.deps[stage]=()=>{throw new Error(TOKEN+f.own.key);};
    await assert.rejects(launchOpenCode(launchArgs,f.deps),error=>error.message.includes('startup failed')&&!error.message.includes(TOKEN)&&!error.message.includes(f.own.key));
    assert.equal(f.shutdown,1);assert.equal(f.cleanup,stage==='spawnProcess'?1:0);
  }
});

test('cleanup failure and shutdown rejection are visible without credentials and produce failure exit status',async()=>{
  const f=fixture();f.deps.shutdownSession=async()=>{throw new Error(TOKEN);};
  const running=await launchOpenCode(launchArgs,f.deps);const result=await running.close();assert.equal(result.code,1);assert.equal(f.cleanup,1);assert(f.logs.some(line=>line.includes('Stop the qwen-agent notebook')));assert(!f.logs.join('\n').includes(TOKEN));
});

test('native CLI preflight requires the pinned version before GPU allocation',async()=>{
  const executable=path.join(os.tmpdir(),'opencode.exe');let request;
  const invocation=await resolveOpenCode({'--opencode-bin':executable},'unused',{run:async(command,args,options)=>{request={command,args,options};return OPENCODE_VERSION;}});
  assert.equal(invocation.command,executable);assert.deepEqual(request.args,['--version']);assert.equal(request.options.env.OPENCODE_PERMISSION,undefined);
  await assert.rejects(resolveOpenCode({'--opencode-bin':executable},'unused',{run:async()=> '2.2.3'}),/reviewed OpenCode/);
  await assert.rejects(resolveOpenCode({'--opencode-bin':'opencode.cmd'},'unused'),/native executable/);
});

test('local npm resolution follows actual package bin metadata including Windows native postinstall layout',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'opencode-package-layout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const pkg=path.join(root,'opencode','node_modules','opencode-ai');await fs.mkdir(path.join(pkg,'bin'),{recursive:true});
  for(const entry of ['./bin/opencode.exe','./bin/opencode']){
    await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({version:OPENCODE_VERSION,bin:{opencode:entry}}));
    await fs.writeFile(path.join(pkg,entry),'synthetic entry, never executed');
    const invocation=await resolveOpenCode({},root,{run:async()=>OPENCODE_VERSION});
    if(entry.endsWith('.exe')||process.platform!=='win32')assert.deepEqual(invocation,{command:path.join(pkg,entry),args:[]});
    else assert.deepEqual(invocation,{command:process.execPath,args:[path.join(pkg,'bin','opencode')]});
  }
});

test('explicit installation runs pinned local npm and browser installation without a Kaggle credential',async()=>{
  const calls=[];await installLocalTools('user-tools',{opencode:true,browser:true,log:()=>{},run:async(command,args,options)=>{calls.push({command,args,options});}});
  assert.equal(calls.length,3);assert(calls[0].args.includes('opencode-ai@'+OPENCODE_VERSION));assert(calls[1].args.includes('@playwright/mcp@0.0.84'));
  assert.deepEqual(calls[2].args.slice(-2),['install','chromium']);
  for(const call of calls){assert(call.args.includes('--prefix')||call.args.includes('chromium'));assert.equal(call.options.env.KAGGLE_KEY,undefined);assert.equal(call.options.env[RELAY_KEY_ENV],undefined);}
});

test('browser selection prefers installed official Windows channels and requires explicit supported choices',async()=>{
  const paths=[];const env={ProgramFiles:'C:\\Program Files','ProgramFiles(x86)':'C:\\Program Files (x86)',LOCALAPPDATA:'C:\\Users\\local\\AppData\\Local'};
  const chrome=await chooseBrowserChannel(undefined,{platform:'win32',env,exists:async file=>{paths.push(file);return file.endsWith('Chrome\\Application\\chrome.exe');}});
  assert.equal(chrome.channel,'chrome');assert.match(chrome.executablePath,/Google\\Chrome/);
  const edge=await chooseBrowserChannel(undefined,{platform:'win32',env,exists:async file=>file.endsWith('Edge\\Application\\msedge.exe')});assert.equal(edge.channel,'msedge');
  assert.deepEqual(await chooseBrowserChannel(undefined,{platform:'win32',env,exists:async()=>false}),{channel:'chromium'});
  assert.deepEqual(await chooseBrowserChannel(undefined,{platform:'linux',exists:async()=>{throw new Error('No Windows discovery expected');}}),{channel:'chromium'});
  await assert.rejects(chooseBrowserChannel('chrome',{platform:'win32',env,exists:async()=>false}),/not installed/);
  assert.equal(parseOpenCodeOptions(['--with-browser','--browser','chrome'])['--browser'],'chrome');
  assert.throws(()=>parseOpenCodeOptions(['--browser','chrome']),/requires --with-browser/);
  assert.throws(()=>parseOpenCodeOptions(['--with-browser','--browser','shared-profile']),/Choose chromium/);
});

test('browser preflight uses a blank isolated sandboxed context and closes its owned process on renderer failure',async()=>{
  let launchOptions,contextOptions,closed=0;
  const browser={newContext:async options=>{contextOptions=options;return {newPage:async()=>({goto:async url=>assert.equal(url,'about:blank'),title:async()=>''})};},close:async()=>{closed++;}};
  const loadPlaywright=async()=>({chromium:{launch:async options=>{launchOptions=options;return browser;}}});
  await preflightBrowser({entry:'installed-mcp',channel:'chrome',executablePath:'official-chrome.exe'},{loadPlaywright});
  assert.equal(launchOptions.chromiumSandbox,true);assert.equal(launchOptions.headless,true);assert.equal(launchOptions.channel,'chrome');assert.equal(launchOptions.executablePath,'official-chrome.exe');
  assert.equal(launchOptions.userDataDir,undefined);assert.equal(launchOptions.env.KAGGLE_API_TOKEN,undefined);assert.deepEqual(contextOptions,{acceptDownloads:false,permissions:[]});assert.equal(closed,1);
  await preflightBrowser({entry:'installed-mcp',channel:'chromium'},{loadPlaywright});
  assert.equal(launchOptions.channel,'chromium','preflight uses installed full Chromium instead of an unverified headless-shell runtime');
  browser.newContext=async()=>{throw new Error('renderer crashed');};
  await assert.rejects(preflightBrowser({entry:'installed-mcp',channel:'chromium'},{loadPlaywright}),/No Kaggle notebook was launched/);assert.equal(closed,3);
});

test('a failed optional browser stops before requesting a token or starting a personal notebook',async()=>{
  const f=fixture();
  f.deps.chooseBrowser=async()=>({channel:'chrome',executablePath:'official-chrome.exe'});
  f.deps.resolveBrowser=async()=>{f.calls.push('browser');return 'installed-mcp';};
  f.deps.preflightBrowser=async()=>{f.calls.push('browser-preflight');throw new Error('Sandboxed browser unavailable');};
  await assert.rejects(launchOpenCode([...launchArgs,'--with-browser'],f.deps),/Sandboxed browser unavailable/);
  assert.deepEqual(f.calls,['folder','managed','cli','browser','browser-preflight']);assert.equal(f.shutdown,0);
});

test('an installed official browser needs only the pinned MCP package, and missing-package help uses the extracted root',async()=>{
  const calls=[];await installLocalTools('user-tools',{browser:true,browserChannel:'chrome',log:()=>{},run:async(command,args)=>{calls.push({command,args});}});
  assert.equal(calls.length,1);assert(calls[0].args.includes('@playwright/mcp@0.0.84'));assert(!calls[0].args.includes('chromium'));
  await assert.rejects(resolveOpenCode({},path.join(os.tmpdir(),'opencode-definitely-missing-package-7193')),error=>error.message.includes('node opencode.mjs --install-opencode')&&!error.message.includes('node agent/opencode.mjs'));
});


test('readiness reports actual notebook stages, sanitized detail and real log lines instead of a generic connection label',async()=>{
  const own=session(),events=[],logs=[];let now=0,index=0;
  const statuses=[
    {server:'starting',boot:{stage:'queued',detail:'Waiting for two GPUs',at:'2026-11-08T00:00:00Z'}},
    {server:'starting',boot:{stage:'installing',detail:'Preparing the saved runtime',at:'2026-11-08T00:00:01Z'}},
    {server:'starting',boot:{stage:'downloading',detail:'Downloading text weights '+TOKEN+' '+own.key,percent:37,at:'2026-11-08T00:00:02Z'}},
    {server:'starting',boot:{stage:'loading',detail:'Loading Qwen on two T4 GPUs',at:'2026-11-08T00:00:03Z'}},
    {server:'starting',boot:{stage:'connecting',detail:'Registering the model server',at:'2026-11-08T00:00:04Z'}},
    {server:'ready',num_ctx:98304},
  ];
  const result=await waitForOwnReady(own,{onProgress:event=>events.push(event),log:line=>logs.push(line),now:()=>now,pause:async()=>{now+=5000;},request:async(_session,route)=>{
    if(route==='/v1/server/log')return {log:'runtime ready\nprivate '+TOKEN+' '+own.key+' https://private.trycloudflare.com'};
    return statuses[index++];
  }});
  assert.equal(result,true);assert.deepEqual(events.filter(e=>!e.line).map(e=>e.stage),['queued','installing','downloading','loading','connecting','ready']);
  assert(events.every(e=>e.source==='notebook'));
  assert(events.some(e=>e.stage==='installing'&&e.detail==='Preparing the saved runtime'));
  assert(events.some(e=>e.stage==='downloading'&&e.percent===37));
  assert(events.some(e=>e.source==='notebook'&&e.line==='runtime ready'));
  assert.equal(events.filter(e=>e.source==='notebook'&&e.line==='runtime ready').length,1);
  const text=JSON.stringify(events)+logs.join('\n');for(const secret of [TOKEN,own.key,'https://private.trycloudflare.com'])assert(!text.includes(secret));
  assert(!logs.some(line=>line.includes('Waiting for your private Kaggle notebook to connect')));
});

test('readiness keeps the last actual stage through stale boot data and a temporary connection failure',async()=>{
  const events=[];let now=0,index=0;
  const statuses=[
    {server:'starting',boot:{stage:'loading',detail:'Loading cached model',at:'2026-11-08T00:00:02Z'}},
    {server:'starting',boot:{stage:'queued',detail:'Old queue event',at:'2026-11-08T00:00:01Z'}},
    new Error('temporary network failure'),
    {server:'ready',num_ctx:98304},
  ];
  assert.equal(await waitForOwnReady(session(),{onProgress:event=>events.push(event),log(){},now:()=>now,pause:async()=>{now+=5000;},request:async(_session,route)=>{
    if(route==='/v1/server/log')return {log:''};const value=statuses[index++];if(value instanceof Error)throw value;return value;
  }}),true);
  assert(!events.some(event=>event.stage==='queued'));
  assert(events.some(event=>event.stage==='loading'&&event.connection==='retrying'));
  assert.equal(events.at(-1).stage,'ready');
});

test('structured setup progress preserves the failed operation and safe notebook failure detail',async()=>{
  const events=[];
  await assert.rejects(waitForOwnReady(session(),{onProgress:event=>events.push(event),log(){},request:async()=>({server:'offline',boot:{stage:'failed',detail:'CUDA out of memory '+TOKEN}})}),error=>error.name==='LaunchReadinessError'&&error.message.includes('CUDA out of memory')&&!error.message.includes(TOKEN));
  assert(events.some(event=>event.state==='error'&&event.detail.includes('CUDA out of memory')));
  const f=fixture();const stages=[];f.deps.onProgress=event=>stages.push(event);f.deps.createRuntime=async()=>{throw new Error('The selected project is read-only.');};
  await assert.rejects(launchOpenCode(launchArgs,f.deps),error=>error.message.includes('selected project is read-only')&&typeof error.stage==='string');
  assert(stages.some(event=>event.state==='error'&&event.detail.includes('selected project is read-only')));assert.equal(f.shutdown,1);
});

test('a notebook that never reports says so after five and fifteen minutes instead of staying silent',async()=>{
  const events=[];let now=0,polls=0;
  assert.equal(await waitForOwnReady(session(),{now:()=>now,pause:async()=>{now+=5000;},probeNotebook:async()=>({status:''}),onProgress:e=>events.push(e),log:()=>{},
    request:async(_s,path)=>path==='/v1/server/log'?{log:''}:++polls>200?{server:'ready',num_ctx:98304}:{server:'starting',boot:{stage:'queued',detail:'Submitted to Kaggle'}}}),true);
  const notes=events.filter(e=>e.line?.startsWith('No startup report after'));
  assert.deepEqual(notes.map(e=>e.line.match(/after (\d+) minutes/)[1]),['5','15']);
  assert(notes[0].line.includes('Kaggle has not returned a status')&&notes[0].line.includes('weekly GPU quota'));
  // A notebook that is reporting progress never gets the notice.
  const busy=[];now=0;polls=0;
  await waitForOwnReady(session(),{now:()=>now,pause:async()=>{now+=5000;},onProgress:e=>busy.push(e),log:()=>{},
    request:async(_s,path)=>path==='/v1/server/log'?{log:''}:++polls>200?{server:'ready',num_ctx:98304}:{server:'starting',boot:{stage:'loading',detail:'Loading the model',at:new Date(polls*1000).toISOString()}}});
  assert(!busy.some(e=>e.line?.startsWith('No startup report')));
});
test('readiness distinguishes Kaggle running from a confirmed GPU queue and drops repeated GUI log spam',async()=>{const events=[],logs=[];let count=0,now=0,probes=0;assert.equal(await waitForOwnReady(session(),{now:()=>now,pause:async()=>{now+=5000;},probeNotebook:async()=>{probes++;return {status:'RUNNING'};},onProgress:e=>events.push(e),log:x=>logs.push(x),request:async(_s,path)=>path==='/v1/server/log'?{log:''}:++count>3?{server:'ready',num_ctx:98304}:{server:'starting',boot:{stage:'queued',detail:'Submitted to Kaggle'}}}),true);assert.equal(probes,1);assert(events.some(e=>e.stage==='connecting'&&e.detail.includes('Kaggle reports the notebook is running')));assert(!events.some(e=>e.detail.includes('confirmed this notebook is queued')));assert(!logs.some(x=>x.includes('elapsed. Ctrl+C')));});
test('a terminal Kaggle notebook status stops waiting without another launch',async()=>{let now=0;await assert.rejects(waitForOwnReady(session(),{now:()=>now,pause:async()=>{now+=5000;},probeNotebook:async()=>({status:'ERROR'}),log(){},request:async()=>({server:'starting',boot:{stage:'queued',detail:'Submitted'}})}),/Kaggle reports this notebook error/);assert.equal(now,0);});

test('a forbidden Kaggle status probe preserves authenticated boot progress until the relay reports ready',async()=>{
  const events=[],logs=[];let now=0,index=0,probes=0;
  const statuses=[{server:'starting',boot:{stage:'queued',detail:'Notebook accepted.'}},{server:'starting',boot:{stage:'installing',detail:'Preparing cached runtime.'}},{server:'starting',boot:{stage:'loading',detail:'Loading the exact model.'}},{server:'ready',num_ctx:98304}];
  const ready=await waitForOwnReady(session(),{now:()=>now,pause:async()=>{now+=5000;},onProgress:event=>events.push(event),log:line=>logs.push(line),probeNotebook:async()=>{probes++;throw Object.assign(new Error('Provider body '+TOKEN),{status:403});},request:async(_session,route)=>route==='/v1/server/log'?{log:'Python startup is progressing.'}:statuses[index++]});
  assert.equal(ready,true);assert.equal(probes,1);assert(events.some(event=>event.connection==='queue_unavailable'&&event.line?.includes('GetKernelSessionStatus HTTP 403')));assert(events.some(event=>event.stage==='loading'&&event.detail==='Loading the exact model.'));assert.equal(events.at(-1).stage,'ready');
  const output=JSON.stringify(events)+logs.join('\n');assert(!/token.*reject|forget saved token|new token/i.test(output));assert(!output.includes(TOKEN));assert(!events.some(event=>event.state==='error'));
});

test('status-probe HTTP403 never requests shutdown of an accepted notebook before healthy startup completes',async()=>{
  const f=fixture();let now=0,polls=0;
  f.deps.probeNotebook=async()=>{throw Object.assign(new Error('Forbidden'),{status:403});};
  f.deps.waitForReady=(own,options)=>waitForOwnReady(own,{...options,now:()=>now,pause:async()=>{now+=5000;},request:async(_session,route)=>{assert.equal(f.shutdown,0);return route==='/v1/server/log'?{log:''}:++polls<3?{server:'starting',boot:{stage:polls===1?'queued':'loading',detail:'Authenticated startup report.'}}:{server:'ready',num_ctx:98304};}});
  const running=await launchOpenCode(launchArgs,f.deps);assert.equal(f.shutdown,0);assert(f.calls.includes('spawn'));assert(!f.logs.some(line=>/token.*reject|forget saved token/i.test(line)));await running.close();assert.equal(f.shutdown,1);
});

test('persistent forbidden queue lookups retain the startup deadline and emit one diagnostic',async()=>{
  const events=[];let now=0,probes=0;
  await assert.rejects(waitForOwnReady(session(),{now:()=>now,timeoutMs:65000,pause:async()=>{now+=5000;},log(){},onProgress:event=>events.push(event),probeNotebook:async()=>{probes++;throw Object.assign(new Error('Forbidden'),{status:403});},request:async(_session,route)=>route==='/v1/server/log'?{log:''}:{server:'starting',boot:{stage:'queued',detail:'Waiting for startup.'}}}),/did not become ready within two hours/);
  assert.equal(now,65000);assert.equal(probes,3);assert.equal(events.filter(event=>event.line?.includes('GetKernelSessionStatus HTTP 403')).length,1);
});

test('cancellation and ended relay sessions remain bounded after an unavailable queue probe',async()=>{
  const cancellation=new AbortController();let probes=0;
  assert.equal(await waitForOwnReady(session(),{signal:cancellation.signal,log(){},pause:async()=>cancellation.abort(),probeNotebook:async()=>{probes++;throw Object.assign(new Error('Forbidden'),{status:403});},request:async()=>({server:'starting'})}),false);assert.equal(probes,1);
  for(const status of [409,410]){let requests=0;await assert.rejects(waitForOwnReady(session(),{log(){},pause:async()=>assert.fail('Ended sessions must not enter a retry loop'),request:async()=>{requests++;throw Object.assign(new Error('Ended'),{status});}}),/session has ended or was asked to stop/);assert.equal(requests,1);}
});

test('Kaggle queue HTTP401 remains distinct from private-status HTTP403 and actual relay authentication failure',async()=>{
  let probes=0;
  await assert.rejects(waitForOwnReady(session(),{log(){},pause:async()=>assert.fail('Authentication failure must be bounded'),probeNotebook:async()=>{probes++;throw Object.assign(new Error('Unauthorized'),{status:401});},request:async()=>({server:'starting'})}),/GetKernelSessionStatus HTTP 401/);assert.equal(probes,1);
  for(const status of [401,403])await assert.rejects(waitForOwnReady(session(),{log(){},request:async()=>{throw Object.assign(new Error('Unauthorized'),{status});}}),/personal Kaggle session credential was rejected/);
});

test('custom GGUF uses measured context and preserves approvals with automatic compaction',()=>{const own={...session(),model_profile:{label:'Selected GGUF',context:8192,quant:'Q4_K_M',num_batch:128,profile_id:'hfgguf:'+'a'.repeat(24),thinking:false}};const config=createOpenCodeConfig(own),model=config.provider['personal-kaggle-qwen'].models['qwen3.8-hauhau'];assert.equal(model.limit.context,8192);assert.equal(model.limit.input,8192);assert.equal(model.limit.output,2048);assert.equal(model.reasoning,false);assert.equal(config.compaction.reserved,2048);assert.equal(config.compaction.preserve_recent_tokens,2048);assert.equal(config.permission.bash,'ask');assert.equal(config.permission.edit['*'],'ask');assert.equal(config.autoupdate,false);});

test('unsupported custom model hosts fail before local tool setup or token access',async()=>{await assert.rejects(launchOpenCode(['--model-url','https://ollama.com/library/qwen'],{log(){},loadSavedToken:async()=>{assert.fail('Invalid model must not read a token');}}),/Hugging Face GGUF only/);});

test('custom readiness requires the same source and the actual loaded context',async()=>{const source='https://huggingface.co/example/model-GGUF',profile={source_url:source,label:'Selected GGUF',context:32768,quant:'Q4_K_M',num_batch:128,profile_id:'hfgguf:'+'a'.repeat(24)},own={...session(),model_profile:profile};let confirmed;assert.equal(await waitForOwnReady(own,{log(){},onReady:value=>confirmed=value,request:async()=>({server:'ready',num_ctx:16384,model_profile:{...profile,context:16384}})}),true);assert.equal(confirmed.num_ctx,16384);await assert.rejects(waitForOwnReady(own,{log(){},request:async()=>({server:'ready',num_ctx:16384})}),/custom model readiness profile could not be confirmed/);});

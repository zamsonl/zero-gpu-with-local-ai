import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {RELAY_ORIGIN,createOwnKaggleSession,requestOwnShutdown,validatePersonalSession,promptHiddenToken} from '../kaggle-session.mjs';
import {launchAgent,parseOptions} from '../start.mjs';

const TOKEN='KGAT_'+ 'dummy_personal_credential_1234567890';
const SESSION_ID='personalsession1234567890';
const CLIENT_ID='attempt-12345678901234567890';
const NOW=Date.parse('2026-11-05T00:00:00Z');
const session=()=>({session_id:SESSION_ID,relay:RELAY_ORIGIN+'/_agent/'+SESSION_ID,key:'helper_private_key_12345678901234567890',host:'kaggle',owner:'testuser',expires_at:new Date(NOW+12*3600000).toISOString(),url:'https://www.kaggle.com/code/testuser/qwen-agent-'+SESSION_ID});
const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});

test('deleted-notebook choice is explicit and only safe recovery metadata reaches setup',async()=>{
  let body;await createOwnKaggleSession({token:TOKEN,consent:true,confirmDeletedNotebooks:true,now:NOW,fetcher:async(_url,options)=>{body=JSON.parse(options.body);return response(session());}});assert.equal(body.confirm_deleted_notebooks,true);
  await assert.rejects(createOwnKaggleSession({token:TOKEN,consent:true,confirmDeletedNotebooks:'yes'}),/explicit choice/);
  const notebook='https://www.kaggle.com/code/testuser/qwen-agent-'+ 'a'.repeat(24);
  for(const url of [notebook,notebook+'?token='+TOKEN,'https://attacker.invalid/code/testuser/qwen-agent-'+ 'a'.repeat(24)]){
    await assert.rejects(createOwnKaggleSession({token:TOKEN,consent:true,fetcher:async()=>Response.json({error:{code:'personal_notebook_inaccessible',can_confirm_deleted:true,notebook_url:url,launch_uncertain:true,message:TOKEN}},{status:409})}),error=>{
      assert.equal(error.code,'personal_notebook_inaccessible');assert.equal(error.launchUncertain,true);assert(!error.message.includes(TOKEN));
      assert.equal(error.canConfirmDeleted,url===notebook?true:undefined);assert.equal(error.notebookUrl,url===notebook?notebook:undefined);return true;
    });
  }
});

test('personal bootstrap sends only explicit personal token and consent to the fixed origin',async()=>{
  let request;
  const result=await createOwnKaggleSession({token:TOKEN,consent:true,clientId:CLIENT_ID,now:NOW,fetcher:async(url,options)=>{request={url,options};return response({...session(),kaggle_token:'must not be retained',unexpected:'drop'});}});
  assert.equal(request.url,RELAY_ORIGIN+'/v1/agent/sessions');assert.equal(request.options.redirect,'error');assert.equal(request.options.credentials,'omit');
  assert.deepEqual(JSON.parse(request.options.body),{kaggle_token:TOKEN,consent:true,client_id:CLIENT_ID});
  assert.equal(result.relay,session().relay);assert.equal(result.kaggle_token,undefined);assert.equal(result.unexpected,undefined);
});
test('missing consent or personal token performs no launch request',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw new Error('must not call');};
  await assert.rejects(createOwnKaggleSession({token:TOKEN,consent:false,fetcher}),/explicit consent/);
  await assert.rejects(createOwnKaggleSession({token:'',consent:true,fetcher}),/own modern Kaggle/);
  await assert.rejects(createOwnKaggleSession({token:'KGAT_'+'a'.repeat(252),consent:true,fetcher}),/own modern Kaggle/);
  assert.equal(calls,0);
});
test('global-owner, foreign, mismatched, expired or wrong-owner connections fail closed',()=>{
  for(const patch of [{relay:RELAY_ORIGIN},{relay:'https://evil.example/_agent/'+SESSION_ID},{relay:session().relay+'?key=x'},{session_id:'other_session_1234567890'},{key:'short'},{host:'colab'},{owner:'otheruser'},{url:'https://evil.example/code/testuser/qwen-agent-x'},{expires_at:new Date(NOW-1).toISOString()}])assert.throws(()=>validatePersonalSession({...session(),...patch},{now:NOW}));
});
test('bootstrap failures never echo a token or follow an owner fallback path',async()=>{
  for(const status of [400,401,403,429,500]){
    const attempts=[];await assert.rejects(createOwnKaggleSession({token:TOKEN,consent:true,now:NOW,fetcher:async(url)=>{attempts.push(url);return response({error:{message:TOKEN}},status);}}),error=>!error.message.includes(TOKEN));
    assert.deepEqual(attempts,[RELAY_ORIGIN+'/v1/agent/sessions']);
  }
  await assert.rejects(createOwnKaggleSession({token:TOKEN,consent:true,fetcher:async()=>{throw new Error(TOKEN);}}),error=>!error.message.includes(TOKEN)&&error.message.includes('--launch-id'));
});

test('provider refusals retain safe operation/status while connector cooldowns stay distinct',async()=>{
  for(const remote of [
    {code:'kaggle_refused',origin:'kaggle',operation:'SaveKernel',upstream_status:403,category:'dataset_access',launch_uncertain:false},
    {code:'kaggle_rate_limit',origin:'kaggle',operation:'SaveKernel',upstream_status:429,category:'gpu_quota',launch_uncertain:false},
    {code:'personal_launch_limit',origin:'connector',limit_kind:'daily',retry_after_seconds:83,launch_uncertain:false},
    {code:'personal_retry_cooldown',origin:'connector',retry_after_seconds:12,launch_uncertain:false},
  ]){
    const status=remote.code==='kaggle_refused'?502:429;
    await assert.rejects(createOwnKaggleSession({token:TOKEN,consent:true,now:NOW,fetcher:async()=>Response.json({error:{...remote,message:TOKEN}},{status})}),error=>{
      assert.equal(error.code,remote.code);assert.equal(error.launchUncertain,false);assert(!error.message.includes(TOKEN));assert(!error.message.includes('Forget'));
      if(remote.origin==='kaggle'){assert.match(error.message,/Kaggle refused SaveKernel/);assert.equal(error.upstreamStatus,remote.upstream_status);}else assert.match(error.message,/connector/i);
      return true;
    });
  }
});

test('accepted but unconfirmed session state survives local validation for precise startup logs',()=>{
  assert.equal(validatePersonalSession({...session(),launch_state:'unknown'},{now:NOW}).launch_state,'unknown');
  assert.equal(validatePersonalSession({...session(),launch_state:TOKEN},{now:NOW}).launch_state,undefined);
});
test('shutdown can target only the validated personal namespace',async()=>{
  let called;await requestOwnShutdown(session(),{fetcher:async(url,options)=>{called={url,options};return response({ok:true});}});
  assert.equal(called.url,session().relay+'/v1/server/shutdown');assert.equal(called.options.headers['x-relay-key'],session().key);assert.equal(called.options.redirect,'error');
  let calls=0;await assert.rejects(requestOwnShutdown({...session(),relay:RELAY_ORIGIN},{fetcher:async()=>calls++}));assert.equal(calls,0);
});
test('hidden token entry does not echo credential text and restores terminal mode',async()=>{
  const input=new EventEmitter();input.isTTY=true;input.isRaw=false;let paused=true;input.isPaused=()=>paused;input.resume=()=>{paused=false;};input.pause=()=>{paused=true;};input.setRawMode=value=>{input.isRaw=value;};
  let printed='';const output={isTTY:true,write:value=>printed+=value};
  const entered=promptHiddenToken({input,output});input.emit('data',TOKEN+'\r');assert.equal(await entered,TOKEN);assert(!printed.includes(TOKEN));assert.equal(input.isRaw,false);assert.equal(paused,true);assert.equal(input.listenerCount('data'),0);
});
test('hidden entry cancellation clears listeners and does not launch',async()=>{
  const input=new EventEmitter();input.isTTY=true;input.isRaw=false;input.isPaused=()=>false;input.resume=()=>{};input.setRawMode=value=>input.isRaw=value;
  let printed='';const entered=promptHiddenToken({input,output:{isTTY:true,write:value=>printed+=value}});input.emit('data',TOKEN+'\u0003');await assert.rejects(entered,/cancelled/);assert(!printed.includes(TOKEN));assert.equal(input.listenerCount('data'),0);assert.equal(input.isRaw,false);
});

function launcherDeps(){
  const order=[],logs=[];let closed=0,shutdown=0;
  const config=session();
  const deps={log:value=>logs.push(value),openWorkspace:async()=>{order.push('folder');return {root:'owned-project'};},promptToken:async()=>{order.push('token');return TOKEN;},confirmUsage:async()=>{order.push('consent');return true;},createSession:async options=>{order.push('launch');assert.equal(options.token,TOKEN);assert.equal(options.consent,true);assert.equal(options.clientId,CLIENT_ID);return config;},startServer:async options=>{order.push('local');assert.equal(options.config,config);return {url:'http://127.0.0.1:1234/#local-pairing-token',close:async()=>closed++};},shutdownSession:async value=>{assert.equal(value,config);shutdown++;}};
  return {deps,config,order,logs,get closed(){return closed;},get shutdown(){return shutdown;}};
}
test('launcher validates folder before prompting and never reads an owner config',async()=>{
  const fixture=launcherDeps();const result=await launchAgent(['--folder','owned-project','--launch-id',CLIENT_ID,'--no-browser'],fixture.deps);
  assert.deepEqual(fixture.order,['folder','token','consent','launch','local']);assert(!fixture.logs.join('\n').includes(TOKEN));
  await Promise.all([result.close(),result.close()]);assert.equal(fixture.closed,1);assert.equal(fixture.shutdown,1);
  assert.throws(()=>parseOptions(['--config','owner.json']),/no longer supported/);assert.throws(()=>parseOptions(['--port','70000']));
});
test('declined consent or invalid folder cannot spend GPU allocation',async()=>{
  const fixture=launcherDeps();fixture.deps.confirmUsage=async()=>false;assert.equal(await launchAgent(['--folder','owned-project','--no-browser'],fixture.deps),null);assert(!fixture.order.includes('launch'));
  const invalid=launcherDeps();invalid.deps.openWorkspace=async()=>{throw new Error('bad folder');};await assert.rejects(launchAgent(['--folder','missing'],invalid.deps),/bad folder/);assert.deepEqual(invalid.order,[]);
});
test('explicit token file and GPU consent flag still create only a personal session',async()=>{
  const fixture=launcherDeps();fixture.deps.readTokenFile=async file=>{assert.equal(file,'private-token.txt');return TOKEN+'\n';};fixture.deps.promptToken=async()=>{throw new Error('must not prompt');};fixture.deps.confirmUsage=async()=>{throw new Error('explicit consent already supplied');};
  const running=await launchAgent(['--folder','owned-project','--kaggle-token-file','private-token.txt','--consent-kaggle-gpu','--launch-id',CLIENT_ID,'--no-browser'],fixture.deps);await running.close();assert.equal(fixture.shutdown,1);
});
test('local bind failure requests cleanup of only the just-created personal notebook',async()=>{
  const fixture=launcherDeps();fixture.deps.startServer=async()=>{throw new Error('bind failed');};await assert.rejects(launchAgent(['--folder','owned-project','--launch-id',CLIENT_ID,'--no-browser'],fixture.deps),/bind failed/);assert.equal(fixture.shutdown,1);
});
test('cancelling while launch confirmation is pending shuts down only that personal session',async()=>{
  const fixture=launcherDeps();const cancellation=new AbortController();fixture.deps.signal=cancellation.signal;
  let confirm;fixture.deps.createSession=()=>new Promise(resolve=>confirm=resolve);
  const running=launchAgent(['--folder','owned-project','--launch-id',CLIENT_ID,'--no-browser'],fixture.deps);
  for(let i=0;i<10&&!confirm;i++)await Promise.resolve();assert(confirm);cancellation.abort();confirm(fixture.config);
  assert.equal(await running,null);assert.equal(fixture.shutdown,1);assert(!fixture.order.includes('local'));
});

test('custom GGUF URL is forwarded only to the personal bootstrap and other hosts fail before a launch',async()=>{let calls=0;await assert.rejects(createOwnKaggleSession({token:'KGAT_fixture_01234567890123456789',consent:true,modelUrl:'https://ollama.com/library/qwen',fetcher:async()=>{calls++;}}),/Hugging Face GGUF only/);assert.equal(calls,0);});

test('a service that does not confirm the selected GGUF is stopped before model use',async()=>{const id='fixture-session-1234567890',calls=[],own={session_id:id,relay:RELAY_ORIGIN+'/_agent/'+id,key:'a'.repeat(64),owner:'alice',host:'kaggle',url:'https://www.kaggle.com/code/alice/qwen-agent-fixture',expires_at:new Date(Date.now()+3600000).toISOString()};await assert.rejects(createOwnKaggleSession({token:'KGAT_fixture_01234567890123456789',consent:true,modelUrl:'https://huggingface.co/example/model-GGUF',fetcher:async(url)=>{calls.push(url);return Response.json(url.endsWith('/v1/agent/sessions')?own:{ok:true});}}),/custom model launch could not be confirmed/);assert.equal(calls.length,2);assert.equal(calls[1],own.relay+'/v1/server/shutdown');});

test('a confirmed custom GGUF source succeeds and its canonical URL is preserved',async()=>{const id='fixture-session-1234567890',source='https://huggingface.co/example/model-GGUF/blob/main/model-Q4_K_M.gguf';const profile={source_url:source,label:'Selected GGUF',context:16384,quant:'Q4_K_M',num_batch:128,profile_id:'hfgguf:'+'a'.repeat(24)};let calls=0;const own=await createOwnKaggleSession({token:'KGAT_fixture_01234567890123456789',consent:true,modelUrl:source.replace('/blob/','/resolve/')+'?download=true',fetcher:async(url,options)=>{calls++;assert.equal(JSON.parse(options.body).model_url,source);return Response.json({session_id:id,relay:RELAY_ORIGIN+'/_agent/'+id,key:'a'.repeat(64),owner:'alice',host:'kaggle',url:'https://www.kaggle.com/code/alice/qwen-agent-fixture',expires_at:new Date(Date.now()+3600000).toISOString(),model_profile:profile});}});assert.equal(own.model_profile.source_url,source);assert.equal(calls,1);});

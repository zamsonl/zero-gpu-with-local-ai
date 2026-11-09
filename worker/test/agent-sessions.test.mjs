import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {AgentStateDB} from '../src/agent-sessions.js';
import {startStack,WORKER_DIR} from './dev-stack.mjs';
import {startMockOllama} from './mock-ollama.mjs';

const ALICE='KGAT_alice_012345678901234567890123';
const BOB='KGAT_bob_01234567890123456789012345';
const OWNER='KGAT_owner_MUST_NEVER_BE_USED_12345';
const accounts=new Map([[ALICE,'alice'],[BOB,'bob']]);
const clientIds={alice:randomUUID(),bob:randomUUID()};
const action={action:'answer',message:'Personal Qwen fixture complete.',path:'',content:'',command:'',query:'',offset:0};
let stack,kaggleServer,aliceModel,bobModel,aliceProxy,bobProxy,alice,bob;
const pushes=[],calls=[],statuses=new Map(),lostSaveAck=new Set(),saveRefusals=new Map(),inventories=new Map(),quotas=new Map();
async function personalKaggle(req,res){
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw||'{}');const token=(req.headers.authorization||'').replace(/^Bearer /,'');
  const owner=accounts.get(token);calls.push({path:req.url,token,body});
  const respond=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(!owner)return respond({message:'Rejected supplied test credential.'},401);
  if(req.url.endsWith('/IntrospectToken'))return respond({active:body.token===token,username:owner});
  if(req.url.endsWith('/ListKernels')){const pages=inventories.get(owner);const result=typeof pages==='function'?await pages(body):pages;return result?.http?respond({error:{message:'Inventory unavailable'}},result.http):respond(result||{});}
  if(req.url.endsWith('/GetAcceleratorQuotaStatistics')){const result=quotas.get(owner);return result?.http?respond({error:{message:'Quota unavailable'}},result.http):respond(result||{gpuQuota:{timeReserved:'0s'}});}
  if(req.url.endsWith('/SaveKernel')){pushes.push({owner,body});if(lostSaveAck.delete(owner)){req.socket.destroy();return;}const refused=saveRefusals.get(owner);if(refused)return respond(refused.body||{error:{code:refused.status,message:'Dataset permission refused '+token}},refused.status);return respond({versionNumber:1,url:`https://www.kaggle.com/code/${body.slug}`});}
  if(req.url.endsWith('/GetKernelSessionStatus')){const status=statuses.has(body.kernelSlug)?statuses.get(body.kernelSlug):'RUNNING';return typeof status==='object'?respond({error:{message:'Fixture lookup unavailable'}},status.http):respond({status});}
  return respond({message:'No such mocked Kaggle method'},404);
}
const jsonRequest=(url,body,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
const bootstrap=(token,client_id=clientIds[accounts.get(token)],extra={})=>jsonRequest(stack.url+'/v1/agent/sessions',{kaggle_token:token,consent:true,client_id,...extra});
const helper=(session,path,body)=>body===undefined?fetch(session.relay+path,{headers:{'x-relay-key':session.key}}):jsonRequest(session.relay+path,body,{'x-relay-key':session.key});
const launchToken=session=>/^LAUNCH_TOKEN = "([a-f0-9]{64})"$/m.exec(pushes.find(p=>p.body.slug.endsWith('/qwen-agent-'+session.session_id.slice(0,24))).body.text)[1];
const notebook=(session,path,body)=>body===undefined?fetch(session.relay+path,{headers:{'x-launch-token':launchToken(session)}}):jsonRequest(session.relay+path,body,{'x-launch-token':launchToken(session)});
const registration=target=>({target,host:'kaggle',quant:'Q5_K_P',num_ctx:98304,num_batch:256,inference_transport:'jobs-v1',job_max_leg_seconds:300,vision:false,control:true,mode:'chat'});
const records=async response=>(await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
async function jobsProxy(target){
  const child=spawn('python',['test/jobs-proxy-fixture.py',target],{cwd:WORKER_DIR,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',data=>errors=(errors+data).slice(-2000));
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Python jobs fixture did not start: '+errors));},15000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);if(!output.includes('\n'))reject(new Error('Jobs fixture exited: '+code+' '+errors));});
    child.stdout.on('data',data=>{output+=data;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).url);}catch(error){reject(error);}}});
  });
  return {url,close:async()=>{if(child.exitCode!==null)return;const ended=once(child,'exit');child.stdin.end('\n');const timer=setTimeout(()=>child.kill(),5000);try{await ended;}finally{clearTimeout(timer);}}};
}

before(async()=>{
  kaggleServer=http.createServer((req,res)=>void personalKaggle(req,res).catch(()=>res.writeHead(500).end()));
  await new Promise(resolve=>kaggleServer.listen(11574,'127.0.0.1',resolve));
  stack=await startStack({port:8873,mockPort:11573,state:'.test-state/agent-personal-'+Date.now(),vars:{KAGGLE_API_BASE:'http://127.0.0.1:11574',KAGGLE_API_TOKEN:OWNER,KAGGLE_USERNAME:'owner',KAGGLE_CACHE_DATASET:'owner/private-cache/1',KAGGLE_CACHE_ID:'owner-private-cache',TIMING_SCALE:'0.1'}});
  aliceModel=await startMockOllama({port:11575});bobModel=await startMockOllama({port:11576});
  aliceModel.configure({tokenDelayMs:0,agentOutput:JSON.stringify(action)});bobModel.configure({tokenDelayMs:0,agentOutput:JSON.stringify(action)});
  aliceProxy=await jobsProxy(aliceModel.url);bobProxy=await jobsProxy(bobModel.url);
});
after(async()=>{await aliceProxy?.close();await bobProxy?.close();await stack?.stop();await aliceModel?.close();await bobModel?.close();if(kaggleServer)await new Promise(resolve=>kaggleServer.close(resolve));});

test('namespace adapter rejects arbitrary tables, global keys and literal SQL',()=>{
  let bound;
  const db=new AgentStateDB({prepare:sql=>({bind:(...args)=>{bound=args;return {run:async()=>({meta:{changes:1}})};}})},'a'.repeat(40));
  assert.throws(()=>db.prepare('SELECT * FROM chats'));
  assert.throws(()=>db.prepare("SELECT v FROM state WHERE k = 'target'"));
  assert.throws(()=>db.prepare('SELECT v FROM state WHERE k = ?1').bind('owner-secret'));
  db.prepare('INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at WHERE json_extract(state.v, \'$.heartbeat\') < ?4').bind('gen_lock','{}','now','old');
  assert.equal(bound[0],'agent:data:'+'a'.repeat(40)+':gen_lock');
  db.prepare('SELECT v FROM state WHERE k = ?1').bind('opencode_overflow');
  assert.equal(bound[0],'agent:data:'+'a'.repeat(40)+':opencode_overflow');
});
test('missing consent or personal token never invokes owner Kaggle credentials',async()=>{
  const before=calls.length;
  assert.equal((await jsonRequest(stack.url+'/v1/agent/sessions',{consent:false,kaggle_token:ALICE})).status,400);
  assert.equal((await jsonRequest(stack.url+'/v1/agent/sessions',{consent:true})).status,400);
  assert.equal(calls.length,before);
  const invalid=await bootstrap('KGAT_invalid_01234567890123456789',randomUUID());
  assert.equal(invalid.status,401,JSON.stringify({error:await invalid.clone().json(),paths:calls.map(c=>c.path)}));
  assert(calls.every(c=>c.token!==OWNER));assert.equal(pushes.length,0);
});
test('personal launch uses token identity, private unique notebook and code-only exact model',async()=>{
  const a=await bootstrap(ALICE),b=await bootstrap(BOB);assert.equal(a.status,201,JSON.stringify({error:await a.clone().json(),paths:calls.map(c=>c.path)}));assert.equal(b.status,201);
  alice=await a.json();bob=await b.json();
  assert.equal(alice.owner,'alice');assert.equal(bob.owner,'bob');assert.notEqual(alice.session_id,bob.session_id);assert.notEqual(alice.key,bob.key);
  assert.equal(alice.relay,stack.url+'/_agent/'+alice.session_id);
  for(const {owner,body}of pushes){
    assert(body.slug.startsWith(owner+'/qwen-agent-'));assert.equal(body.isPrivate,true);assert.deepEqual(body.datasetDataSources,[]);assert.equal(body.enableGpu,true);
    assert.match(body.text,/AGENT_ONLY = True/);assert.match(body.text,/QUANT = "Q5_K_P"/);assert.match(body.text,/CONTEXTS = \[98304\]/);assert.match(body.text,/BATCH_SIZE = 256/);
    assert.match(body.text,/max_job_seconds=7200, max_stream_seconds=300/);
    assert(!body.text.includes(OWNER));assert(!body.text.includes(ALICE));assert(!body.text.includes(BOB));assert(!body.text.includes('owner/private-cache/1'));
  }
  const stored=JSON.stringify(await stack.sql("SELECT k,v FROM state WHERE k LIKE 'agent:%'"));
  for(const secret of [ALICE,BOB,OWNER,alice.key,bob.key,launchToken(alice),launchToken(bob)])assert(!stored.includes(secret));
});
test('lost-ack retry returns same session without another GPU launch; fresh active launch is rejected',async()=>{
  const count=pushes.length;const again=await bootstrap(ALICE);assert.equal(again.status,200);const value=await again.json();assert.equal(value.key,alice.key);assert.equal(value.session_id,alice.session_id);assert.equal(pushes.length,count);
  assert.equal((await bootstrap(ALICE,randomUUID())).status,409);assert.equal(pushes.length,count);
});
test('helper/notebook credentials are scoped and cannot access owner or another session',async()=>{
  assert.equal((await fetch(bob.relay+'/v1/status',{headers:{'x-relay-key':alice.key}})).status,401);
  assert.equal((await helper(alice,'/_relay/register',registration(aliceProxy.url))).status,401);
  assert.equal((await notebook(alice,'/v1/agent/step',{messages:[{role:'user',content:'no'}]})).status,401);
  assert.equal((await helper(alice,'/v1/chats')).status,404);
  assert.equal((await helper(alice,'/v1/images',{prompt:'Must not use owner pictures'})).status,404);
  assert.equal((await notebook(alice,'/_relay/mode',{mode:'images'})).status,401);
  assert.equal((await notebook(alice,'/_relay/register',registration(stack.mock.url))).status,409,'global owner target must not be borrowed');
  assert.equal((await notebook(alice,'/_relay/register',registration(aliceProxy.url))).status,200);
  assert.equal((await notebook(bob,'/_relay/register',registration(aliceProxy.url))).status,409,'another personal target must not be borrowed');
  assert.equal((await notebook(bob,'/_relay/register',registration(bobProxy.url))).status,200);
  assert.equal((await notebook(alice,'/_relay/register',{...registration(aliceProxy.url),num_ctx:24576})).status,400);
  assert.equal((await notebook(alice,'/_relay/register',{...registration(aliceProxy.url),job_max_leg_seconds:301})).status,400);
});
test('status, startup logs and generation use only their personal namespace',async()=>{
  const globalTarget=await stack.sql("SELECT v FROM state WHERE k='target'");
  const status=await(await helper(alice,'/v1/status')).json();assert.equal(status.server,'ready');assert.equal(status.owner,'alice');assert.equal(status.num_ctx,98304);assert.equal(status.boot,null);
  const response=await helper(alice,'/v1/agent/step',{messages:[{role:'user',content:'Return an answer action.'}]});
  assert.equal(response.status,200);assert.deepEqual((await records(response)).at(-1),{event:'done',action});
  assert.equal(aliceModel.lastChat().options.num_ctx,98304);assert.equal(aliceModel.lastChat().options.num_batch,256);assert.equal(bobModel.stats().chatCalls,0);assert.equal(stack.mock.stats().chatCalls,0);
  assert.deepEqual(await stack.sql("SELECT v FROM state WHERE k='target'"),globalTarget);
  assert.equal((await(await helper(alice,'/v1/status')).json()).busy,null);
  const batch={host:'kaggle',run_id:'alice-run-'+Date.now(),started_at:new Date().toISOString(),seq:0,lines:['Personal log '+ALICE+' '+launchToken(alice)],status:'RUNNING'};
  assert.equal((await notebook(alice,'/_relay/log',batch)).status,200);
  const ownLog=await(await helper(alice,'/v1/server/log')).json();assert(ownLog.log.includes('[redacted]'));assert(!ownLog.log.includes(ALICE));assert(!ownLog.log.includes(launchToken(alice)));
  assert.equal((await(await helper(bob,'/v1/server/log')).json()).log,'');
});
test('local-window heartbeats keep only their authenticated personal notebook alive',async()=>{
  const before=await stack.sql("SELECT k,v FROM state WHERE k='client_activity'");
  const response=await helper(alice,'/v1/heartbeat',{});assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true,client_active:true,idle_minutes:120});
  assert.equal((await notebook(alice,'/v1/heartbeat',{})).status,401);
  assert.equal((await fetch(bob.relay+'/v1/heartbeat',{method:'POST',headers:{'x-relay-key':alice.key,'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await(await notebook(alice,'/_relay/command')).json()).client_active,true);
  assert.equal((await(await notebook(bob,'/_relay/command')).json()).client_active,false);
  assert.equal((await(await helper(alice,'/v1/status')).json()).client_active,true);
  assert.deepEqual(await stack.sql("SELECT k,v FROM state WHERE k='client_activity'"),before);
  const key='agent:data:'+alice.session_id+':client_activity';
  for(const at of [new Date(Date.now()-121000).toISOString(),new Date(Date.now()+60000).toISOString(),'invalid']){
    await stack.sql(`UPDATE state SET v='${JSON.stringify({at})}' WHERE k='${key}'`);
    assert.equal((await(await notebook(alice,'/_relay/command')).json()).client_active,false);
  }
  assert.equal((await helper(alice,'/v1/heartbeat',{})).status,200);
});
test('global owner lock does not block another account, malformed personal output releases its own lock',async()=>{
  const at=new Date().toISOString();await stack.sql(`INSERT OR REPLACE INTO state(k,v,updated_at) VALUES ('gen_lock','${JSON.stringify({owner:'owned-global-lock',chat_id:'owner',heartbeat:at,since:at})}','${at}')`);
  try{
    aliceModel.configure({agentOutput:'invalid JSON'});
    const response=await helper(alice,'/v1/agent/step',{messages:[{role:'user',content:'malformed test'}]});assert.equal(response.status,200);assert.equal((await records(response)).at(-1).event,'error');
    assert.equal((await(await helper(alice,'/v1/status')).json()).busy,null);
    const global=await stack.sql("SELECT v FROM state WHERE k='gen_lock'");assert.equal(JSON.parse(global[0].v).owner,'owned-global-lock');
  }finally{await stack.sql("DELETE FROM state WHERE k='gen_lock' AND json_extract(v,'$.owner')='owned-global-lock'");aliceModel.configure({agentOutput:JSON.stringify(action)});}
});
test('personal Stop cancels only that session inference and leaves the owner lock untouched',async()=>{
  aliceModel.configure({firstTokenDelayMs:2500});
  const response=await helper(alice,'/v1/agent/step',{messages:[{role:'user',content:'wait for stop'}]});
  const reading=records(response);
  const stopped=await(await helper(alice,'/v1/stop',{})).json();assert.equal(stopped.stopped,true);
  assert(!(await reading).some(e=>e.event==='done'));
  for(let i=0;i<30;i++){if(!(await(await helper(alice,'/v1/status')).json()).busy)break;await delay(100);}
  assert.equal((await(await helper(alice,'/v1/status')).json()).busy,null);aliceModel.configure({firstTokenDelayMs:0});
});
test('notebook command renews only its matching active generation and conveys scoped Stop',async()=>{
  const owner='12345678-1234-1234-1234-123456789abc',other='22345678-1234-1234-1234-123456789abc';
  const key='agent:data:'+alice.session_id+':gen_lock';
  const target=JSON.parse((await stack.sql("SELECT v FROM state WHERE k='agent:data:"+alice.session_id+":target'"))[0].v).target;
  const earlier=new Date(Date.now()-20000).toISOString(),holder={owner,chat_id:'opencode',since:earlier,heartbeat:earlier};
  await stack.sql(`INSERT OR REPLACE INTO state(k,v,updated_at) VALUES ('${key}','${JSON.stringify(holder)}','${earlier}')`);
  const read=async()=>JSON.parse((await stack.sql("SELECT v FROM state WHERE k='"+key+"'"))[0].v);
  const command=async(active,host=target)=>notebook(alice,'/_relay/command?target='+encodeURIComponent(host)+'&active_generation='+active);
  assert.equal((await command(other)).status,200);assert.equal((await read()).heartbeat,earlier);
  assert.equal((await command(owner,'https://wrong.trycloudflare.com')).status,200);assert.equal((await read()).heartbeat,earlier);
  const refreshed=await command(owner);assert.equal(refreshed.status,200);assert.deepEqual((await refreshed.json()).stop_generations,[]);assert((await read()).heartbeat>earlier);
  assert.equal((await command('bad-owner')).status,400);
  await helper(alice,'/v1/stop',{});const stopped=await command(owner);assert.deepEqual((await stopped.json()).stop_generations,[owner]);assert((await read()).stop);
  await stack.sql("DELETE FROM state WHERE k='"+key+"'");
});

test('shutdown while queued and after registration stays personal and prevents new inference',async()=>{
  const result=await(await helper(alice,'/v1/server/shutdown',{})).json();assert.equal(result.owner,'alice');
  const command=await(await notebook(alice,'/_relay/command')).json();assert.equal(command.shutdown,true);assert.equal(command.idle_minutes,120);assert.equal(command.client_active,false);assert.equal(command.mode,'chat');
  assert.equal((await helper(alice,'/v1/heartbeat',{})).status,409);
  assert.equal((await(await notebook(bob,'/_relay/command')).json()).shutdown,false);
  assert.deepEqual(await stack.sql("SELECT v FROM state WHERE k='shutdown'"),[]);
  const count=aliceModel.stats().chatCalls;assert.equal((await helper(alice,'/v1/agent/step',{messages:[{role:'user',content:'must not run'}]})).status,409);assert.equal(aliceModel.stats().chatCalls,count);
  assert.equal((await notebook(alice,'/_relay/unregister',{target:aliceProxy.url})).status,200);
  assert.equal((await(await helper(alice,'/v1/status')).json()).server,'offline');
});
test('a completed notebook cannot reuse a stale target or silently reactivate the session',async()=>{
  const batch={host:'kaggle',run_id:'bob-final-'+Date.now(),started_at:new Date().toISOString(),seq:0,lines:['Owned notebook finished'],status:'COMPLETE'};
  assert.equal((await notebook(bob,'/_relay/log',batch)).status,200);
  assert.equal((await(await helper(bob,'/v1/status')).json()).server,'offline');
  const calls=bobModel.stats().chatCalls;assert.equal((await helper(bob,'/v1/agent/step',{messages:[{role:'user',content:'Must not revive.'}]})).status,410);assert.equal(bobModel.stats().chatCalls,calls);
  assert.equal((await notebook(bob,'/_relay/register',registration(bobProxy.url))).status,410);
  assert.equal((await(await notebook(bob,'/_relay/command')).json()).shutdown,true);
});
test('a queued personal launch can be marked cancelled before any target registers',async()=>{
  const token='KGAT_test_charlie_01234567890123456789';accounts.set(token,'charlie');
  const response=await bootstrap(token,randomUUID());assert.equal(response.status,201);const session=await response.json();
  assert.equal((await helper(session,'/v1/server/shutdown',{})).status,200);
  const command=await(await notebook(session,'/_relay/command')).json();assert.equal(command.shutdown,true);assert.equal(command.registered,false);
  assert.deepEqual(await stack.sql("SELECT v FROM state WHERE k='shutdown'"),[]);
});
test('agent-only notebook exits before downloads when cancelled, and enforces idle cutoff without relay',()=>{
  const program=String.raw`
import ast, pathlib, time, urllib.parse
source=pathlib.Path('src/kaggle-server.py').read_text(encoding='utf-8')
tree=ast.parse(source)
functions={node.name:node for node in tree.body if isinstance(node,ast.FunctionDef)}
logs=[]
def forbidden(): raise AssertionError('Cancelled notebook reached model/runtime setup')
namespace={'RUNTIME_HOST':'kaggle','RELAY_HEADER':'x-launch-token','NotebookLogReporter':lambda *a,**k:object(),'RELAY':'owned','LAUNCH_TOKEN':'owned','time':time,'AGENT_ONLY':True,'log':logs.append,'relay':lambda *a,**k:{'shutdown':True},'models_dir':forbidden}
exec(compile(ast.Module(body=[functions['main']],type_ignores=[]),'personal-main-fixture','exec'),namespace)
namespace['main']()
assert any('cancelled before startup' in line for line in logs)
class Clock:
    current=0
    def time(self): return self.current
    def sleep(self,seconds): self.current+=7201
class Pictures:
    def __init__(self): self.stopped=False
    def prepare(self): raise AssertionError('Agent-only notebook prepared pictures')
    def stop(self): self.stopped=True
clock=Clock();pictures=Pictures();calls=[]
def relay(method,path,body=None):
    calls.append((method,path))
    if method=='GET': raise RuntimeError('Relay unavailable')
    return {}
namespace={'RUNTIME_HOST':'kaggle','time':clock,'urllib':urllib,'AGENT_ONLY':True,'PICTURES':pictures,'BATCH_SIZE':256,'PROFILE_ID':'personal','relay':relay,'report':lambda *a,**k:None,'log':logs.append,'requests_served':lambda:0,'gpu_busy':lambda:False,'STARTED':0,'MAX_RUNTIME_S':24000,'IMAGE_POLL_S':2,'CHAT_POLL_S':10,'TUNNEL_CHECK_S':30}
exec(compile(ast.Module(body=[functions['serve']],type_ignores=[]),'personal-serve-fixture','exec'),namespace)
namespace['serve'](98304,False,'Q5_K_P','owned-target')
assert pictures.stopped
assert any('2 hours' in line for line in logs)
clock.current=0
def active_relay(method,path,body=None):
    if method=='GET': return {'registered':True,'mode':'chat','idle_minutes':120,'client_active':True,'client_idle_seconds':0,'shutdown':clock.current>=10800}
    return {}
def hourly_sleep(seconds): clock.current+=3600
clock.sleep=hourly_sleep
namespace['relay']=active_relay
namespace['reachable']=lambda url: True
namespace['serve'](98304,False,'Q5_K_P','owned-target')
assert clock.current==10800, clock.current
assert pictures.stopped
clock.current=0
def minute_sleep(seconds): clock.current+=60
def vanished_client(method,path,body=None):
    if method=='GET': return {'registered':True,'mode':'chat','idle_minutes':120,'client_active':clock.current<=120,'client_idle_seconds':clock.current}
    return {}
clock.sleep=minute_sleep
namespace['relay']=vanished_client
namespace['serve'](98304,False,'Q5_K_P','owned-target')
assert clock.current==7200, clock.current
print('Personal cancellation and offline idle backstop passed')
`;
  const result=spawnSync('python',['-c',program],{cwd:WORKER_DIR,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/backstop passed/);
});
test('lost SaveKernel acknowledgement preserves launch identity without automatically starting twice',async()=>{
  const token='KGAT_test_dave_012345678901234567890123';accounts.set(token,'dave');lostSaveAck.add('dave');const launchId=randomUUID();const before=pushes.length;
  const first=await bootstrap(token,launchId);assert.equal(first.status,202);const session=await first.json();assert.equal(session.launch_state,'unknown');assert.equal(pushes.length,before+1);
  const retry=await bootstrap(token,launchId);assert.equal(retry.status,200);const recovered=await retry.json();assert.equal(recovered.session_id,session.session_id);assert.equal(recovered.key,session.key);assert.equal(pushes.length,before+1);
});

async function failedLaunchFixture(owner,{refusalBody,clientId}={}){
  const token='KGAT_'+owner+'_012345678901234567890123';accounts.set(token,owner);saveRefusals.set(owner,{status:400,...(refusalBody?{body:refusalBody}:{})});
  const response=await bootstrap(token,clientId??randomUUID());assert.equal(response.status,502);
  const error=(await response.json()).error;assert.equal(error.upstream_status,400);assert.equal(error.origin,'kaggle');assert.equal(error.launch_uncertain,false);assert(!JSON.stringify(error).includes(token));
  const metadata=(await stack.sql("SELECT k,v FROM state WHERE k LIKE 'agent:session:%'")).map(row=>({key:row.k,...JSON.parse(row.v)})).find(meta=>meta.owner===owner);
  assert.equal(metadata.launch_error.confirmed_refusal,true);
  return {token,metadata,error};
}
async function ageLaunchReservation(id){
  const rows=await stack.sql("SELECT k,v FROM state WHERE k LIKE 'agent:rate:%'");
  const row=rows.find(row=>JSON.parse(row.v).launches.some(launch=>launch.id===id));assert(row);
  const value=JSON.parse(row.v);for(const launch of value.launches)launch.at=new Date(Date.now()-5*60000).toISOString();
  await stack.sql("UPDATE state SET v='"+JSON.stringify(value).replaceAll("'","''")+"' WHERE k='"+row.k+"'");
}
test('confirmed refusals use a short retry delay without consuming the daily GPU launch allowance',async()=>{
  const owner='refusedcounter',first=await failedLaunchFixture(owner),before=pushes.length;
  const quick=await bootstrap(first.token,randomUUID());assert.equal(quick.status,429);
  const blocked=(await quick.json()).error;assert.equal(blocked.code,'personal_retry_cooldown');assert.equal(blocked.origin,'connector');assert(blocked.retry_after_seconds<=30);assert.equal(pushes.length,before);
  let id=first.metadata.id;
  for(let attempt=0;attempt<8;attempt++){
    await ageLaunchReservation(id);
    const response=await bootstrap(first.token,randomUUID());assert.equal(response.status,502);assert.equal((await response.json()).error.code,'kaggle_refused');
    const row=(await stack.sql("SELECT v FROM state WHERE k LIKE 'agent:session:%' AND json_extract(v,'$.owner')='"+owner+"' ORDER BY updated_at DESC LIMIT 1"))[0];id=JSON.parse(row.v).id;
  }
  assert.equal(pushes.length,before+8,'Nine refused submissions must not hit an eight accepted-launch limit');
});

test('SaveKernel HTTP503 stays unknown and same-reference reconciliation never submits a second notebook',async()=>{
  const owner='ambiguoussave',token='KGAT_'+owner+'_01234567890123456789',clientId=randomUUID();accounts.set(token,owner);saveRefusals.set(owner,{status:503});
  const before=pushes.length,first=await bootstrap(token,clientId);assert.equal(first.status,202);
  const session=await first.json();assert.equal(session.launch_state,'unknown');
  const metadata=JSON.parse((await stack.sql("SELECT v FROM state WHERE k='agent:session:"+session.session_id+"'"))[0].v);
  assert.equal(metadata.launch_error.upstream_status,503);assert.equal(metadata.launch_error.confirmed_refusal,false);
  const retry=await bootstrap(token,clientId);assert.equal(retry.status,200);assert.equal((await retry.json()).session_id,session.session_id);assert.equal(pushes.length,before+1);
  const other=await bootstrap(token,randomUUID());assert.equal(other.status,409);assert.equal((await other.json()).error.code,'personal_session_active');assert.equal(pushes.length,before+1);
});

for(const state of ['RUNNING',404,503,''])test(`legacy failed reservations reconcile Kaggle ${state||'empty status'} before any new launch`,async()=>{
  const owner='legacy'+(String(state).toLowerCase()||'empty'),{token,metadata}=await failedLaunchFixture(owner);
  delete metadata.key;delete metadata.launch_error;
  await stack.sql("UPDATE state SET v='"+JSON.stringify(metadata).replaceAll("'","''")+"' WHERE k='agent:session:"+metadata.id+"'");
  await ageLaunchReservation(metadata.id);statuses.set(metadata.slug,typeof state==='number'?{http:state}:state);saveRefusals.delete(owner);
  const before=pushes.length,response=await bootstrap(token,randomUUID());
  if(state===404){assert.equal(response.status,409);assert.equal((await response.json()).error.code,'personal_notebook_inaccessible');assert.equal(pushes.length,before);}
  else{assert.equal(response.status,409);assert.equal((await response.json()).error.code,state==='RUNNING'?'personal_session_active':'personal_launch_unconfirmed');assert.equal(pushes.length,before);}
});

test('a string provider error is classified without leaking its token or private URL',async()=>{
  const token='KGAT_fixture_redaction_canary_0123456789';
  const result=await failedLaunchFixture('stringfailure',{refusalBody:{error:'GPU quota exhausted '+token+' https://private.trycloudflare.com/account'}});
  assert.equal(result.error.category,'gpu_quota');assert.equal(result.error.upstream_status,400);
  assert(!JSON.stringify(result).includes('private.trycloudflare.com'));
  assert(!JSON.stringify(result.metadata).includes(token));assert(!JSON.stringify(result.error).includes(token));
});

async function legacyForbidden(owner,{state='failed',fresh=false,target=false}={}){
  const {token,metadata}=await failedLaunchFixture(owner);delete metadata.key;delete metadata.launch_error;
  metadata.launch_state=state;if(!fresh)metadata.created_at=new Date(Date.now()-10*60000).toISOString();
  await stack.sql("UPDATE state SET v='"+JSON.stringify(metadata).replaceAll("'","''")+"' WHERE k='agent:session:"+metadata.id+"'");
  if(target)await stack.sql("INSERT INTO state(k,v,updated_at) VALUES('agent:data:"+metadata.id+":target','{}','"+new Date().toISOString()+"')");
  await ageLaunchReservation(metadata.id);statuses.set(metadata.slug,{http:403});saveRefusals.delete(owner);
  return {token,metadata};
}
test('status403 is not absence: explicit deletion confirmation is required before inventory recovery',async()=>{
  const {token,metadata}=await legacyForbidden('forbiddenchoice'),before=pushes.length,reads=calls.length;
  const response=await bootstrap(token,randomUUID());assert.equal(response.status,409);
  const error=(await response.json()).error;assert.equal(error.code,'personal_notebook_inaccessible');assert.equal(error.can_confirm_deleted,true);
  assert(error.notebook_url.endsWith('/'+metadata.slug));assert.equal(pushes.length,before);
  assert(!calls.slice(reads).some(call=>call.path.endsWith('/ListKernels')));
});
test('explicit recovery checks every owned page and zero GPU reservation, then retires only old unconfirmed tracking',async()=>{
  const owner='recoverdeleted',{token,metadata}=await legacyForbidden(owner),before=pushes.length;
  inventories.set(owner,body=>body.pageToken?{kernels:[]}:{kernels:[{ref:owner+'/unrelated',author:owner,slug:'unrelated',isPrivate:true}],nextPageToken:'next'});
  const client=randomUUID(),response=await bootstrap(token,client,{confirm_deleted_notebooks:true});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
  assert.equal(pushes.length,before+1);
  const old=JSON.parse((await stack.sql("SELECT v FROM state WHERE k='agent:session:"+metadata.id+"'"))[0].v);
  assert(old.ended_at);assert.equal(old.recovery.kind,'operator_confirmed_missing_legacy');assert.equal(old.launch_error,undefined);
  const pages=calls.filter(call=>call.token===token&&call.path.endsWith('/ListKernels'));assert.equal(pages.length,2);
  assert.equal(pages[0].body.group,'PROFILE');assert.equal(pages[0].body.user,'');assert.equal(pages[1].body.pageToken,'next');assert.equal(pages[1].body.page,undefined);
  assert.equal((await bootstrap(token,client)).status,200);assert.equal(pushes.length,before+1);
});
for(const scenario of ['present','foreign','null-list','loop-page','inventory403','reserved','quota-missing','quota503','unknown','creating','launched','fresh','registered','string-error','quota-envelope','race-progress','race-metadata','race-heartbeat'])test(`deleted-notebook recovery stays blocked for ${scenario}`,async()=>{
  const owner='blocked'+scenario.replaceAll('-',''),{token,metadata}=await legacyForbidden(owner,{state:['unknown','creating','launched'].includes(scenario)?scenario:'failed',fresh:scenario==='fresh',target:scenario==='registered'}),before=pushes.length;
  if(scenario==='present')inventories.set(owner,body=>body.pageToken?{kernels:[{ref:owner+'/'+metadata.slug,author:owner,slug:metadata.slug}]}:{kernels:[],nextPageToken:'second'});
  if(scenario==='foreign')inventories.set(owner,{kernels:[{ref:'anotherowner/missing',author:'anotherowner',slug:'missing'}]});
  if(scenario==='null-list')inventories.set(owner,{kernels:null});
  if(scenario==='loop-page')inventories.set(owner,{kernels:[],nextPageToken:'repeat'});
  if(scenario==='string-error')inventories.set(owner,{code:'403',message:'private error envelope'});
  if(scenario==='quota-envelope')quotas.set(owner,{code:'403',gpuQuota:{timeReserved:'0s'}});
  if(scenario.startsWith('race-'))inventories.set(owner,async()=>{
    if(scenario==='race-metadata')await stack.sql("UPDATE state SET v=json_set(v,'$.launch_state','launched') WHERE k='agent:session:"+metadata.id+"'");
    else{const key=scenario==='race-progress'?'boot':'client_activity',value=scenario==='race-progress'?{stage:'loading'}:{at:new Date().toISOString()};await stack.sql("INSERT OR REPLACE INTO state(k,v,updated_at) VALUES('agent:data:"+metadata.id+":"+key+"','"+JSON.stringify(value)+"','"+new Date().toISOString()+"')");}
    return {};
  });
  if(scenario==='inventory403')inventories.set(owner,{http:403});
  if(scenario==='reserved')quotas.set(owner,{gpuQuota:{timeReserved:'0.001s'}});
  if(scenario==='quota-missing')quotas.set(owner,{});
  if(scenario==='quota503')quotas.set(owner,{http:503});
  const response=await bootstrap(token,randomUUID(),{confirm_deleted_notebooks:true});assert(response.status>=400,scenario);assert.equal(pushes.length,before);
  const old=JSON.parse((await stack.sql("SELECT v FROM state WHERE k='agent:session:"+metadata.id+"'"))[0].v);assert.equal(old.ended_at,undefined);
  assert(!calls.some(call=>call.token===OWNER));
});
test('recovery confirmation cannot be a truthy string',async()=>{
  const before=calls.length,response=await bootstrap(ALICE,randomUUID(),{confirm_deleted_notebooks:'yes'});assert.equal(response.status,400);assert.equal(calls.length,before);
});

test('an in-flight reservation with no metadata cannot be bypassed by a second launch identity',async()=>{
  const owner='reservationgap',token='KGAT_fixture_reservationgap_01234567890123',id='e'.repeat(40);accounts.set(token,owner);
  const key='agent:rate:'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(owner))).toString('hex');
  await stack.sql("INSERT INTO state(k,v,updated_at) VALUES('"+key+"','"+JSON.stringify({launches:[{id,at:new Date().toISOString()}]})+"','"+new Date().toISOString()+"')");
  const before=pushes.length,response=await bootstrap(token,randomUUID());assert.equal(response.status,503);assert.equal(pushes.length,before);
  assert.equal((await response.json()).error.code,'personal_launch_busy');
  await ageLaunchReservation(id);assert.equal((await bootstrap(token,randomUUID())).status,201);assert.equal(pushes.length,before+1);
});

for(let round=0;round<3;round++)test(`concurrent creators cannot both submit around an aged orphan reservation (${round})`,async()=>{
  const owner='orphanrace'+round,clientId=randomUUID(),{token,metadata}=await failedLaunchFixture(owner,{clientId});
  await stack.sql("DELETE FROM state WHERE k='agent:session:"+metadata.id+"'");
  await ageLaunchReservation(metadata.id);saveRefusals.delete(owner);
  const before=pushes.length,responses=await Promise.all([bootstrap(token,clientId),bootstrap(token,randomUUID())]);
  assert.equal(pushes.length,before+1,'Only one creator may submit to Kaggle');
  assert.equal(responses.filter(response=>response.status===201).length,1);
  assert.equal(responses.filter(response=>response.status>=400).length,1);
});

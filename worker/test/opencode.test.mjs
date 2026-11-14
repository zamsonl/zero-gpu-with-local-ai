import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import fs from 'node:fs/promises';
import {HttpError,errorJson,json,readJsonObject} from '../src/http.js';
import {JobsTransportError,createJobBudget} from '../src/jobs-transport.js';
import {OPENCODE_MODEL,OPENCODE_REQUEST_MS,OPENCODE_JOB_LEG_SECONDS,OpenCodeEventWriter,parseOpenCodeRequest,waitOpenCodeIdle} from '../src/opencode.js';
import {startStack,WORKER_DIR,RELAY_KEY} from './dev-stack.mjs';

const tool={type:'function',function:{name:'read_file',description:'Read a file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}};
const input=extra=>({model:OPENCODE_MODEL,messages:[{role:'user',content:'Inspect this project.'}],...extra});
const done=extra=>({model:OPENCODE_MODEL,done:true,done_reason:'stop',prompt_eval_count:123,eval_count:7,...extra});
const packet=message=>({model:OPENCODE_MODEL,message,done:false});
const parseSse=text=>text.split(/\r?\n\r?\n/).flatMap(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data: ')).map(line=>line.slice(6))).map(value=>value==='[DONE]'?value:JSON.parse(value));
const request=(url,body,key)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(key?{authorization:'Bearer '+key}:{})},body:JSON.stringify(body)});
const gatewaySource=(await fs.readFile(new URL('../src/opencode.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
async function timingFixture({profile,queueMs=0,busyAttempts=0,run,jobLegSeconds=300,jobControl=true,legacyProfile=false,ensureActive=async()=>{},extra={},signal}={}){
  let now=0,next=1,lockCalls=0,releases=0,jobCalls=0,dbQueries=3;const timers=new Map();
  // Include route auth+preflight, and conservatively charge all six possible
  // internal CAS queries for each mocked GenerationLock.acquire invocation.
  const state=new Map();const db={prepare:sql=>{dbQueries++;return {bind:(key,value)=>({first:async()=>state.has(key)?{v:state.get(key)}:null,run:async()=>{if(sql.startsWith('DELETE'))state.delete(key);else state.set(key,value);return {meta:{changes:1}};}})};}};
  const advance=ms=>{now+=ms;for(const[id,timer]of[...timers])if(timer.at<=now){timers.delete(id);timer.callback();}};
  const lock={id:'00000000-0000-4000-8000-000000000001',startHeartbeat(){assert.fail('Long requests must not start D1 heartbeat timers');},watchForStop(){assert.fail('Long requests must not start D1 polling timers');},async release(){releases++;dbQueries++;}};
  const target={target:'https://fixture.invalid',host:'kaggle',quant:'Q5_K_P',num_ctx:98304,num_batch:256,vision:false,inference_transport:'jobs-v1',job_max_leg_seconds:jobLegSeconds,job_control:jobControl};
  if(legacyProfile)delete target.job_max_leg_seconds;
  if(profile)Object.assign(target,{quant:profile.quant,num_ctx:profile.context,num_batch:128,profile_id:profile.profile_id,thinking:profile.thinking});
  const deps={HttpError,errorJson,json,readJsonObject,JobsTransportError,createJobBudget,Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},
    setTimeout:(callback,ms)=>{const id=next++;timers.set(id,{callback,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async()=>new Response('{"busy":false}\n'),
    GenerationLock:{acquire:async()=>{dbQueries+=6;lockCalls++;return lockCalls<=busyAttempts||(lockCalls===1&&queueMs)?{busy:{chat_id:'another-request'}}:{lock};}},readTarget:async()=>{dbQueries++;return target;},
    sleep:async(_ms,signal)=>{advance(queueMs);signal.throwIfAborted();},
    streamJobRecords:async function*(options){jobCalls++;yield*run({advance,options,call:jobCalls});},
  };
  const openCodeChat=new Function('deps','with(deps){'+gatewaySource+';return openCodeChat;}')(deps);
  const response=await openCodeChat({request:new Request('https://fixture.invalid/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input({stream:false,...extra})),signal}),env:{...(profile?{AGENT_MODEL_PROFILE:profile}:{}),AGENT_SESSION:true,AGENT_CONTROL_KEY:'f'.repeat(64),DB:db},ctx:{},ensureActive:async()=>{dbQueries+=2;await ensureActive();}});
  return {response,value:await response.json(),releases,jobCalls,timers,elapsed:now,state,dbQueries,lockCalls};
}
let stack,kaggle,model,proxy,alice,bob,ownerTarget,records=[],modelCalls=[],aborted=0,pushes=[],plan=[],nextPlans=[],active=0,maxActive=0;

async function listen(handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};}
async function pythonJobs(target,...control){
  const child=spawn('python',['test/jobs-proxy-fixture.py',target,...control],{cwd:WORKER_DIR,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stderr.on('data',data=>errors=(errors+data).slice(-2000));
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Python jobs fixture failed: '+errors));},15000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);if(!output.includes('\n'))reject(new Error('Python jobs fixture exited '+code+': '+errors));});
    child.stdout.on('data',data=>{output+=data;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).url);}catch(error){reject(error);}}});
  });
  return {url,close:async()=>{if(child.exitCode!==null)return;const ended=once(child,'exit');child.stdin.end('\n');const timer=setTimeout(()=>child.kill(),5000);try{await ended;}finally{clearTimeout(timer);}}};
}
const sessionPath=(session,path)=>session.relay+path;
const chat=(body=input({stream:true}),session=alice)=>request(sessionPath(session,'/v1/chat/completions'),body,session.key);
const get=(session,path,key=session.key)=>fetch(sessionPath(session,path),{headers:{'x-relay-key':key}});
async function eventually(check){for(let i=0;i<60;i++){if(await check())return;await delay(100);}assert.fail('Condition did not become true.');}
async function inspectSql(sql){
  assert.match(sql,/^SELECT\b/i);
  for(let attempt=0;;attempt++)try{return await stack.sql(sql);}catch(error){
    const known=error.message.includes('SQLITE_BUSY')||error.message.includes('D1DatabaseObject.queryExecute')&&error.message.includes('internal error');
    if(attempt>=2||!known)throw error;
    await delay(100*(attempt+1));
  }
}
async function removeFixtureOwnerLock(){
  // Local CLI inspection shares SQLite with the live fixture's frequent lease
  // writes. Retry only this idempotent test cleanup on confirmed SQLITE_BUSY.
  for(let attempt=0;;attempt++)try{return await stack.sql("DELETE FROM state WHERE k='gen_lock'");}catch(error){
    if(attempt>=2||!error.message.includes('SQLITE_BUSY'))throw error;
    await delay(150*(attempt+1));
  }
}

before(async()=>{
  kaggle=await listen(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}');
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    const owner=token.includes('alice')?'alice':token.includes('bob')?'bob':null;
    const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(!owner)return send({error:'Invalid personal fixture token.'},401);
    if(req.url.endsWith('/IntrospectToken'))return send({active:true,username:owner});
    if(req.url.endsWith('/SaveKernel')){pushes.push({owner,body});return send({ref:body.slug,url:'https://www.kaggle.com/code/'+body.slug,versionNumber:1});}
    if(req.url.endsWith('/GetKernelSessionStatus'))return send({status:'RUNNING'});
    send({},404);
  });
  model=await listen(async(req,res)=>{
    if(req.url==='/api/version'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"version":"fixture"}');}
    if(req.url==='/api/ps'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({models:[{name:OPENCODE_MODEL}]}));}
    if(req.url!=='/api/chat'){res.writeHead(404);return res.end();}
    let raw='';for await(const part of req)raw+=part;modelCalls.push(JSON.parse(raw));active++;maxActive=Math.max(maxActive,active);res.once('close',()=>active--);
    const steps=nextPlans.length?nextPlans.shift():plan;let ended=false;req.socket.on('close',()=>{if(!ended)aborted++;});
    res.writeHead(200,{'content-type':'application/x-ndjson'});
    for(const step of steps){if(step.delay)await delay(step.delay);if(res.destroyed)return;if(step.value){records.push(step.value);res.write(JSON.stringify(step.value)+'\n');}}
    ended=true;res.end();
  });
  stack=await startStack({port:8879,mockPort:11579,state:'.test-state/opencode-'+Date.now(),vars:{KAGGLE_API_BASE:kaggle.url,KAGGLE_API_TOKEN:'KGAT_owner_MUST_NEVER_BE_USED_12345'}});
  const bootstrap=async owner=>{
    const response=await request(stack.url+'/v1/agent/sessions',{kaggle_token:'KGAT_'+owner+'_012345678901234567890123',consent:true,client_id:randomUUID()});assert.equal(response.status,201);return response.json();
  };
  alice=await bootstrap('alice');bob=await bootstrap('bob');
  const launch=/^LAUNCH_TOKEN = "([a-f0-9]{64})"$/m.exec(pushes.find(p=>p.owner==='alice').body.text)[1];
  proxy=await pythonJobs(model.url,launch,alice.relay+'/_relay/command');
  const registered=await fetch(alice.relay+'/_relay/register',{method:'POST',headers:{'content-type':'application/json','x-launch-token':launch},body:JSON.stringify({target:proxy.url,host:'kaggle',quant:'Q5_K_P',num_ctx:98304,num_batch:256,inference_transport:'jobs-v1',job_max_leg_seconds:300,job_control:true,vision:false,control:true,mode:'chat'})});assert.equal(registered.status,200);
  ownerTarget=await inspectSql("SELECT v FROM state WHERE k='target'");
});
after(async()=>{await stack?.stop();await proxy?.close();await model?.close();await kaggle?.close();});

test('request conversion preserves typed text, native tools and matched results',()=>{
  const parsed=parseOpenCodeRequest(input({tools:[tool],messages:[
    {role:'developer',content:[{type:'text',text:'Use tools.'}]},
    {role:'user',content:[{type:'text',text:'first'},{type:'text',text:'second'}]},
    {role:'assistant',content:null,tool_calls:[{id:'call_old',type:'function',function:{name:'read_file',arguments:'{"path":"README.md"}'}}]},
    {role:'tool',tool_call_id:'call_old',content:[{type:'text',text:'# Project'}]},
  ]}));
  assert.equal(parsed.body.messages[0].role,'system');assert.equal(parsed.body.messages[1].content,'firstsecond');
  assert.deepEqual(parsed.body.messages[2].tool_calls[0].function,{index:0,name:'read_file',arguments:{path:'README.md'}});
  assert.deepEqual(parsed.body.messages[3],{role:'tool',tool_call_id:'call_old',tool_name:'read_file',content:'# Project'});
  assert.deepEqual(parsed.body.tools,[tool]);assert.equal(parsed.body.format,undefined);
  assert.equal(parsed.body.options.num_ctx,98304);assert.equal(parsed.body.options.num_batch,256);assert.equal(parsed.body.options.num_predict,16384);assert.equal(parsed.body.think,'medium');assert.equal(parsed.body.truncate,false);assert.equal(parsed.body.shift,false);
  assert.equal(parseOpenCodeRequest(input({tools:[tool],tool_choice:'none'})).body.tools,undefined);
});

test('thinking is enabled by default and supported effort settings preserve explicit off',()=>{
  assert.equal(parseOpenCodeRequest(input()).body.think,'medium');
  for(const [reasoning_effort,think]of [['none',false],['minimal','low'],['low','low'],['medium','medium'],['high',true],['xhigh',true],['max',true]])assert.equal(parseOpenCodeRequest(input({reasoning_effort})).body.think,think);
  for(const reasoning_effort of ['unexpected',false,0,{}])assert.throws(()=>parseOpenCodeRequest(input({reasoning_effort})),error=>error.status===400&&error.code==='invalid_request_error');
});

test('a continuation summary never thinks, whatever thinking mode its turn used',()=>{
  const summary=[{role:'system',content:'Summarize this coding session for continuation using the exact section structure requested. Preserve the current user goal.'},{role:'user',content:'Inspect this project.'},{role:'user',content:'Write the summary.'}];
  for(const reasoning_effort of ['none','low','medium','high'])assert.equal(parseOpenCodeRequest(input({messages:summary,reasoning_effort})).body.think,false);
  assert.equal(parseOpenCodeRequest(input({messages:summary,reasoning_effort:'high',tools:[tool],tool_choice:'none'})).body.think,false);
  // A coding request keeps its mode even when the summary wording appears in its instructions.
  assert.equal(parseOpenCodeRequest(input({messages:summary,reasoning_effort:'high',tools:[tool]})).body.think,true);
  assert.equal(parseOpenCodeRequest(input({reasoning_effort:'high'})).body.think,true);
});

test('custom non-thinking GGUF inference uses its measured context and never the 96K default',async()=>{const profile={context:8192,quant:'Q4_K_M',profile_id:'hfgguf:'+'a'.repeat(24),thinking:false};let payload;const f=await timingFixture({profile,run:async function*({options}){payload=JSON.parse(options.payload);yield {value:packet({content:'Custom model answer.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};}});assert.equal(f.response.status,200);assert.equal(payload.options.num_ctx,8192);assert.equal(payload.options.num_batch,128);assert.equal(payload.options.num_predict,2048);assert.equal(payload.think,undefined);assert.equal(f.value.choices[0].message.content,'Custom model answer.');assert(f.releases>0);});

test('a model can prefill beyond six minutes and still return visible thinking within the two-hour request',async()=>{
  const f=await timingFixture({run:async function*({advance,options}){
    assert.equal(options.legSeconds,300);assert.equal(options.prefillLegSeconds,300);assert.equal(options.maxJobMs,OPENCODE_REQUEST_MS);
    advance(8*60_000);assert.equal(options.signal.aborted,false);yield {value:packet({thinking:'Long prefill completed.'}),upstreamStatus:200};
    advance(10*60_000);yield {value:packet({content:'Answer.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};
  }});
  assert.equal(f.response.status,200);assert.equal(f.value.choices[0].message.reasoning_content,'Long prefill completed.');assert.equal(f.value.choices[0].message.content,'Answer.');assert.equal(f.timers.size,0);assert(f.releases>0);
});

test('queue time is included in the same two-hour deadline and streaming output does not reset it',async()=>{
  const queued=await timingFixture({queueMs:8*60_000,run:async function*({options}){assert.equal(options.maxJobMs,OPENCODE_REQUEST_MS-8*60_000);yield {value:packet({content:'After queue.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};}});
  assert.equal(queued.response.status,200);
  const expired=await timingFixture({run:async function*({advance,options}){advance(30*60_000);yield {value:packet({thinking:'Still thinking.'}),upstreamStatus:200};advance(90*60_000);assert.equal(options.signal.aborted,true);yield {value:done(),upstreamStatus:200};}});
  assert.equal(expired.response.status,400);assert.equal(expired.value.error.code,'model_timeout');assert.match(expired.value.error.message,/two-hour/);assert.equal(expired.jobCalls,1);assert(expired.releases>0);assert.equal(expired.timers.size,0);
  const waiting=await timingFixture({queueMs:OPENCODE_REQUEST_MS,run:async function*(){assert.fail('An expired queued request cannot start inference');}});
  assert.equal(waiting.response.status,400);assert.equal(waiting.value.error.code,'model_timeout');assert.equal(waiting.jobCalls,0);
});

test('an older short-leg personal notebook is refused with a clear upgrade instruction before inference',async()=>{
  for(const extra of [{legacyProfile:true},{jobLegSeconds:120},{jobControl:false}])await assert.rejects(timingFixture({...extra,run:async function*(){assert.fail('The old notebook cannot start inference');}}),error=>error.status===409&&error.code==='personal_profile'&&error.message.includes('updated connector'));
});

test('two-hour personal inference stays below the free D1 query ceiling without poll timers',async()=>{
  const f=await timingFixture({busyAttempts:5,run:async function*({options,advance}){for(let i=0;i<8;i++)await options.reloadTarget();advance(OPENCODE_REQUEST_MS-1);yield {value:packet({content:'Complete.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};}});
  assert.equal(f.response.status,200);assert.equal(f.lockCalls,6);assert.equal(f.dbQueries,49);assert(f.dbQueries<50);assert.equal(f.timers.size,0);
  const busy=await timingFixture({busyAttempts:9,run:async function*(){assert.fail('A constantly contested queue cannot start a model job');}});
  assert.equal(busy.response.status,503);assert.equal(busy.value.error.code,'queue_busy');assert.equal(busy.lockCalls,6);assert(busy.dbQueries<50);
});

test('the notebook idle control uses authenticated bounded waits and one shared external-request budget',async()=>{
  const budget=createJobBudget(40),calls=[];const controller=new AbortController();
  await waitOpenCodeIdle({target:'https://fixture.invalid',controlKey:'f'.repeat(64),signal:controller.signal,deadline:Date.now()+60000,requestBudget:budget,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(calls.length===1?'{"busy":true}\n':'{"busy":false}'+ ' '.repeat(16384)+'\n');}});
  assert.equal(calls.length,2);assert.equal(budget.used,2);assert.match(calls[0].url,/\/_jobs\/control\?max_seconds=/);assert(!calls[0].url.includes('ffff'));assert.equal(calls[0].options.headers.authorization,'Bearer '+'f'.repeat(64));assert.equal(calls[0].options.redirect,'manual');
  await assert.rejects(waitOpenCodeIdle({target:'https://fixture.invalid',controlKey:'f'.repeat(64),signal:controller.signal,deadline:Date.now()+60000,requestBudget:{used:34,limit:40},fetchImpl:async()=>assert.fail('The reserved job budget must not be spent waiting')}),error=>error.code==='queue_connection_limit');
  let invalid=0;await assert.rejects(waitOpenCodeIdle({target:'https://fixture.invalid',controlKey:'f'.repeat(64),signal:controller.signal,deadline:Date.now()+60000,requestBudget:createJobBudget(40),fetchImpl:async()=>{invalid++;return new Response('{"busy":false,"unexpected":"data"}\n');}}),error=>error.code==='queue_unreachable');assert.equal(invalid,3);
  controller.abort(new Error('Stop queue'));await assert.rejects(waitOpenCodeIdle({target:'https://fixture.invalid',controlKey:'f'.repeat(64),signal:controller.signal,deadline:Date.now()+60000,requestBudget:createJobBudget(40),fetchImpl:async()=>assert.fail('Cancelled queue cannot fetch')}),/Stop queue/);
});

test('a non-model context error cannot become tokenizer overflow or advance recovery state',async()=>{
  const f=await timingFixture({ensureActive:async()=>{throw new Error('Application context is unavailable');},run:async function*(){assert.fail('No model request should start');}});
  assert.equal(f.response.status,502);assert.equal(f.value.error.code,'model_error');assert.equal(f.jobCalls,0);assert.equal(f.state.size,0);
});

test('a reasoning-only reply limit gets one measured thinking-off finish pass under the same budget and deadline',async()=>{
  let budget;
  const f=await timingFixture({run:async function*({call,advance,options}){
    const body=JSON.parse(options.payload);
    if(call===1){budget=options.requestBudget;assert.equal(budget.limit,40);advance(30*60_000);yield {value:packet({thinking:'Verified work to finish.'}),upstreamStatus:200};yield {value:done({done_reason:'length',prompt_eval_count:70000,eval_count:8192}),upstreamStatus:200};return;}
    assert.equal(call,2);assert.equal(options.requestBudget,budget);assert.equal(options.maxJobMs,90*60_000);assert.equal(body.think,false);assert.equal(body.options.num_predict,4096);
    assert.equal(body.messages.at(-2).role,'assistant');assert(body.messages.at(-2).content.includes('Verified work to finish.'));assert.match(body.messages.at(-1).content,/final answer now/);
    yield {value:packet({content:'Finished answer.'}),upstreamStatus:200};yield {value:done({prompt_eval_count:78300,eval_count:45}),upstreamStatus:200};
  }});
  assert.equal(f.response.status,200);assert.equal(f.jobCalls,2);assert.equal(f.value.choices[0].message.reasoning_content,'Verified work to finish.');assert.equal(f.value.choices[0].message.content,'Finished answer.');assert.deepEqual(f.value.usage,{prompt_tokens:78300,completion_tokens:8237,total_tokens:86537,completion_tokens_details:{reasoning_tokens:8192}});
});

test('the single finishing pass honors the remaining window and requires genuine usage measurements',async()=>{
  for(const [prompt,expected,status]of [[87040,1024,200],[87041,null,413],[undefined,null,502]]){
    const f=await timingFixture({run:async function*({call,options}){
      if(call===1){yield {value:packet({thinking:'Saved work.'}),upstreamStatus:200};yield {value:done({done_reason:'length',prompt_eval_count:prompt,eval_count:8192}),upstreamStatus:200};return;}
      assert.equal(JSON.parse(options.payload).options.num_predict,expected);yield {value:packet({content:'Answer.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};
    }});
    assert.equal(f.response.status,status);assert.equal(f.jobCalls,status===200?2:1);
    if(status===413)assert.equal(f.value.error.code,'context_length_exceeded');
    if(status===502)assert.equal(f.value.error.code,'reasoning_finish_unavailable');
  }
});

test('empty finishing output, incomplete tools and unknown streams cannot cause an extra reasoning retry',async()=>{
  for(const ending of [done({done_reason:'length'}),done()]){
    const f=await timingFixture({run:async function*({call}){yield {value:packet({thinking:'Saved work.'}),upstreamStatus:200};yield {value:call===1?done({done_reason:'length'}):ending,upstreamStatus:200};}});
    assert.equal(f.response.status,502);assert.equal(f.value.error.code,'reasoning_finish_incomplete');assert.equal(f.jobCalls,2);
  }
  const unknown=await timingFixture({run:async function*(){yield {value:packet({thinking:'Partial work.'}),upstreamStatus:200};throw new JobsTransportError('upstream_eof','The stream ended without a terminal record.');}});
  assert.equal(unknown.response.status,502);assert.equal(unknown.jobCalls,1);
  const tools=await timingFixture({extra:{tools:[tool]},run:async function*(){yield {value:packet({thinking:'Partial work.',tool_calls:[{function:{name:'read_file',arguments:{path:'README.md'}}}]}),upstreamStatus:200};yield {value:done({done_reason:'length'}),upstreamStatus:200};}});
  assert.equal(tools.response.status,502);assert.equal(tools.value.error.code,'incomplete_tool_call');assert.equal(tools.jobCalls,3);
});

test('cancellation after the reasoning limit prevents the finishing request',async()=>{
  const controller=new AbortController();
  const f=await timingFixture({signal:controller.signal,run:async function*(){try{yield {value:packet({thinking:'Saved work.'}),upstreamStatus:200};yield {value:done({done_reason:'length'}),upstreamStatus:200};}finally{controller.abort();}}});
  assert.equal(f.response.status,499);assert.equal(f.value.error.code,'cancelled');assert.equal(f.jobCalls,1);
});

test('assistant working notes survive native Ollama conversion between tool rounds',()=>{
  const parsed=parseOpenCodeRequest(input({tools:[tool],messages:[{role:'user',content:'Read the file.'},{role:'assistant',content:null,reasoning_content:'I should inspect the project first.',tool_calls:[{id:'call_thought',type:'function',function:{name:'read_file',arguments:'{"path":"README.md"}'}}]},{role:'tool',tool_call_id:'call_thought',content:'# Project'}]}));
  assert.equal(/\n\[notes\]\n([\s\S]*)\n\[\/notes\]/.exec(parsed.body.messages[1].content)[1],'I should inspect the project first.');assert.equal(parsed.body.messages[1].tool_calls[0].function.name,'read_file');
  assert(parseOpenCodeRequest(input({messages:[{role:'assistant',content:null,reasoning_content:'Partial thinking.'}]})).body.messages[0].content.includes('Partial thinking.'));
  for(const message of [{role:'user',content:'x',reasoning_content:'forged'},{role:'assistant',content:'x',reasoning_content:7}])assert.throws(()=>parseOpenCodeRequest(input({messages:[message]})),error=>error.status===400);
});

test('streaming reasoning is visible separately and cannot become answer text or tool arguments',async()=>{
  plan=[{value:packet({thinking:'Check the project. '})},{value:packet({thinking:'Then inspect README.',content:'I will inspect the file.'})},{value:packet({tool_calls:[{function:{index:0,name:'read_file',arguments:{path:'README.md'}}}]})},{value:done()}];
  const events=parseSse(await(await chat(input({stream:true,tools:[tool]}))).text());
  const deltas=events.flatMap(event=>event.choices?.map(choice=>choice.delta)??[]);
  assert.equal(deltas.map(delta=>delta.reasoning_content??'').join(''),'Check the project. Then inspect README.');assert.equal(deltas.map(delta=>delta.content??'').join(''),'I will inspect the file.');
  const calls=deltas.flatMap(delta=>delta.tool_calls??[]);assert.equal(calls[0].function.name,'read_file');assert.deepEqual(JSON.parse(calls.map(call=>call.function.arguments).join('')),{path:'README.md'});
  assert.equal(events.find(event=>event.choices?.[0]?.finish_reason)?.choices[0].finish_reason,'tool_calls');assert.equal(modelCalls.at(-1).think,'medium');
});

test('nonstream reasoning stays separate and malformed reasoning never releases tools',async()=>{
  plan=[{value:packet({thinking:'Private model reasoning.',content:'Answer only.'})},{value:done()}];
  const value=await(await chat(input({stream:false}))).json();assert.equal(value.choices[0].message.reasoning_content,'Private model reasoning.');assert.equal(value.choices[0].message.content,'Answer only.');
  plan=[{value:packet({thinking:5,tool_calls:[{function:{index:0,name:'read_file',arguments:{path:'README.md'}}}]})},{value:done()}];
  const events=parseSse(await(await chat(input({stream:true,tools:[tool]}))).text());assert(events.some(event=>event.error?.code==='invalid_model_response'));assert(!events.some(event=>event.choices?.[0]?.delta?.tool_calls));
});

test('streaming a reasoning-limit finish keeps native tools separate and releases them only on terminal success',async()=>{
  const before=modelCalls.length;
  nextPlans=[
    [{value:packet({thinking:'Inspect README using the saved plan.'})},{value:done({done_reason:'length'})}],
    [{value:packet({tool_calls:[{function:{index:0,name:'read_file',arguments:'{"path":'}}]})},{delay:100,value:packet({tool_calls:[{function:{index:0,arguments:'"README.md"}'}}]})},{value:done()}],
  ];
  let events=parseSse(await(await chat(input({stream:true,tools:[tool]}))).text());
  assert.equal(modelCalls.length,before+2);assert.equal(modelCalls.at(-1).think,false);assert.equal(/\n\[notes\]\n([\s\S]*)\n\[\/notes\]/.exec(modelCalls.at(-1).messages.at(-2).content)[1],'Inspect README using the saved plan.');
  assert.equal(events.flatMap(e=>e.choices?.map(c=>c.delta.reasoning_content??'')??[]).join(''),'Inspect README using the saved plan.');
  const calls=events.flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);assert.equal(calls[0].function.name,'read_file');assert.deepEqual(JSON.parse(calls.map(c=>c.function.arguments).join('')),{path:'README.md'});assert.equal(events.find(e=>e.choices?.[0]?.finish_reason)?.choices[0].finish_reason,'tool_calls');
  nextPlans=[
    [{value:packet({thinking:'Saved work.'})},{value:done({done_reason:'length'})}],
    [{value:packet({tool_calls:[{function:{name:'read_file',arguments:{path:'README.md'}}}]})},{value:{error:'upstream failed'}}],
  ];
  events=parseSse(await(await chat(input({stream:true,tools:[tool]}))).text());assert(events.some(e=>e.error));assert(!events.some(e=>e.choices?.[0]?.delta?.tool_calls));assert(!events.some(e=>e.choices?.[0]?.finish_reason));assert.equal(nextPlans.length,0);
});

test('real Python jobs transport recovers a terminal tool-parser error once without releasing failed actions',async()=>{
  const before=modelCalls.length;
  nextPlans=[
    [{value:packet({thinking:'Preserve the complete source checkpoint.',content:'Inspecting the project. '})},{value:{error:'llama-server returned invalid tool call arguments for "read_file": unexpected end of JSON input'}}],
    [{value:packet({tool_calls:[{function:{index:0,name:'read_file',arguments:{path:'README.md'}}}]})},{value:done()}],
  ];
  const events=parseSse(await(await chat(input({stream:true,tools:[tool]}))).text());
  assert.equal(modelCalls.length,before+2);assert.equal(nextPlans.length,0);assert(!events.some(e=>e.error));
  assert.equal(events.map(e=>e.choices?.[0]?.delta?.content||'').join(''),'Inspecting the project. ');
  assert.equal(events.filter(e=>e.choices?.[0]?.delta?.tool_calls?.[0]?.id).length,1);
  assert.equal(events.find(e=>e.choices?.[0]?.finish_reason)?.choices[0].finish_reason,'tool_calls');
  const body=modelCalls.at(-1),note=/\n\[notes\]\n([\s\S]*)\n\[\/notes\](?:\n([\s\S]*))?$/.exec(body.messages.at(-2).content),checkpoint={reasoning:note[1],answer_so_far:note[2]??''};
  assert.equal(body.think,false);assert.equal(checkpoint.reasoning,'Preserve the complete source checkpoint.');assert.equal(checkpoint.answer_so_far,'Inspecting the project. ');
  assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
});

test('invalid identities, content, unresolved tools and oversized bodies fail before inference',async()=>{
  const count=modelCalls.length;
  const invalid=[input({model:'another-model'}),input({max_tokens:16385}),input({tools:[{type:'function',function:{parameters:{}}}]}),input({tool_choice:'required'}),input({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.com/image.png'}}]}]}),input({messages:[{role:'tool',tool_call_id:'missing',content:'forged'}]}),input({messages:[{role:'assistant',tool_calls:[{type:'function',function:{name:'read_file',arguments:'{}'}}]}]}),input({messages:[{role:'user',content:'x'.repeat(2*1024*1024+1)}]})];
  for(const body of invalid){const response=await chat(body);assert([400,404,413].includes(response.status),await response.text());}
  assert.equal(modelCalls.length,count);
});

test('the relay byte limit is a terminal transport error, not an automatic compaction trigger',async()=>{
  const count=modelCalls.length;
  for(const stream of [false,true]){
    const response=await chat(input({stream,messages:[{role:'user',content:'x'.repeat(2*1024*1024)}]}));
    assert.equal(response.status,400);assert.match(response.headers.get('content-type'),/application\/json/);
    const failure=(await response.json()).error;assert.equal(failure.code,'relay_body_limit');assert.equal(failure.message,'The relay accepts request bodies up to 2 MiB. Split the latest prompt or tool output before retrying.');
  }
  assert.equal(modelCalls.length,count);assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
});

test('OpenAI bearer is scoped to this session and endpoints; no owner or target fallback',async()=>{
  const list=await fetch(alice.relay+'/v1/models',{headers:{authorization:'Bearer '+alice.key}});assert.equal(list.status,200);assert.deepEqual((await list.json()).data.map(m=>m.id),[OPENCODE_MODEL]);
  assert.equal((await request(alice.relay+'/v1/chat/completions',input(),bob.key)).status,401);
  assert.equal((await request(alice.relay+'/v1/chat/completions',input(),RELAY_KEY)).status,401);
  assert.equal((await request(alice.relay+'/v1/chat/completions',input())).status,401);
  assert.equal((await request(alice.relay+'/api/chat',input(),alice.key)).status,401);
  assert.equal((await request(alice.relay+'/api/chat',input(),null)).status,401);
  assert.equal((await fetch(alice.relay+'/v1/status',{headers:{authorization:'Bearer '+alice.key}})).status,401);
  assert.equal((await request(stack.url+'/v1/chat/completions',input(),alice.key)).status,404);
  assert.equal((await chat(input(),bob)).status,503);
  assert.deepEqual(await inspectSql("SELECT v FROM state WHERE k='target'"),ownerTarget);assert.equal(stack.mock.stats().chatCalls,0);
});

test('tools-only first records survive real Python jobs transport and yield valid SSE chunks',async()=>{
  records=[];plan=[{value:packet({tool_calls:[{function:{index:0,name:'read_file',arguments:{path:'README.md'}}}]})},{delay:400,value:done()}];
  const response=await chat(input({stream:true,stream_options:{include_usage:true},tools:[tool]}));assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);assert.match(response.headers.get('cache-control'),/no-transform/);
  const events=parseSse(await response.text());assert.equal(events.at(-1),'[DONE]');
  const calls=events.flatMap(e=>e.choices?.[0]?.delta?.tool_calls??[]);assert.equal(calls.length,2);assert.equal(calls[0].function.name,'read_file');assert.equal(calls[0].type,'function');assert.match(calls[0].id,/^call_/);assert.deepEqual(JSON.parse(calls.map(c=>c.function.arguments).join('')),{path:'README.md'});
  assert.equal(events.find(e=>e.choices?.[0]?.finish_reason)?.choices[0].finish_reason,'tool_calls');assert.deepEqual(events.at(-2).usage,{prompt_tokens:123,completion_tokens:7,total_tokens:130});
  const body=modelCalls.at(-1);assert.equal(body.model,OPENCODE_MODEL);assert.deepEqual(body.tools,[tool]);assert.equal(body.format,undefined);assert.equal(body.options.num_ctx,98304);assert.equal(body.options.num_batch,256);assert.equal(body.truncate,false);assert.equal(body.shift,false);
  assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
});

test('fragmented tool arguments and parallel calls are accumulated with stable identities',async()=>{
  plan=[{value:packet({content:'Inspecting.',tool_calls:[{function:{index:0,name:'read_file',arguments:'{"path":'}}]})},{value:packet({tool_calls:[{function:{index:0,arguments:'"README.md"}'}},{function:{index:1,name:'read_file',arguments:{path:'package.json'}}}]})},{value:done()}];
  const response=await chat(input({stream:false,tools:[tool]}));assert.equal(response.status,200);const value=await response.json();assert.equal(value.choices[0].message.content,'Inspecting.');assert.equal(value.choices[0].message.tool_calls.length,2);assert.notEqual(value.choices[0].message.tool_calls[0].id,value.choices[0].message.tool_calls[1].id);assert.deepEqual(JSON.parse(value.choices[0].message.tool_calls[0].function.arguments),{path:'README.md'});
});

test('failed, truncated, unknown and malformed tool outputs expose no executable tool calls',async()=>{
  for(const tail of [done({done_reason:'length'}),{error:'model failure'},done()]){
    const args=tail.error?'{}':tail.done_reason==='length'?'{}':'{"unfinished":';
    plan=[{value:packet({tool_calls:[{function:{name:'read_file',arguments:args}}]})},{value:tail}];
    const events=parseSse(await(await chat(input({stream:true,tools:[tool]}))).text());assert(events.some(e=>e.error));assert(!events.some(e=>e.choices?.[0]?.delta?.tool_calls));assert(!events.some(e=>e.choices?.[0]?.finish_reason));
  }
  plan=[{value:packet({tool_calls:[{function:{name:'unavailable',arguments:{}}}]})},{value:done()}];assert.equal((await chat(input({tools:[tool]}))).status,502);
  plan=[{value:packet({content:'short'})},{value:done({done_reason:'length'})}];const text=await(await chat(input())).json();assert.equal(text.choices[0].finish_reason,'length');
  plan=[{value:{model:'wrong-model',message:{content:'wrong'},done:true}}];assert.equal((await chat(input())).status,502);
  plan=[{value:packet({content:'x'.repeat(1024*1024+1)})},{value:done()}];assert.equal((await chat(input())).status,502);
  assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
});

test('tokenizer overflow has the OpenAI compaction code in JSON and SSE; missing done stays an error',async()=>{
  const full='the input length exceeds the context length';
  plan=[{value:{error:full}}];
  const response=await chat(input());assert.equal(response.status,413);assert.equal((await response.json()).error.code,'context_length_exceeded');
  plan=[{value:{error:full}}];
  const events=parseSse(await(await chat(input({stream:true}))).text());const streamError=events.find(e=>e.error)?.error;assert.equal(streamError.code,'context_length_exceeded');assert.deepEqual(JSON.parse(streamError.message),{type:'error',error:{code:'context_length_exceeded',message:'The model tokenizer could not fit this input. Compact the OpenCode session.'}});assert(!events.some(e=>e.choices?.[0]?.finish_reason));
  plan=[{value:packet({content:'incomplete'})}];
  const partial=parseSse(await(await chat(input({stream:true}))).text());assert(partial.some(e=>e.error));assert(!partial.some(e=>e.choices?.[0]?.finish_reason));
  assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
});

test('repeated main overflows stop native recovery despite successful summaries; smaller main success resets it',async()=>{
  const key='agent:data:'+alice.session_id+':opencode_overflow';
  const state=async()=>{
    // Local Wrangler CLI and dev can race the Windows Miniflare D1 bookmark reader.
    // Retry only this read-only inspection and its known internal error; never inference.
    for(let attempt=0;;attempt++){
      try{const rows=await stack.sql(`SELECT v FROM state WHERE k='${key}'`);return rows.length?JSON.parse(rows[0].v):null;}
      catch(error){if(attempt>=2||!error.message.includes('D1DatabaseObject.queryExecute')||!error.message.includes('internal error'))throw error;await delay(100*(attempt+1));}
    }
  };
  const success=async extra=>{plan=[{value:packet({content:'Saved notes or answer.'})},{value:done()}];const response=await chat(input(extra));assert.equal(response.status,200);await response.text();};
  // A long tool session must reach the tokenizer/compactor even after the old
  // 1000-message ceiling, while retaining the same repeated-overflow guard.
  const longMessages=[{role:'user',content:'Continue this long tool session.'}];
  for(let i=0;i<500;i++)longMessages.push(
    {role:'assistant',content:'Read next.',tool_calls:[{id:'long_'+i,type:'function',function:{name:'read_file',arguments:'{"path":"src/a.ts"}'}}]},
    {role:'tool',tool_call_id:'long_'+i,content:'Verified file contents.'});
  assert.equal(longMessages.length,1001);assert(Buffer.byteLength(JSON.stringify(input({messages:longMessages})))<2*1024*1024);
  const overflow=async extra=>{plan=[{value:{error:'the input length exceeds the context length'}}];return chat(input({messages:longMessages,...extra}));};
  await success();assert.equal(await state(),null);
  let response=await overflow();assert.equal(response.status,413);assert.equal((await response.json()).error.code,'context_length_exceeded');assert.equal((await state()).count,1);
  await success({reasoning_effort:'none'});assert.equal((await state()).count,1,'successful summary cannot reset the main streak');
  response=await overflow({stream:true});let events=parseSse(await response.text());assert.equal(events.find(e=>e.error)?.error.code,'context_length_exceeded');assert.equal((await state()).count,2);
  plan=[{value:{error:'model unavailable'}}];response=await chat(input());assert.equal(response.status,502);await response.text();assert.equal((await state()).count,2,'unrelated model failures do not advance the streak');
  response=await overflow({reasoning_effort:'none'});assert.equal(response.status,413);await response.text();assert.equal((await state()).count,2,'a failed summary does not advance the main streak');
  await success({reasoning_effort:'none'});assert.equal((await state()).count,2);
  response=await overflow({stream:true,reasoning_effort:'none',tools:[tool]});events=parseSse(await response.text());const failure=events.find(e=>e.error)?.error;
  assert.equal(failure.code,'context_recovery_stalled');assert(!failure.message.startsWith('{'));assert.match(failure.message,/shorten the latest prompt/);assert(!events.some(e=>e.choices?.[0]?.finish_reason));assert.equal((await state()).count,3);
  const calls=modelCalls.length;response=await overflow();assert.equal(response.status,400);assert.equal((await response.json()).error.code,'context_recovery_stalled');assert.equal(modelCalls.length,calls+1,'the guard must let a smaller retry reach Qwen');
  await success({reasoning_effort:'none',tools:[tool]});assert.equal(await state(),null);
  response=await overflow();assert.equal(response.status,413);await response.text();assert.equal((await state()).count,1);
  const expired=JSON.stringify({count:2,at:Date.now()-OPENCODE_REQUEST_MS-1000});await stack.sql(`UPDATE state SET v='${expired}' WHERE k='${key}'`);
  response=await overflow();assert.equal(response.status,413);await response.text();assert.equal((await state()).count,1,'expired failures begin a new recovery streak');
  assert.deepEqual(await inspectSql("SELECT v FROM state WHERE k='opencode_overflow'"),[],'overflow state cannot reach the owner namespace');
  await success();assert.equal(await state(),null);
});

test('SSE comments pad on a fixed cadence while tokens flow and do not enter parser data',async()=>{
  const {readable,writable}=new TransformStream();const reader=readable.getReader();let raw='';const reading=(async()=>{for(;;){const next=await reader.read();if(next.done)return;raw+=new TextDecoder().decode(next.value);}})();
  let gone=false;const writer=new OpenCodeEventWriter(writable,()=>{gone=true;},{heartbeatMs:25,writeTimeoutMs:500});
  for(let i=0;i<8;i++){await writer.send({token:i});await delay(10);}await writer.done();await writer.close();await reading;
  assert(raw.split('\n\n').filter(event=>event.startsWith(':')).length>=2);assert(raw.includes(' '.repeat(16000)));assert.deepEqual(parseSse(raw),[...Array.from({length:8},(_,token)=>({token})),'[DONE]']);assert.equal(gone,false);
});

test('an unread SSE response is bounded and cancels its producer',async()=>{
  const {readable,writable}=new TransformStream();let gone=false;
  const writer=new OpenCodeEventWriter(writable,()=>{gone=true;},{heartbeatMs:10,writeTimeoutMs:30});
  await writer.send({content:'unread'});assert.equal(gone,true);await writer.close();await readable.cancel().catch(()=>{});
});

test('concurrent OpenCode title and main requests wait and run serially on one personal GPU',async()=>{
  plan=[{delay:400,value:packet({content:'complete'})},{value:done()}];const before=modelCalls.length;maxActive=0;
  const title=await chat(input({stream:true,messages:[{role:'user',content:'Create a title.'}]}));const titleRead=title.text();
  const main=await chat(input({stream:true}));assert.equal(main.status,200);
  const [a,b]=await Promise.all([titleRead,main.text()]);
  assert.equal(modelCalls.length,before+2,JSON.stringify([parseSse(a),parseSse(b)]));assert.equal(maxActive,1);
  for(const raw of [a,b]){const events=parseSse(raw);assert(events.some(e=>e.choices?.[0]?.finish_reason==='stop'));assert(!events.some(e=>e.error));}
});

test('personal generation lock, stop and response cancellation cancel jobs without touching owner',async()=>{
  plan=[{delay:8000,value:packet({content:'late'})},{value:done()}];const before=modelCalls.length,cancelled=aborted;
  const response=await chat();const reading=response.text();await eventually(()=>modelCalls.length>before);
  const at=new Date().toISOString();await stack.sql(`INSERT OR REPLACE INTO state(k,v,updated_at) VALUES ('gen_lock','${JSON.stringify({owner:'owner-lock',chat_id:'owner',heartbeat:at,since:at})}','${at}')`);
  const queued=await chat();const queuedReader=queued.body.getReader();await queuedReader.read();await queuedReader.cancel();await delay(100);assert.equal(modelCalls.length,before+1,'a cancelled waiter must not start inference');
  const stop=await fetch(alice.relay+'/v1/stop',{method:'POST',headers:{'x-relay-key':alice.key}});assert.equal((await stop.json()).stopped,true);
  const events=parseSse(await reading);assert(events.some(e=>e.error?.code==='cancelled'));await eventually(()=>aborted>cancelled);assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
  assert.equal(JSON.parse((await inspectSql("SELECT v FROM state WHERE k='gen_lock'"))[0].v).owner,'owner-lock');await removeFixtureOwnerLock();
  const start=modelCalls.length,priorAbort=aborted;const another=await chat();const reader=another.body.getReader();await reader.read();await eventually(()=>modelCalls.length>start);await reader.cancel();await eventually(()=>aborted>priorAbort);await eventually(async()=>!(await(await get(alice,'/v1/status')).json()).busy);
  assert.equal(stack.mock.stats().chatCalls,0);assert.deepEqual(await inspectSql("SELECT v FROM state WHERE k='target'"),ownerTarget);
});

test('shutdown prevents new and already queued OpenCode inference',async()=>{
  plan=[{delay:8000,value:packet({content:'late'})},{value:done()}];const before=modelCalls.length;
  const running=await chat();const reading=running.text();await eventually(()=>modelCalls.length>before);
  const queued=await chat();const queuedRead=queued.text();
  const shutdown=await fetch(alice.relay+'/v1/server/shutdown',{method:'POST',headers:{'x-relay-key':alice.key}});assert.equal(shutdown.status,200);assert.equal((await chat()).status,409);
  await fetch(alice.relay+'/v1/stop',{method:'POST',headers:{'x-relay-key':alice.key}});await reading;
  const events=parseSse(await queuedRead);assert(events.some(e=>e.error?.code==='shutting_down'));assert.equal(modelCalls.length,before+1);assert.equal((await(await get(alice,'/v1/status')).json()).busy,null);
});

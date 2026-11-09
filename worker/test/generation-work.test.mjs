import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {streamChat,streamTiming,OfflineError} from '../src/chat-stream.js';
import {UpstreamError} from '../src/ollama.js';
import {JobsTransportError,createJobBudget} from '../src/jobs-transport.js';
import {contextMessageCost,isContextOverflow,planContext,requireContextSpace} from '../src/context.js';
import {HttpError} from '../src/http.js';
import {settings} from '../src/config.js';
import {serverInfo} from '../src/target.js';
import {continuationPrompt,thinkSplitter,sampling} from '../src/prompt.js';
import {COMPACTION_MEMORY_SCHEMA,parseCompactionMemory,mergeMemory} from '../src/compaction-memory.js';
import {thinkingWorkBody,validRecovery,interruptedWorkCode,isWorkBudgetError} from '../src/reasoning-recovery.js';
import {phaseStatus,withTransportProgress,formatProgressStatus} from '../public/js/progress-status.js';

const generationSource=(await fs.readFile(new URL('../src/generation.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
const recoverySource=(await fs.readFile(new URL('../src/reasoning-recovery.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
const terminal=(mode)=>mode==='thought_eos'?{cursor:1,record:{done:true,done_reason:'stop'}}:{cursor:1,done:true,status:'failed',error:{code:mode,message:mode==='job_timeout'?'The model job exceeded its runtime limit.':mode==='upstream_eof'?'The model stream ended before completion. Please retry.':'This operation exceeded its model connection limit. Please retry with less history.'}};
async function generationFixture(mode,{recover,stop=false}={}){
  const original=globalThis.fetch;let events=[],saved=null,recoveries=0,args,identity,stopped;
  globalThis.fetch=async(_url,options={})=>{
    if(options.method==='POST'){const start=JSON.parse(new TextDecoder().decode(options.body));identity={id:start.job_id,token:start.token,cursor:0};return Response.json(identity,{status:202});}
    if(options.method==='DELETE')return Response.json({cancelled:true});
    const first={cursor:0,record:{model:'qwen3.8-hauhau',message:{thinking:'Preserved test reasoning.'},done:false}};
    return new Response(JSON.stringify(first)+'\n'+JSON.stringify(terminal(mode))+'\n');
  };
  const db={},chat={id:'fixture'},lock={startHeartbeat(){},watchForStop(callback){stopped=callback;},async release(){}};
  const deps={OfflineError,UpstreamError,isContextOverflow,createJobBudget,streamChat,streamTiming,thinkingWorkBody,interruptedWorkCode,isWorkBudgetError,phaseStatus,withTransportProgress,
    EventWriter:class{gone=false;async send(event){events.push(event);if(stop&&event.event==='thinking')stopped();}async close(){}},
    LiveReply:class{update(){}async finish(){}},
    saveAssistantMessage:async(_db,_id,fields)=>({message:saved={id:2,role:'assistant',...fields},chat}),updateAssistantMessage:async(_db,_chat,_id,fields)=>({message:saved={id:2,role:'assistant',...fields},chat}),lastMessage:async()=>saved,
    nowIso:()=>new Date().toISOString(),readTarget:async()=>({target:'https://fixture.invalid'}),requireChat:async()=>chat,
    prepareChatPlan:async()=>{throw new Error('Unexpected compaction.');},
    recoverReasoning:async options=>{recoveries++;args=options;if(recover)return recover(options);await options.onCheckpoint({version:1,notes:'[source 0–24] provisional work',through_chars:24,source_sha256:'fixture',passes:1});options.reply.content='Recovered answer.';return {final:{done:true,done_reason:'stop'},recovery:{passes:1}};},chatRequestBody(){},continuationPrompt(){},
  };
  const generate=new Function('deps','with(deps){'+generationSource+';return generate;}')(deps);
  try{await generate({}, {db,lock,chat,userMessage:{id:1},target:'https://fixture.invalid',body:{model:'qwen3.8-hauhau',think:'medium',options:{num_ctx:98304,num_batch:256,num_predict:24576}},timingScale:1,inferenceTransport:'jobs-v1',env:{DB:db},registered:{target:'https://fixture.invalid'}});}
  finally{globalThis.fetch=original;}
  return {events,saved,recoveries,args};
}

function recoveryFixture(work,{budget=createJobBudget(),signal=new AbortController().signal,think=true,initialPasses=1,interruptions=0,previousRecovery=null,pauseForBudget=false,reply={thinking:'Initial unfinished work. ',content:''},summaries=null,transport=null,numCtx=98304,realContext=false}={}){
  const requests=[],checkpoints=[],statuses=[];let count=0,summaryCount=0;
  const transcript=[{id:1,role:'user',content:'Keep ORBIT_913 and corrected port 8247.'}];
  const deps={settings,serverInfo,HttpError,streamTiming,continuationPrompt,thinkSplitter,sampling,contextMessageCost,isContextOverflow,COMPACTION_MEMORY_SCHEMA,parseCompactionMemory,mergeMemory,phaseStatus,withTransportProgress,
    readPreferences:async()=>({}),listTranscript:async()=>transcript,readCheckpoint:async()=>null,validCheckpoint:()=>null,compactablePrefix:()=>[],mappedTranscript:messages=>messages,
    planContext:realContext?planContext:({transcript})=>({messages:transcript,context:{input_budget_tokens:90000}}),requireContextSpace:realContext?requireContextSpace:()=>{},readTarget:async()=>({target:'https://fixture.invalid'}),requireChat:async()=>({id:'fixture'}),compactChatMemory:async()=>{throw new Error('Unexpected compaction.');},
    streamChat:async function*(options){
      requests.push(options);budget.used+=3;
      await options.onStatus({state:'connecting',detail:'Waiting for the model server to answer',attempt:1});
      if(transport)await options.onStatus(transport);
      if(options.body.format){
        if(summaries){yield* summaries(++summaryCount,options);return;}
        const owned=/<unfinished_assistant_source start="(\d+)" end="(\d+)">/.exec(options.body.prompt);
        const memory=Object.fromEntries(['goals','constraints','decisions','facts','artifacts','next_steps','corrections'].map(key=>[key,[]]));memory.facts=[`[characters ${owned[1]}-${owned[2]}] Provisional work; verify port 8247.`];
        yield {message:{content:JSON.stringify(memory)}};yield {done:true,done_reason:'stop'};
      }else yield*work(++count,options);
    },
  };
  const recoverReasoning=new Function('deps','with(deps){'+recoverySource+';return recoverReasoning;}')(deps);
  const run=()=>recoverReasoning({env:{DB:{},MODEL:'qwen3.8-hauhau'},chatId:'fixture',registered:{target:'https://fixture.invalid',num_ctx:numCtx,num_batch:256,inference_transport:'jobs-v1'},reply,previousRecovery,think,initialPasses,interruptions,pauseForBudget,signal,requestBudget:budget,
    onStatus:async value=>statuses.push(value),onCheckpoint:async value=>checkpoints.push(structuredClone(value)),onThinking:async text=>{reply.thinking+=text;},onContent:async text=>{reply.content+=text;},continuedId:2});
  return {run,reply,requests,checkpoints,statuses,budget};
}

test('jobs errors retain their exact typed cause through the real chat-stream parser',async()=>{
  const original=globalThis.fetch;let identity;
  globalThis.fetch=async(_url,options={})=>{
    if(options.method==='POST'){const value=JSON.parse(new TextDecoder().decode(options.body));identity={id:value.job_id,token:value.token,cursor:0};return Response.json(identity,{status:202});}
    if(options.method==='DELETE')return Response.json({});
    return new Response(JSON.stringify({...terminal('job_timeout'),cursor:0})+'\n');
  };
  try{await assert.rejects(async()=>{for await(const _ of streamChat({target:'https://fixture.invalid',inferenceTransport:'jobs-v1',body:{model:'x'},signal:new AbortController().signal,timing:streamTiming(),onStatus(){}})){}},error=>error instanceof UpstreamError&&error.code==='job_timeout'&&error.cause instanceof JobsTransportError&&error.cause.code==='job_timeout');}
  finally{globalThis.fetch=original;}
});

test('real generation enters recovery once for thought-only timeout, terminal EOF, connection loss and normal EOS',async()=>{
  for(const mode of ['job_timeout','upstream_eof','upstream_connection','thought_eos']){
    const result=await generationFixture(mode);assert.equal(result.recoveries,1);assert.equal(result.args.think,'medium');assert.equal(result.args.initialPasses,1);assert.equal(result.args.interruptions,mode==='thought_eos'?0:1);assert.equal(result.saved.status,'complete');assert.equal(result.saved.id,2);assert.equal(result.saved.stats.think,'medium');assert.equal(result.events.at(-1).event,'done');
  }
});

test('unknown model errors and Stop preserve the original no-retry behavior',async()=>{
  const unknown=await generationFixture('model_error');assert.equal(unknown.recoveries,0);assert.equal(unknown.saved.status,'error');assert.equal(unknown.events.at(-1).code,'upstream');
  const stopped=await generationFixture('job_timeout',{stop:true});assert.equal(stopped.recoveries,0);assert.equal(stopped.saved.status,'stopped');assert.equal(stopped.events.at(-1).stopped_by,'another_device');
});

test('repeated thinking windows preserve selected effort and every source span before the bounded handoff',async()=>{
  for(const think of [true,'medium','low']){
    const fixture=recoveryFixture(async function*(count){yield {message:{thinking:`Window ${count} remains provisional. `}};yield {done:true,done_reason:'stop'};},{think,budget:createJobBudget(45)});
    await assert.rejects(fixture.run,error=>error.code==='work_checkpoint');
    const work=fixture.requests.filter(o=>!o.body.format);assert.equal(work.length,3);assert(work.every(o=>o.body.think===think&&o.body.options.num_predict===2048&&o.body.options.num_ctx===98304&&o.body.options.num_batch===256&&o.body.truncate===false&&o.body.shift===false));
    const saved=fixture.checkpoints.at(-1);assert.equal(saved.through_chars,fixture.reply.thinking.length);assert(await validRecovery(saved,fixture.reply.thinking));assert.equal(saved.complete_source,true);assert.equal(fixture.reply.content,'');
  }
});

test('only one classified work interruption can recover automatically inside an invocation',async()=>{
  const first=recoveryFixture(async function*(count){if(count===1){yield {message:{thinking:'Extra interrupted work. '}};throw new UpstreamError('runtime',{code:'job_timeout'});}yield {message:{content:'Verified answer.'}};yield {done:true,done_reason:'stop'};});
  const result=await first.run();assert.equal(result.final.done_reason,'stop');assert.equal(first.reply.content,'Verified answer.');assert.equal(first.requests.filter(o=>!o.body.format).length,2);
  const repeated=recoveryFixture(async function*(){yield {message:{thinking:'Interrupted again. '}};throw new UpstreamError('runtime',{code:'job_timeout'});},{interruptions:1});
  await assert.rejects(repeated.run,error=>error.code==='recovery_failed');assert.equal(repeated.requests.filter(o=>!o.body.format).length,1);
});

test('request exhaustion produces a durable same-ID safe handoff and fresh Continue covers only the remaining source',async()=>{
  const source='Initial unfinished work. ';
  const fixture=recoveryFixture(async function*(){yield {message:{thinking:'Tail still needs notes. '}};fixture.budget.used=40;throw new UpstreamError('budget',{code:'request_limit'});});
  await assert.rejects(fixture.run,error=>error.code==='recovery_paused');const saved=fixture.checkpoints.at(-1);assert.equal(saved.through_chars,source.length);assert.equal(saved.complete_source,false);assert(await validRecovery(saved,fixture.reply.thinking));
  const fresh=recoveryFixture(async function*(){yield {message:{content:'Final answer.'}};yield {done:true,done_reason:'stop'};},{reply:fixture.reply,previousRecovery:saved,initialPasses:0});await fresh.run();
  assert(fresh.requests[0].body.prompt.includes(`start="${source.length}"`));assert(!fresh.requests[0].body.prompt.includes('start="0"'));
  const terminal=await generationFixture('request_limit',{recover:async options=>{await options.onCheckpoint(saved);throw new HttpError(409,'recovery_paused','Saved work.');}});
  assert.equal(terminal.events.at(-1).code,'recovery_paused');assert.equal(terminal.events.at(-1).message_saved.id,2);assert.equal(terminal.saved.status,'length');assert.equal(terminal.saved.stats.think,'medium');
});

test('an already exhausted budget checkpoints an honest empty prefix without starting another inference',async()=>{
  const budget=createJobBudget();budget.used=40;const fixture=recoveryFixture(async function*(){assert.fail('No model call after exhaustion.');},{budget,pauseForBudget:true});
  await assert.rejects(fixture.run,error=>error.code==='recovery_paused');assert.equal(fixture.requests.length,0);assert.equal(fixture.checkpoints.at(-1).through_chars,0);assert(await validRecovery(fixture.checkpoints.at(-1),fixture.reply.thinking));
});

test('proactive cap leaves thinking effort, context, batch and original body intact',()=>{
  const body={model:'qwen3.8-hauhau',think:'medium',truncate:false,shift:false,options:{num_ctx:98304,num_batch:256,num_predict:24576}};
  const work=thinkingWorkBody(body,'medium');assert.equal(work.options.num_predict,2048);assert.equal(body.options.num_predict,24576);assert.equal(work.think,'medium');assert.equal(work.options.num_ctx,98304);assert.equal(work.options.num_batch,256);assert.equal(thinkingWorkBody(body,false),body);
});

test('cumulative work budget survives a fresh request and produces one announced answer-only pass',async()=>{
  const source='Earlier complete provisional reasoning.';
  const recovery={version:1,notes:'[draft] Earlier provisional work, verify before answering.',through_chars:source.length,source_sha256:await (await import('../src/reasoning-recovery.js')).recoveryDigest(source),passes:11,total_work_passes:12};
  const fixture=recoveryFixture(async function*(_count,options){assert.equal(options.body.think,false);assert.equal(options.body.options.num_predict,4096);yield {message:{content:'Answer based on the preserved work.'}};yield {done:true,done_reason:'stop'};},{initialPasses:0,previousRecovery:recovery,reply:{thinking:source,content:''}});
  const result=await fixture.run();assert.equal(fixture.requests.length,1);assert.equal(result.recovery.finish_reason,'work_limit');assert.equal(result.recovery.total_work_passes,12);assert.equal(result.recovery.answer_only,true);assert.equal(result.recovery.selected_think,true);
  assert(fixture.statuses.some(status=>status.phase==='finishing'&&status.detail.includes('work limit')));assert.equal(fixture.reply.thinking,source);
});

test('three identical substantial work windows preserve every source span then finish instead of looping',async()=>{
  const repeated='Repeated provisional calculation still needs verification. '.repeat(8);
  const fixture=recoveryFixture(async function*(_count,options){if(options.body.think){yield {message:{thinking:repeated}};}else{yield {message:{content:'The best supported answer.'}};}yield {done:true,done_reason:'stop'};},{initialPasses:0,budget:createJobBudget(45)});
  const result=await fixture.run();assert.equal(fixture.requests.filter(options=>!options.body.format).length,4);assert.equal(result.recovery.finish_reason,'repeated_work');assert.equal(result.recovery.total_work_passes,3);assert.equal(result.recovery.through_chars,fixture.reply.thinking.length);assert(await validRecovery(result.recovery,fixture.reply.thinking));assert.equal(fixture.reply.thinking.split(repeated).length-1,3);
});

test('empty forced answer fails once without restarting thinking or losing the checkpoint',async()=>{
  const source='Preserved provisional source.';
  const previousRecovery={version:1,notes:'[draft] Supported provisional fact.',through_chars:source.length,source_sha256:await (await import('../src/reasoning-recovery.js')).recoveryDigest(source),passes:12,total_work_passes:12};
  const fixture=recoveryFixture(async function*(){yield {done:true,done_reason:'stop'};},{initialPasses:0,previousRecovery,reply:{thinking:source,content:''}});
  await assert.rejects(fixture.run,error=>error.code==='recovery_failed');assert.equal(fixture.requests.length,1);assert.equal(fixture.requests[0].body.think,false);assert.equal(fixture.checkpoints.at(-1).finish_reason,'work_limit');assert.equal(fixture.reply.thinking,source);
});

test('fresh request handoffs cannot reset the cumulative twelve-window bound',async()=>{
  let recovery=null,reply={thinking:'Initial source window. ',content:''},totalWork=0,final;
  for(let request=0;request<3;request++){
    const fixture=recoveryFixture(async function*(_count,options){
      if(options.body.think){totalWork++;yield {message:{thinking:`Distinct short window ${totalWork}. `}};}
      else yield {message:{content:'Bounded final answer.'}};
      yield {done:true,done_reason:'stop'};
    },{think:'medium',initialPasses:request===0?1:0,previousRecovery:recovery,reply,budget:createJobBudget(45)});
    if(request<2)await assert.rejects(fixture.run,error=>error.code==='work_checkpoint');
    else final=await fixture.run();
    recovery=fixture.checkpoints.at(-1);assert.equal(recovery.total_work_passes,Math.min((request+1)*4,12));assert.equal(recovery.selected_think,'medium');assert(await validRecovery(recovery,reply.thinking));
  }
  assert.equal(totalWork,11,'One initial and eleven recovered thought windows');assert.equal(final.recovery.finish_reason,'work_limit');assert.equal(reply.content,'Bounded final answer.');
});

test('recovery transport setup preserves summarizing/resuming phases and clears retry diagnostics on real output',async()=>{
  const fixture=recoveryFixture(async function*(){yield {message:{content:'Answer'}};yield {done:true,done_reason:'stop'};},{transport:{state:'retrying',detail:'The connection interrupted; retrying in 5 s',attempt:2}});
  await fixture.run();
  const extracting=fixture.statuses.filter(status=>status.phase==='extracting');
  assert(extracting.some(status=>status.transport_state==='connecting'));
  assert(extracting.some(status=>status.transport_state==='retrying'));
  assert(extracting.every(status=>formatProgressStatus(status).startsWith('Summarizing thinking')));
  assert.equal(extracting.at(-1).transport_state,null,'First actual summary output clears the old retry');
  const resuming=fixture.statuses.filter(status=>status.phase==='resuming');assert(resuming.length);assert(resuming.every(status=>formatProgressStatus(status).startsWith('Continuing from saved work')));
  assert(!fixture.statuses.some(status=>status.state==='connecting'));
});

test('two empty, malformed, truncated or duplicate-only terminal summaries preserve exact source then answer once',async()=>{
  const {recoveryDigest}=await import('../src/reasoning-recovery.js');
  const initial='Earlier provisional result.';
  const source='\nEXACT_PARTIAL_CALC=1297; target port is 8247. 😀 Never publish without approval.\r\n';
  const memory=Object.fromEntries(['goals','constraints','decisions','facts','artifacts','next_steps','corrections'].map(key=>[key,[]]));
  for(const mode of ['empty','malformed','truncated','duplicate']){
    const duplicate={...memory,facts:['Same earlier provisional fact.']};
    const raw=mode==='malformed'?'invalid JSON':JSON.stringify(mode==='duplicate'?duplicate:memory);
    const prior=mode==='duplicate'?{version:1,notes:mergeMemory('Prior facts stay byte-identical.\r\n',parseCompactionMemory(JSON.stringify(duplicate)),'prior source'),through_chars:initial.length,source_sha256:await recoveryDigest(initial),passes:1}:null;
    const reply={thinking:(prior?initial:'')+source,content:''};
    const fixture=recoveryFixture(async function*(_count,options){
      assert.equal(options.body.think,false);assert(options.body.prompt.includes(source));assert(options.body.prompt.includes('<verbatim_unfinished_source'));
      yield {message:{content:'PORT=8247; CALC=1297'}};yield {done:true,done_reason:'stop'};
    },{reply,previousRecovery:prior,initialPasses:0,summaries:async function*(){yield {message:{content:raw}};yield {done:true,done_reason:mode==='truncated'?'length':'stop'};}});
    const result=await fixture.run();
    assert.equal(fixture.requests.filter(options=>options.body.format).length,2,mode);assert.equal(fixture.requests.filter(options=>!options.body.format).length,1,mode);
    assert.equal(result.recovery.finish_reason,'summary_fallback');assert.equal(result.recovery.answer_only,true);
    assert.equal(result.recovery.notes,prior?.notes??'');assert.equal(reply.thinking,(prior?initial:'')+source);assert.equal(result.recovery.through_chars,reply.thinking.length);
    assert.deepEqual(result.recovery.fallback_spans,[{start:prior?initial.length:0,end:reply.thinking.length,sha256:await recoveryDigest(source)}]);
    assert(await validRecovery(result.recovery,reply.thinking));assert(fixture.statuses.some(status=>status.phase==='fallback'));
  }
});

test('literal fallback hashes, empty-note prefix coverage and envelope limits reject changed or dishonest spans',async()=>{
  const {recoveryDigest}=await import('../src/reasoning-recovery.js');
  const source='abcd',span={start:0,end:4,sha256:await recoveryDigest(source)};
  const saved={version:1,notes:'',through_chars:4,source_sha256:await recoveryDigest(source),passes:0,finish_reason:'summary_fallback',fallback_spans:[span]};
  assert(await validRecovery(saved,source));
  for(const patch of [{fallback_spans:[]},{fallback_spans:[{...span,start:1,sha256:await recoveryDigest('bcd')}]},{fallback_spans:[span,span]},{fallback_spans:[{...span,end:5}]},{fallback_spans:[{...span,sha256:'0'.repeat(64)}]}])assert.equal(await validRecovery({...saved,...patch},source),null);
  assert.equal(await validRecovery(saved,'abXd'),null);
  const large='x'.repeat(65537),largeSpan={start:0,end:large.length,sha256:await recoveryDigest(large)};
  assert.equal(await validRecovery({...saved,through_chars:large.length,source_sha256:largeSpan.sha256,fallback_spans:[largeSpan]},large),null);
  const many='123456789',manySpans=await Promise.all([...many].map(async(char,start)=>({start,end:start+1,sha256:await recoveryDigest(char)})));
  assert.equal(await validRecovery({...saved,through_chars:9,source_sha256:await recoveryDigest(many),fallback_spans:manySpans},many),null);
});

test('unknown summary transport failures and user cancellation never create literal fallback or start an answer',async()=>{
  for(const mode of ['transport','cancel']){
    const controller=new AbortController();
    const fixture=recoveryFixture(async function*(){assert.fail('No answer after transport/cancel');},{signal:controller.signal,summaries:async function*(){if(mode==='cancel'){controller.abort(new Error('User stopped'));throw controller.signal.reason;}throw new UpstreamError('Connection failed',{code:'upstream_connection'});}});
    await assert.rejects(fixture.run);assert.equal(fixture.requests.length,1);assert(!fixture.checkpoints.some(value=>value.fallback_spans?.length));
  }
});

test('a fresh request resumes literal fallback coverage without losing earlier exact source spans',async()=>{
  const source='RAW_EXACT_A=8247. '+ 'p'.repeat(40000);
  const firstBudget=createJobBudget(8);
  const first=recoveryFixture(async function*(){assert.fail('Budget must pause before the final answer');},{reply:{thinking:source,content:''},initialPasses:0,budget:firstBudget,summaries:async function*(){yield {message:{content:'not json'}};yield {done:true,done_reason:'stop'};}});
  await assert.rejects(first.run,error=>error.code==='recovery_paused');const checkpoint=first.checkpoints.at(-1);assert(checkpoint.fallback_spans.length);assert(checkpoint.through_chars<source.length);
  const second=recoveryFixture(async function*(_count,options){assert.equal(options.body.think,false);assert(options.body.prompt.includes(source.slice(0,checkpoint.through_chars)));yield {message:{content:'Answer 8247'}};yield {done:true,done_reason:'stop'};},{reply:first.reply,previousRecovery:checkpoint,initialPasses:0});
  const result=await second.run();assert.equal(result.recovery.finish_reason,'summary_fallback');assert.equal(result.recovery.through_chars,source.length);assert(await validRecovery(result.recovery,source));assert.equal(second.reply.thinking,source);
});

test('literal fallback reserves its complete text and fails explicitly when the real context cannot fit it',async()=>{
  const source='x'.repeat(60000);
  const fixture=recoveryFixture(async function*(){assert.fail('No answer inference may receive a truncated fallback');},{reply:{thinking:source,content:''},numCtx:24576,realContext:true,summaries:async function*(){yield {message:{content:'not json'}};yield {done:true,done_reason:'stop'};}});
  await assert.rejects(fixture.run,error=>error.code==='context_limit'&&error.status===413);
  assert.equal(fixture.requests.filter(options=>!options.body.format).length,0);assert.equal(fixture.reply.thinking,source);assert.equal(fixture.checkpoints.at(-1).through_chars,source.length);assert(await validRecovery(fixture.checkpoints.at(-1),source));
});

test('an empty literal-fallback answer stops after one answer pass and preserves exact source',async()=>{
  const source='Exact provisional source port8247.';
  const fixture=recoveryFixture(async function*(){yield {done:true,done_reason:'stop'};},{reply:{thinking:source,content:''},summaries:async function*(){yield {message:{content:'not json'}};yield {done:true,done_reason:'stop'};}});
  await assert.rejects(fixture.run,error=>error.code==='recovery_failed');assert.equal(fixture.requests.filter(options=>!options.body.format).length,1);assert.equal(fixture.reply.thinking,source);assert.equal(fixture.checkpoints.at(-1).finish_reason,'summary_fallback');assert(await validRecovery(fixture.checkpoints.at(-1),source));
});

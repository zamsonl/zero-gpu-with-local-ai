import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after,before,beforeEach,test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {startStack,WORKER_DIR} from './dev-stack.mjs';
import {validRecovery,recoveryDigest,recoveryPieces} from '../src/reasoning-recovery.js';

let stack,jobsProxy;
const state=`.test-state/recovery-${process.pid}`;
const empty=Object.fromEntries(['goals','constraints','decisions','facts','artifacts','next_steps','corrections'].map(key=>[key,[]]));
before(async()=>{
  stack=await startStack({port:8892,mockPort:11792,state,vars:{TIMING_SCALE:'0.05'}});
  const child=spawn('python',['test/jobs-proxy-fixture.py',stack.mock.url],{cwd:WORKER_DIR,windowsHide:true,stdio:['pipe','pipe','pipe']});
  jobsProxy={close:async()=>{if(child.exitCode!==null)return;const exited=once(child,'exit');child.stdin.end('\n');const timer=setTimeout(()=>child.kill(),5000);try{await exited;}finally{clearTimeout(timer);}}};
  let output='',errors='';child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-2000);});
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Jobs fixture startup timed out: '+errors));},15000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);if(!output.includes('\n'))reject(new Error(`Jobs fixture exited ${code}: ${errors}`));});child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).url);}catch(error){reject(error);}}});});
  const registered=await fetch(stack.url+'/_relay/register',{method:'POST',headers:{'x-relay-key':stack.relayKey,'content-type':'application/json'},body:JSON.stringify({target:url,host:'kaggle',num_ctx:24576,inference_transport:'jobs-v1'})});assert.equal(registered.status,200,await registered.text());
  jobsProxy.url=url;
});
after(async()=>{await jobsProxy?.close();await stack?.stop();const directory=path.resolve(WORKER_DIR,state);assert(directory.startsWith(path.resolve(WORKER_DIR,'.test-state')+path.sep));for(let attempt=0;;attempt++){try{fs.rmSync(directory,{recursive:true,force:true});break;}catch(error){if(attempt>=30||!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;await delay(250);}}});
beforeEach(async()=>{stack.mock.reset();stack.mock.configure({tokenDelayMs:0});await fixtureConfig({max_job_seconds:3600});await call('PUT','/v1/settings',{max_reply_tokens:256,history_chars:null,system_prompt:null});});
async function fixtureConfig(body){const response=await fetch(jobsProxy.url+'/__fixture/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.text());}
async function call(method,uri,body){const response=await fetch(stack.url+uri,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();return {status:response.status,headers:response.headers,...(response.headers.get('content-type')?.includes('ndjson')?{events:text.split('\n').filter(line=>line.trim()).map(JSON.parse)}:{body:JSON.parse(text)})};}
async function create(id){assert.equal((await call('POST','/v1/chats',{id})).status,201);return id;}
async function seed(id,{content='',repetitions=6000}={}){await create(id);assert(Number.isSafeInteger(repetitions)&&repetitions>0);const at=new Date().toISOString();const quote=text=>"'"+text.replaceAll("'","''")+"'";const trace=`'CALCULATION_A=1297; hypothesis unverified. ' || replace(hex(zeroblob(${repetitions})), '00', ' pending work ') || ' FINAL_CHECK_B=8401; needs verification.'`;await stack.sql(`INSERT INTO messages(chat_id,role,content,created_at) VALUES('${id}','user','Keep project ORBIT_913; corrected port 8247 replaces 8123; do not use paid services.','${at}'); INSERT INTO messages(chat_id,role,content,thinking,status,created_at) VALUES('${id}','assistant',${quote(content)},${trace},'length','${at}'); UPDATE chats SET message_count=2 WHERE id='${id}';`);return (await call('GET',`/v1/chats/${id}`)).body.messages.at(-1);}
function drafts(){return stack.mock.requests().filter(({body})=>body.prompt?.includes('<unfinished_assistant_source start='));}
function finalEvent(result){const final=result.events?.at(-1);assert(final&&['done','error'].includes(final.event),'Missing terminal event: '+JSON.stringify(result)+'\n'+stack.output());return final;}

test('recovery coverage is accepted only with notes for the exact immutable source prefix',async()=>{
  const source='Exact constraint 8247, hypothesis 🧪 and unfinished result.';
  const saved={version:1,through_chars:source.length,notes:'Source-attributed provisional result, unverified.',passes:1,source_sha256:await recoveryDigest(source)};
  assert(await validRecovery(saved,source));assert.equal(await validRecovery(saved,source.replace('8247','9999')),null);assert.equal(await validRecovery({...saved,notes:''},source),null);assert.equal(await validRecovery({...saved,passes:'1'},source),null);
  const pieces=recoveryPieces(source,23);assert.equal(pieces.map(piece=>piece.text).join(''),source);assert(pieces.every(piece=>!/[\uD800-\uDBFF]$/.test(piece.text)));
});

test('a thought-only length stop automatically answers from structured working notes, with one assistant row',async()=>{
  const id=await create('recover-initial-limit');stack.mock.configure({thinkingTokens:300});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Keep ORBIT_913, use corrected port 8247 and no paid services.',think:true});
  assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/no-transform/);
  const done=finalEvent(result);assert.equal(done.event,'done');assert.equal(done.message.status,'complete');assert.match(done.message.content,/Continued answer/);
  assert(done.message.thinking.startsWith('The user wrote'));assert(done.message.thinking.includes('word200'));
  assert(result.events.some(event=>event.state==='recovering'&&event.phase==='extracting'));
  const summaries=result.events.filter(event=>event.operation==='reasoning_recovery'&&event.phase==='extracting');
  assert(summaries.some(event=>event.transport_state==='connecting'));assert(summaries.every(event=>event.state==='recovering'&&event.detail.startsWith('Summarizing thinking')));
  assert(summaries.some(event=>event.transport_state===null),'Actual summary output clears waiting-transport diagnostics');
  assert(result.events.some(event=>event.phase==='resuming'));
  const saved=(await call('GET',`/v1/chats/${id}`)).body.messages;assert.equal(saved.length,2);assert.equal(saved[1].id,done.message.id);
  assert.equal(done.message.stats.recovery.through_chars,done.message.thinking.indexOf(' and so on.'));
  assert(done.message.stats.recovery.notes.includes('provisional assistant draft'));
  const finalRequest=stack.mock.lastGenerate();assert(finalRequest.prompt.includes('corrected port 8247'));assert(finalRequest.prompt.includes('<unfinished_work_notes>'));
  assert.equal((await call('GET','/v1/status')).body.busy,null,'A terminal event must release the lock before immediate next input');
  assert.equal(finalEvent(await call('POST',`/v1/chats/${id}/turn`,{content:'Next question',think:false})).event,'done');
});

test('oversized Continue covers every draft character with overlap, preserves full source and updates the same message',async()=>{
  const id='recover-oversized';const original=await seed(id);
  const result=await call('POST',`/v1/chats/${id}/continue`);
  const done=finalEvent(result);assert.equal(result.status,200);assert.equal(done.event,'done');assert.equal(done.message.id,original.id);assert(done.message.thinking.startsWith(original.thinking));
  const pieces=drafts().map(({body})=>/<unfinished_assistant_source start="(\d+)" end="(\d+)">\n([\s\S]*?)\n<\/unfinished_assistant_source>/.exec(body.prompt));
  assert(pieces.length>2);assert.equal(pieces.map(piece=>piece[3]).join(''),original.thinking);
  for(let i=1;i<pieces.length;i++){assert.equal(Number(pieces[i][1]),Number(pieces[i-1][2]));assert(drafts()[i].body.prompt.includes('<previous_context>\n'+original.thinking.slice(Number(pieces[i][1])-256,Number(pieces[i][1]))));}
  assert.equal(done.message.stats.recovery.through_chars,original.thinking.length);
  assert(done.message.stats.recovery.notes.includes('CALCULATION_A=1297'));assert(done.message.stats.recovery.notes.includes('FINAL_CHECK_B=8401'));
  assert.equal((await call('GET',`/v1/chats/${id}`)).body.messages.length,2);
  assert(!stack.mock.lastGenerate().prompt.includes(original.thinking),'Answer uses bounded notes instead of replaying an overflowing trace');
});

test('three exact repeated reasoning windows are preserved before one announced final answer pass',async()=>{
  const id=await create('recover-repeat-limit');stack.mock.configure({thinkingTokens:300,rawThinkingTokens:300});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Compute carefully, then answer.',think:true});const done=finalEvent(result);
  assert.equal(done.event,'done');assert.equal(done.message.status,'complete');assert.equal(done.message.stats.think,true);assert.equal(done.message.stats.recovery.finish_reason,'repeated_work');assert.equal(done.message.stats.recovery.answer_only,true);
  assert(result.events.some(event=>event.phase==='finishing'&&event.detail.includes('repeated')));assert.equal(stack.mock.lastGenerate().think,false);
  const work=stack.mock.requests().filter(({body})=>body.raw&&!body.format);assert.equal(work.length,4);assert(work.slice(0,3).every(({body})=>body.think===true&&body.options.num_predict<=2048));assert.equal(work.at(-1).body.think,false);
  assert.equal(drafts().length,4,'Initial and three repeated thinking windows must all be checkpointed');assert.equal(done.message.stats.recovery.through_chars,done.message.thinking.length);assert.equal((await call('GET',`/v1/chats/${id}`)).body.messages.length,2);assert(done.message.content);
});

test('proactive thinking windows cap only each job while preserving full context and the logical reply reservation',async()=>{
  await call('PUT','/v1/settings',{max_reply_tokens:null});const id=await create('recover-proactive');stack.mock.configure({thinkingTokens:4200});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Keep working until the result is ready.',think:true});const done=finalEvent(result);
  assert.equal(done.event,'done');assert(done.message.content);assert.equal(stack.mock.lastChat().options.num_predict,2048);assert.equal(stack.mock.lastChat().options.num_ctx,24576);assert.equal(done.message.stats.context.reserved_reply_tokens,10240);assert.equal(done.message.stats.work_window_tokens,2048);assert.equal(stack.mock.lastGenerate().think,true);
});

test('the registered98304 context and batch256 remain unchanged across proactive work windows',async()=>{
  const register=async num_ctx=>{const response=await fetch(stack.url+'/_relay/register',{method:'POST',headers:{'x-relay-key':stack.relayKey,'content-type':'application/json'},body:JSON.stringify({target:jobsProxy.url,host:'kaggle',num_ctx,num_batch:num_ctx===98304?256:512,quant:'Q5_K_P',inference_transport:'jobs-v1'})});assert.equal(response.status,200,await response.text());};
  await register(98304);
  try{
    await call('PUT','/v1/settings',{max_reply_tokens:null});const id=await create('recover-full-profile');stack.mock.configure({thinkingTokens:4200});
    const done=finalEvent(await call('POST',`/v1/chats/${id}/turn`,{content:'Keep the registered full model profile and answer.',think:'medium'}));
    assert.equal(done.event,'done');assert.equal(done.message.stats.context.capacity_tokens,98304);assert.equal(done.message.stats.context.reserved_reply_tokens,24576);assert.equal(done.message.stats.num_batch,256);assert.equal(done.message.stats.think,'medium');
    const requests=stack.mock.requests();assert(requests.every(({body})=>body.options.num_ctx===98304&&body.options.num_batch===256));assert(requests.filter(({body})=>!body.format).every(({body})=>body.options.num_predict===2048&&body.think==='medium'));assert.equal(new Set(requests.map(({body})=>body.model)).size,1);
  }finally{await register(24576);}
});

test('thought-only normal EOS resumes at exactly the chosen effort instead of saving an empty complete answer',async()=>{
  for(const think of [true,'medium','low']){
    const id=await create('recover-eos-'+String(think));stack.mock.reset();stack.mock.configure({tokenDelayMs:0,thinkingTokens:300,doneReason:'stop'});
    const done=finalEvent(await call('POST',`/v1/chats/${id}/turn`,{content:'Work through the task and answer.',think}));assert.equal(done.event,'done');assert(done.message.content);assert.equal(done.message.stats.think,think);assert.equal(stack.mock.lastGenerate().think,think);assert.equal(stack.mock.lastGenerate().options.num_ctx,24576);assert.equal(stack.mock.lastGenerate().truncate,false);assert.equal(stack.mock.lastGenerate().shift,false);
  }
});

test('malformed and empty terminal summaries preserve the exact thought then finish through real Python jobs',async()=>{
  for(const [label,output] of [['malformed','not json'],['empty',JSON.stringify(empty)]]){
    const id='recover-invalid-'+label;const original=await seed(id,{repetitions:1000});stack.mock.reset();stack.mock.configure({tokenDelayMs:0,draftOutput:output});
    const result=await call('POST',`/v1/chats/${id}/continue`,{think:false});const terminal=finalEvent(result);assert.equal(terminal.event,'done',JSON.stringify(terminal));assert.equal(drafts().length,2);
    const saved=(await call('GET',`/v1/chats/${id}`)).body.messages.at(-1);assert.equal(saved.id,original.id);assert.equal(saved.thinking,original.thinking);assert.equal(saved.status,'complete');assert(saved.content);
    assert.equal(saved.stats.recovery.notes,'');assert.equal(saved.stats.recovery.finish_reason,'summary_fallback');assert.equal(saved.stats.recovery.through_chars,original.thinking.length);assert(await validRecovery(saved.stats.recovery,saved.thinking));
    assert(result.events.some(event=>event.phase==='fallback'));assert(result.events.some(event=>event.phase==='finishing'));
    assert(stack.mock.lastGenerate().prompt.includes(original.thinking));assert(stack.mock.lastGenerate().prompt.includes('corrected port 8247'));assert.equal(stack.mock.lastGenerate().think,false);
    assert.equal(stack.mock.requests().filter(({body})=>body.raw&&!body.format).length,1);assert.equal((await call('GET',`/v1/chats/${id}`)).body.messages.length,2);assert.equal((await call('GET','/v1/status')).body.busy,null);
  }
});

test('duplicate-only later summaries retain prior notes and preserve the unsummarized tail verbatim',async()=>{
  const id='recover-duplicate-later';const original=await seed(id,{repetitions:2600});
  const output=JSON.stringify({...empty,facts:['Earlier repeated provisional observation.']});stack.mock.configure({tokenDelayMs:0,draftOutput:output});
  const result=await call('POST',`/v1/chats/${id}/continue`,{think:false});const done=finalEvent(result);assert.equal(done.event,'done',JSON.stringify(done));assert.equal(done.message.id,original.id);assert.equal(done.message.thinking,original.thinking);
  assert(done.message.stats.recovery.notes.includes('Earlier repeated provisional observation.'));assert.equal(done.message.stats.recovery.finish_reason,'summary_fallback');assert(await validRecovery(done.message.stats.recovery,original.thinking));
  const span=done.message.stats.recovery.fallback_spans[0];assert(span.start>0);assert.equal(span.end,original.thinking.length);assert(stack.mock.lastGenerate().prompt.includes(original.thinking.slice(span.start,span.end)));
  assert.equal(stack.mock.requests().filter(({body})=>body.raw&&!body.format).length,1);assert.equal(drafts().length,3);
});

test('an unrelated upstream error saves partial reasoning without attempting automatic recovery',async()=>{
  const id=await create('recover-unrelated-error');stack.mock.configure({errorAfterTokens:5});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Original question',think:true});
  assert.equal(finalEvent(result).event,'error');assert.equal(finalEvent(result).code,'upstream');assert.equal(drafts().length,0);
  const saved=(await call('GET',`/v1/chats/${id}`)).body.messages;assert.equal(saved.length,2);assert(saved[1].thinking);assert.equal(saved[1].status,'error');
});

test('real Python jobs classify thought-only EOF, broken connection and timeout for one recovery',async()=>{
  for(const [code,behaviour] of [['upstream_eof',{eofAfterTokens:5}],['upstream_connection',{dropAfterTokens:5}],['job_timeout',{stallAfterTokens:5}]]){
    stack.mock.reset();stack.mock.configure({tokenDelayMs:0,...behaviour});
    await fixtureConfig({max_job_seconds:code==='job_timeout'?0.3:3600});
    const id=await create('recover-'+code);
    const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Preserve exact result 8247 and answer.',think:'medium'});const done=finalEvent(result);
    assert.equal(done.event,'done',JSON.stringify(done));assert(done.message.content);assert.equal(done.message.stats.think,'medium');
    assert.equal(drafts().length,1);assert.equal(stack.mock.requests().filter(({body})=>body.raw&&!body.format).length,1);
    assert.equal(stack.mock.lastGenerate().think,'medium');assert.equal((await call('GET',`/v1/chats/${id}`)).body.messages.at(-1).id,done.message.id);
  }
});

test('a second classified model-job interruption saves all work without a third work attempt',async()=>{
  for(const [code,behaviour] of [['upstream_eof',{eofAfterTokens:5,rawEofAfterTokens:1}],['upstream_connection',{dropAfterTokens:5,rawDropAfterTokens:1}],['job_timeout',{stallAfterTokens:5,rawStallAfterTokens:1}]]){
    stack.mock.reset();stack.mock.configure({tokenDelayMs:0,...behaviour});
    await fixtureConfig({max_job_seconds:code==='job_timeout'?0.3:3600});
    const id=await create('recover-twice-'+code);
    const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Think carefully.',think:'low'});const failed=finalEvent(result);
    assert.equal(failed.event,'error');assert.equal(failed.code,'recovery_failed');assert.equal(failed.message_saved.stats.think,'low');assert(failed.message_saved.thinking.endsWith(' and so'));
    assert.equal(drafts().length,1);assert.equal(stack.mock.requests().filter(({body})=>body.raw&&!body.format).length,1);
    const saved=(await call('GET',`/v1/chats/${id}`)).body.messages;assert.equal(saved.length,2);assert.equal(saved.at(-1).id,failed.message_saved.id);assert.equal((await call('GET','/v1/status')).body.busy,null);
  }
});

test('unknown model error after a recovery window never starts another inference',async()=>{
  const id=await create('recover-unknown-after-window');stack.mock.configure({thinkingTokens:300,rawErrorAfterTokens:1});
  const failed=finalEvent(await call('POST',`/v1/chats/${id}/turn`,{content:'Complete this carefully.',think:'medium'}));
  assert.equal(failed.event,'error');assert.equal(failed.code,'upstream');assert.equal(failed.message_saved.stats.think,'medium');assert.equal(drafts().length,1);
  assert.equal(stack.mock.requests().filter(({body})=>body.raw&&!body.format).length,1);
});

test('Continue without a new effort preserves the saved medium and low selections',async()=>{
  for(const think of ['medium','low']){
    const id=await create('recover-default-'+think);stack.mock.reset();stack.mock.configure({tokenDelayMs:0,errorAfterTokens:5});
    const failed=finalEvent(await call('POST',`/v1/chats/${id}/turn`,{content:'Finish the work.',think}));assert.equal(failed.message_saved.stats.think,think);
    stack.mock.configure({errorAfterTokens:null});
    const done=finalEvent(await call('POST',`/v1/chats/${id}/continue`));assert.equal(done.event,'done');assert.equal(done.message.stats.think,think);assert.equal(stack.mock.lastGenerate().think,think);assert.equal(done.message.id,failed.message_saved.id);
  }
});

test('a partially written answer is retained as length without an unsolicited reasoning recovery',async()=>{
  const id=await create('recover-content-partial');stack.mock.configure({doneReason:'length'});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Answer this',think:true});
  assert.equal(finalEvent(result).event,'done');assert.equal(finalEvent(result).message.status,'length');assert(finalEvent(result).message.content);assert.equal(drafts().length,0);
});

test('context overflow after partial content checkpoints its thought and includes that answer prefix exactly once',async()=>{
  const id=await create('recover-overflow-partial');stack.mock.configure({errorAfterTokens:20,errorMessage:'the input length exceeds the context length'});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Keep exact port 8247, then answer this question.',think:true});const done=finalEvent(result);
  assert.equal(done.event,'done',JSON.stringify(done));assert.equal(done.message.status,'complete');
  const prefix=result.events.filter(event=>event.event==='content').map(event=>event.text).join('').replace(/ continued answer\.$/,'');
  assert(prefix);assert.equal(stack.mock.lastGenerate().prompt.split(prefix).length-1,1,'The archived draft must not also be replayed as a historical assistant message');
  assert.equal((await call('GET',`/v1/chats/${id}`)).body.messages.length,2);
});

test('large recovery pauses at its safe budget and later Continue resumes durable coverage without duplicate rows',async()=>{
  const id='recover-budget';const original=await seed(id,{repetitions:30000});
  const paused=await call('POST',`/v1/chats/${id}/continue`);const terminal=finalEvent(paused);assert.equal(terminal.event,'error');assert.equal(terminal.code,'recovery_paused');assert.equal(drafts().length,8);
  const covered=terminal.message_saved.stats.recovery.through_chars;assert(covered>0&&covered<original.thinking.length);
  let complete=null;
  for(let attempt=0;attempt<3;attempt++){const prior=drafts().length;const result=await call('POST',`/v1/chats/${id}/continue`);const event=finalEvent(result);assert(drafts()[prior].body.prompt.includes(`start="${attempt===0?covered:complete.message_saved.stats.recovery.through_chars}"`));complete=event;if(event.event==='done')break;assert.equal(event.code,'recovery_paused');}
  assert.equal(complete.event,'done');assert.equal(complete.message.id,original.id);assert(complete.message.thinking.startsWith(original.thinking));assert(complete.message.stats.recovery.notes.includes('FINAL_CHECK_B=8401'));assert.equal((await call('GET',`/v1/chats/${id}`)).body.messages.length,2);
});

test('automatic compaction preserves earlier source and corrections before omitted history is sent',async()=>{
  const id='recover-auto-compact';const messages=Array.from({length:12},(_,index)=>({role:index%2?'assistant':'user',content:(index===0?'ORBIT_913 must stay free. ':index===2?'Correction: 8247 replaces 8123. ':`source ${index} `)+'detail '.repeat(1000),created_at:'2026-10-01T00:00:00Z'}));
  assert.equal((await call('POST','/v1/import',{chats:[{id,title:'Auto memory',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',messages}]})).status,200);
  const original=(await call('GET',`/v1/chats/${id}`)).body.messages;
  stack.mock.configure({memoryOutputs:[JSON.stringify({...empty,facts:['[message 1] Project ORBIT_913 must stay free.'],corrections:['[message 3] Port 8247 replaces 8123.']}),JSON.stringify({...empty,facts:['[messages 7-10] Subsequent source discussion consists of repeated detail.']})]});
  const result=await call('POST',`/v1/chats/${id}/turn`,{content:'Continue the project with all requirements.',think:false});const done=finalEvent(result);
  assert.equal(done.event,'done',JSON.stringify(done));assert(result.events.some(event=>event.state==='compacting'));assert(done.message.stats.context.auto_compacted);
  const stored=(await call('GET',`/v1/chats/${id}`)).body.messages;assert.deepEqual(stored.slice(0,12),original);
  assert(stack.mock.lastChat().messages.some(message=>message.content.includes('ORBIT_913')&&message.content.includes('8247 replaces 8123')));
  assert(stack.mock.lastChat().messages.some(message=>message.content.includes('source 10')));assert.equal(stack.mock.lastChat().messages.at(-1).content,'Continue the project with all requirements.');
});

test('Stop during extraction keeps a durable completed checkpoint and does not start answer recovery',async()=>{
  const id='recover-stop';const original=await seed(id);stack.mock.configure({tokenDelayMs:0});
  let stopped=false;const response=await fetch(stack.url+`/v1/chats/${id}/continue`,{method:'POST'});const reader=response.body.getReader();let buffer='',events=[];
  for(;;){const {value,done}=await reader.read();if(done)break;buffer+=new TextDecoder().decode(value);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const event=JSON.parse(line);events.push(event);if(!stopped&&event.phase==='extracting'&&event.chunk===2){stopped=true;stack.mock.configure({firstTokenDelayMs:4000});const durable=(await call('GET',`/v1/chats/${id}`)).body.messages.at(-1);assert(durable.stats?.recovery?.through_chars>0,'Completed notes must already be committed before Stop or final save');await call('POST','/v1/stop');}}}
  assert(stopped);const terminal=events.at(-1);assert.equal(terminal.event,'done');assert.equal(terminal.message.status,'stopped');assert.equal(terminal.message.thinking,original.thinking);
  assert(terminal.message.stats.recovery.through_chars>0);assert(terminal.message.stats.recovery.through_chars<original.thinking.length);assert(!events.some(event=>event.phase==='resuming'));
  const saved=(await call('GET',`/v1/chats/${id}`)).body.messages.at(-1);assert.deepEqual(saved.stats.recovery,terminal.message.stats.recovery);
  stack.mock.configure({firstTokenDelayMs:0});const prior=drafts().length;const resumed=await call('POST',`/v1/chats/${id}/continue`,{think:false});assert.equal(finalEvent(resumed).event,'done');
  assert.equal(finalEvent(resumed).message.id,original.id);assert.equal(stack.mock.lastGenerate().think,false);assert(stack.mock.lastGenerate().prompt.includes('CALCULATION_A=1297'));
  const resumedFirst=drafts()[prior].body.prompt;assert(resumedFirst.includes(`start="${saved.stats.recovery.through_chars}"`),'Continue resumes after durable coverage instead of summarizing the same source again');
});

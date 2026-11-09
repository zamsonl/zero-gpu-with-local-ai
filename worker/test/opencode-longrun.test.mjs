import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {HttpError,errorJson,json,readJsonObject} from '../src/http.js';
import {JobsTransportError,createJobBudget} from '../src/jobs-transport.js';

// Exercise the real gateway with controlled model jobs and time. This suite has
// no Wrangler/Miniflare process or global integration-stack before hook.
const gatewaySource=(await fs.readFile(new URL('../src/opencode.js',import.meta.url),'utf8'))
  .replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
const MODEL='qwen3.8-hauhau',REQUEST_MS=2*60*60_000;
const tool={type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}}};
const packet=message=>({model:MODEL,message,done:false});
const done=extra=>({model:MODEL,done:true,done_reason:'stop',prompt_eval_count:123,eval_count:7,...extra});
const runnerError='model runner has unexpectedly stopped, this may be due to resource limitations or an internal error';
const parserError='llama-server returned invalid tool call arguments for "read_file": unexpected end of JSON input';
const parseSse=text=>text.split(/\r?\n\r?\n/).flatMap(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data: ')).map(line=>line.slice(6))).map(value=>value==='[DONE]'?value:JSON.parse(value));

async function fixture({run,extra={},signal,profile}={}){
  let now=0,nextTimer=1,releases=0,acquisitions=0;
  const calls=[],timers=new Map(),state=new Map(),background=[],assertions=[];
  const advance=ms=>{now+=ms;for(const[id,timer]of[...timers])if(timer.at<=now){timers.delete(id);timer.callback();}};
  const db={prepare:sql=>({bind:(key,value)=>({
    first:async()=>state.has(key)?{v:state.get(key)}:null,
    run:async()=>{if(sql.startsWith('DELETE'))state.delete(key);else state.set(key,value);return {meta:{changes:1}};},
  })})};
  const lock={id:'00000000-0000-4000-8000-000000000001',async release(){releases++;},
    startHeartbeat(){assert.fail('A long model request cannot spend D1 polling timers');},
    watchForStop(){assert.fail('A long model request cannot spend D1 polling timers');}};
  const target={target:'https://fixture.invalid',host:'kaggle',quant:'Q5_K_P',num_ctx:98304,num_batch:256,vision:false,inference_transport:'jobs-v1',job_max_leg_seconds:300,job_control:true};
  if(profile)Object.assign(target,{quant:profile.quant,num_ctx:profile.context,num_batch:128,profile_id:profile.profile_id,thinking:true});
  const deps={HttpError,errorJson,json,readJsonObject,JobsTransportError,createJobBudget,
    Date:class extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}},
    setTimeout:(callback,ms)=>{const id=nextTimer++;timers.set(id,{at:now+ms,callback});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async()=>new Response('{"busy":false}\n'),sleep:async(ms,signal)=>{advance(ms);signal.throwIfAborted();},
    readTarget:async()=>target,GenerationLock:{acquire:async()=>({lock:{...lock,id:'00000000-0000-4000-8000-'+String(++acquisitions).padStart(12,'0')}})},
    streamJobRecords:async function*(options){calls.push(options);try{yield*run({options,call:calls.length,advance,target});}catch(error){if(error?.name==='AssertionError')assertions.push(error);throw error;}},
  };
  const openCodeChat=new Function('deps','with(deps){'+gatewaySource+';return openCodeChat;}')(deps);
  const response=await openCodeChat({
    request:new Request('https://fixture.invalid/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:MODEL,messages:[{role:'user',content:'Inspect the project and continue safely.'}],stream:false,...extra}),signal}),
    env:{AGENT_SESSION:true,AGENT_CONTROL_KEY:'f'.repeat(64),DB:db,...(profile?{AGENT_MODEL_PROFILE:profile}:{})},
    ctx:{waitUntil:promise=>background.push(promise)},
  });
  const raw=await response.text();await Promise.all(background);if(assertions.length)throw assertions[0];
  const events=extra.stream?parseSse(raw):null,value=extra.stream?null:JSON.parse(raw);
  return {response,value,events,calls,timers,releases,state,elapsed:now};
}

const checkpoints=body=>body.messages
  .filter(message=>message.role==='assistant'&&message.content?.startsWith('Unfinished working notes from this response.'))
  .map(message=>JSON.parse(message.content.slice(message.content.indexOf('\n')+1)));

test('reasoning-limit finish retains the complete checkpoint even when native Ollama drops Thinking',async()=>{
  const saved='Verified source: C:\\project\\auth.ts. Keep the explicit user requirement. '+ 'Important checkpoint αβ '.repeat(100);let budget;
  const f=await fixture({run:async function*({options,call,advance}){
    if(call===1){budget=options.requestBudget;advance(30*60_000);yield {value:packet({thinking:saved}),upstreamStatus:200};yield {value:done({done_reason:'length',prompt_eval_count:70000,eval_count:8192}),upstreamStatus:200};return;}
    const body=JSON.parse(options.payload);
    assert(checkpoints(body).some(note=>note.reasoning===saved),'Saved reasoning must survive the native chat renderer which omits message.thinking');
    assert.equal(body.think,false);assert(body.options.num_predict<=4096);
    assert.equal(options.maxJobMs,90*60_000);assert.equal(options.requestBudget,budget);
    yield {value:packet({content:'Finished from the verified checkpoint.'}),upstreamStatus:200};yield {value:done({prompt_eval_count:78300,eval_count:45}),upstreamStatus:200};
  }});
  assert.equal(f.response.status,200);assert.equal(f.calls.length,2);assert.equal(f.calls[0].requestBudget,f.calls[1].requestBudget);
  assert.equal(f.value.choices[0].message.reasoning_content,saved);
  assert.equal(f.value.choices[0].message.content,'Finished from the verified checkpoint.');
  assert.equal(f.value.usage.prompt_tokens,78300);assert.equal(f.value.usage.completion_tokens,8237);assert.equal(f.value.usage.total_tokens,86537);
  assert.equal(f.value.usage.completion_tokens_details.reasoning_tokens,8192);
  assert.equal(f.timers.size,0);assert(f.releases>0);
});

test('recognized runner and tool-parser failures recover once with saved text under the original deadline and budget',async()=>{
  for(const error of [runnerError,parserError]){
    const saved='Checked README.md; preserve this checkpoint exactly.';let budget;
    const f=await fixture({extra:{tools:[tool]},run:async function*({options,call,advance}){
      const body=JSON.parse(options.payload);
      if(call===1){budget=options.requestBudget;advance(42*60_000);yield {value:packet({thinking:saved}),upstreamStatus:200};yield {value:{error},upstreamStatus:200};return;}
      assert.equal(call,2);assert.equal(options.requestBudget,budget);assert.equal(options.maxJobMs,78*60_000);
      assert.equal(body.think,false);assert.equal(body.options.temperature,0);assert(body.options.num_predict<=4096);
      assert(checkpoints(body).some(note=>note.reasoning===saved));assert.deepEqual(body.tools,[tool]);
      assert(!body.messages.some(message=>message.tool_calls),'A failed tool call must not be replayed into the checkpoint');
      yield {value:packet({content:'Continued safely.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};
    }});
    assert.equal(f.response.status,200);assert.equal(f.calls.length,2);assert.equal(f.value.choices[0].message.content,'Continued safely.');
    assert.equal(f.value.choices[0].message.reasoning_content,saved);assert.equal(f.timers.size,0);
    assert.notEqual(f.calls[0].identity.id,f.calls[1].identity.id,'Each recovery must own a distinct idempotent job');
  }
});

test('a main reasoning finish followed by one recognized recovery has at most three model jobs',async()=>{
  const saved='Original verified working note.',later='The finishing pass checked another fact.';let budget;
  const f=await fixture({run:async function*({call,options,advance}){
    const body=JSON.parse(options.payload);
    if(call===1){budget=options.requestBudget;advance(20*60_000);yield {value:packet({thinking:saved}),upstreamStatus:200};yield {value:done({done_reason:'length',prompt_eval_count:70000,eval_count:8192}),upstreamStatus:200};return;}
    assert.equal(options.requestBudget,budget);assert(checkpoints(body).some(note=>note.reasoning===saved));assert.equal(body.think,false);
    if(call===2){advance(10*60_000);yield {value:packet({content:later}),upstreamStatus:200};yield {value:{error:parserError},upstreamStatus:200};return;}
    assert.equal(call,3);assert.equal(options.maxJobMs,90*60_000);assert(checkpoints(body).some(note=>note.answer_so_far===later));
    yield {value:packet({content:'Final result.'}),upstreamStatus:200};yield {value:done({prompt_eval_count:78400,eval_count:30}),upstreamStatus:200};
  }});
  assert.equal(f.response.status,200);assert.equal(f.calls.length,3);assert.equal(new Set(f.calls.map(call=>call.identity.id)).size,3);
  assert.equal(f.value.usage.prompt_tokens,78400);assert.equal(f.value.usage.completion_tokens,8222);assert.equal(f.timers.size,0);
});

test('recognized repeated model failures stop after one recovery and expose the correct cause',async()=>{
  for(const [error,code]of [[runnerError,'model_runner_stopped'],[parserError,'model_tool_parse_error'],['CUDA out of memory while allocating a device buffer','model_out_of_memory']]){
    const f=await fixture({run:async function*({call}){
      assert(call<=2,'Model recovery cannot form an automatic retry loop');yield {value:packet({thinking:'Useful checkpoint.'}),upstreamStatus:200};yield {value:{error},upstreamStatus:500};
    }});
    assert.equal(f.response.status,502);assert.equal(f.value.error.code,code);assert(f.calls.length<=2);assert.equal(f.timers.size,0);
    if(code!=='model_out_of_memory')assert.equal(f.calls.length,2);
  }
});

test('unknown model errors, missing terminal records and context overflow never trigger model-error replay',async()=>{
  for(const [tail,expected]of [[{error:'An unrecognized model failure.'},'model_upstream_error'],[null,'incomplete_response'],[{error:'the input length exceeds the context length'},'context_length_exceeded']]){
    const f=await fixture({run:async function*(){yield {value:packet({thinking:'Saved partial work.'}),upstreamStatus:200};if(tail)yield {value:tail,upstreamStatus:200};}});
    assert.equal(f.calls.length,1);assert.equal(f.value.error.code,expected);assert.equal(f.timers.size,0);
    assert.equal(f.response.status,expected==='context_length_exceeded'?413:502);
  }
  const network=await fixture({run:async function*(){throw new Error('Unknown internal exception');}});
  assert.equal(network.calls.length,1);assert.equal(network.response.status,502);
  for(const code of ['upstream_eof','stream_unreachable']){
    const transport=await fixture({run:async function*(){throw new JobsTransportError(code,'The transport did not confirm completion.');}});
    assert.equal(transport.calls.length,1);assert.equal(transport.value.error.code,code);assert.equal(transport.timers.size,0);
  }
});

test('cancellation and the original two-hour deadline cannot start a recovery',async()=>{
  const caller=new AbortController();
  const cancelled=await fixture({signal:caller.signal,run:async function*(){caller.abort();yield {value:{error:runnerError},upstreamStatus:200};}});
  assert.equal(cancelled.calls.length,1);assert.equal(cancelled.value.error.code,'cancelled');assert.equal(cancelled.timers.size,0);
  const expired=await fixture({run:async function*({advance}){advance(REQUEST_MS);yield {value:{error:runnerError},upstreamStatus:200};}});
  assert.equal(expired.calls.length,1);assert.equal(expired.value.error.code,'model_timeout');assert.equal(expired.timers.size,0);
});

test('tool calls held before a model failure are never executed, streamed or copied into a retry',async()=>{
  const f=await fixture({extra:{stream:true,tools:[tool]},run:async function*({call}){
    assert.equal(call,1,'A response with a withheld tool call must not be replayed');
    yield {value:packet({thinking:'Inspecting.',tool_calls:[{function:{index:0,name:'read_file',arguments:'{"path":"README.md"}'}}]}),upstreamStatus:200};
    yield {value:{error:parserError},upstreamStatus:200};
  }});
  assert.equal(f.calls.length,1);assert(f.events.some(event=>event.error));
  assert(!f.events.some(event=>event.choices?.[0]?.delta?.tool_calls));assert(!f.events.some(event=>event.choices?.[0]?.finish_reason));
  assert.equal(f.events.find(event=>event.error)?.error.code,'model_tool_parse_error');assert.equal(f.timers.size,0);
});

test('recovery cannot report old partial text as a new successful answer',async()=>{
  for(const text of ['', '  \n']){
    const f=await fixture({run:async function*({call}){
      if(call===1){yield {value:packet({content:'A partial answer that did not finish.'}),upstreamStatus:200};yield {value:{error:runnerError},upstreamStatus:200};return;}
      yield {value:packet({content:text}),upstreamStatus:200};yield {value:done({eval_count:0}),upstreamStatus:200};
    }});
    assert.equal(f.calls.length,2);assert.equal(f.response.status,502);assert.equal(f.value.error.code,'model_recovery_incomplete');
  }
});

test('streamed recovery preserves text once and releases only a new terminal-success tool call',async()=>{
  const f=await fixture({extra:{stream:true,tools:[tool],stream_options:{include_usage:true}},run:async function*({call}){
    if(call===1){yield {value:packet({thinking:'Use the verified source.',content:'I will inspect the file. '}),upstreamStatus:200};yield {value:{error:parserError},upstreamStatus:500};return;}
    yield {value:packet({tool_calls:[{function:{index:0,name:'read_file',arguments:{path:'README.md'}}}]}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};
  }});
  assert.equal(f.calls.length,2);assert(!f.events.some(event=>event.error));
  assert.equal(f.events.map(event=>event.choices?.[0]?.delta?.content||'').join(''),'I will inspect the file. ');
  assert.equal(f.events.filter(event=>event.choices?.[0]?.delta?.tool_calls?.[0]?.id).length,1);
  assert.equal(f.events.find(event=>event.choices?.[0]?.finish_reason)?.choices[0].finish_reason,'tool_calls');
  const checkpoint=JSON.parse(JSON.parse(f.calls[1].payload).messages.at(-2).content.split('\n').slice(1).join('\n'));
  assert.equal(checkpoint.answer_so_far,'I will inspect the file. ');
});

test('nested model errors are classified without leaking tool arguments or mistaking runtime context for overflow',async()=>{
  for(const [error,expected]of [[{message:'CUDA out of memory allocating context buffer private_arg_123'},'model_out_of_memory'],[{message:'context deadline exceeded private_arg_123'},'model_upstream_error']]){
    const f=await fixture({run:async function*(){yield {value:{error},upstreamStatus:500};}});
    assert.equal(f.calls.length,1);assert.equal(f.value.error.code,expected);assert(!JSON.stringify(f.value).includes('private_arg_123'));
  }
});

test('recovery revalidates a rotated target and uses its current measured custom context',async()=>{
  const profile={quant:'Q4_K_M',context:32768,profile_id:'custom-profile'};
  const f=await fixture({profile,run:async function*({call,options,target}){
    if(call===1){target.target='https://rotated.invalid';target.num_ctx=8192;target.thinking=false;yield {value:{error:runnerError},upstreamStatus:200};return;}
    const body=JSON.parse(options.payload);assert.equal(options.target,'https://rotated.invalid');assert.equal(body.options.num_ctx,8192);assert.equal(body.options.num_batch,128);assert.equal(body.options.num_predict,2048);assert.equal(body.think,undefined);
    yield {value:packet({content:'Recovered on the validated target.'}),upstreamStatus:200};yield {value:done(),upstreamStatus:200};
  }});
  assert.equal(f.response.status,200);assert.equal(f.calls.length,2);
  const invalid=await fixture({run:async function*({target}){target.vision=true;yield {value:{error:runnerError},upstreamStatus:200};}});
  assert.equal(invalid.calls.length,1);assert.equal(invalid.response.status,409);assert.equal(invalid.value.error.code,'personal_profile');
});

test('an assembled transport payload limit cannot trigger native context-compaction loops',async()=>{
  const f=await fixture({run:async function*(){throw new JobsTransportError('payload_limit','The assembled request exceeded the relay byte limit.',{status:413});}});
  assert.equal(f.response.status,400);assert.equal(f.value.error.code,'payload_limit');assert.equal(f.calls.length,1);assert.equal(f.state.size,0);
});

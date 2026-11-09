import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';

const readingPrefsSource=(await fs.readFile(new URL('../public/js/prefs.js',import.meta.url),'utf8')).replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');
const readingBootSource=await fs.readFile(new URL('../public/boot.js',import.meta.url),'utf8');
function readingFixture(saved){
  const styles={},root={dataset:{},style:{setProperty:(key,value)=>styles[key]=value}};
  const document={documentElement:root};
  const localStorage={getItem:key=>key==='qwen.prefs'?JSON.stringify(saved??{}):null};
  new Function('document','localStorage',readingBootSource)(document,localStorage);
  const before={...styles};
  const storage={get:()=>JSON.stringify(saved??{}),set(){}};
  const module=new Function('document','storage',readingPrefsSource+';return {prefs,apply,TEXT_SIZES,WIDTHS};')(document,storage);
  module.apply();return {module,styles,before};
}
test('new reading defaults apply before paint and migrate old sizes without losing sending or reasoning preferences',()=>{
  for(const saved of [{},{textSize:'large',width:'comfortable',reasoningOpen:true,sendKey:'ctrl-enter'}]){
    const f=readingFixture(saved);assert.deepEqual(f.before,f.styles);
    assert.equal(f.styles['--reading-size'],'14px');assert.equal(f.styles['--code-size'],'12px');assert.equal(f.styles['--measure'],'1120px');
    assert.equal(f.module.prefs.get().reasoningOpen,saved.reasoningOpen??false);assert.equal(f.module.prefs.get().sendKey,saved.sendKey??'enter');
  }
});
test('all four smaller text choices scale code too and retain a saved current reading preference',()=>{
  for(const [textSize,size,code]of[['xsmall',12,11],['small',13,11.5],['medium',14,12],['big',15,13]]){
    const f=readingFixture({readingVersion:2,textSize,width:'comfortable'});assert.deepEqual(f.before,f.styles);
    assert.equal(f.styles['--reading-size'],size+'px');assert.equal(f.styles['--code-size'],code+'px');assert.equal(f.styles['--measure'],'880px');
    assert.deepEqual(f.module.TEXT_SIZES.map(size=>size.label),['Extra small','Small','Medium','Big']);
  }
});

const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const handler=name=>{const source=app.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'))?.[0];assert(source,'Missing '+name);return source;};
const noop=()=>{};
const chat={id:'chat-a',title:'Task'};
const saved=(thinking='thought',extra={})=>({id:99,role:'assistant',content:'',thinking,status:'length',stats:{think:'medium',recovery:{version:1,through_chars:thinking.length,notes:'working notes'}},...extra});
const checkpoint=(code='work_checkpoint',message=saved())=>({event:'error',code,message:'Working notes saved.',message_saved:message});
const start=()=>({event:'start',chat,user_message:{id:7,role:'user',content:'task'}});
function fixture({think='medium',turn,continuation}={}){
  const calls={turn:[],continue:[],finish:[],resume:[],status:[],notices:[],restores:0,apiStop:0};
  const state={chat:{...chat},messages:[],generation:null,compaction:null,longInputPreparing:false,sendPreparing:false,loadingChatId:null};
  const route={id:chat.id};
  const element={dataset:{},remove:noop,querySelector:()=>null};
  const view={el:element,content:'',thinking:'',appendThinking(text){this.thinking+=text;},appendContent(text){this.content+=text;},
    setStatus:value=>calls.status.push(value),resume:value=>calls.resume.push(value),finish:(message,options)=>calls.finish.push({message,options}),markStopped(){calls.stopped=(calls.stopped||0)+1;}};
  const composer={think,value:'private unsent draft',attachments:[{name:'unsent.txt'}],captureDraft:()=>({key:'chat:'+chat.id,revision:1,text:'task'}),
    setGenerating:noop,setStopping:noop,setPreparing:noop,restore(){calls.restores++;},restoreDraft(){calls.restores++;}};
  const env={state,route,view,composer,els:{answerNow:{hidden:true,disabled:false,textContent:''}},MAX_AUTOMATIC_CONTINUES:8,MAX_AUTOMATIC_WORK_MS:12*60*1000,STOP_FALLBACK_MS:6000,
    currentChatId:()=>route.id,isImagesRoute:()=>false,stopFollow:noop,hideNotice:noop,scrollToBottom:noop,announce:noop,
    thread:{appendPendingUser:()=>({message:{el:element},el:element}),appendLiveAssistant:()=>view},
    sidebar:{setGenerating:noop},status:{refresh:noop},wakeLock:{acquire:noop,release:noop},telemetry:{setChat:noop},contextView:{refresh:noop},
    updateChat:noop,showNotice:text=>calls.notices.push(text),toast:noop,describeSendError:error=>error.message,refreshCurrent:noop,setTimeout:()=>1,
    api:{turn:async function*(id,body,signal){calls.turn.push({id,body,signal});yield*(turn?turn(env):[start(),checkpoint()]);},
      continueReply:async function*(id,signal,effort){calls.continue.push({id,signal,think:effort});yield*(continuation?continuation(env,calls.continue.length):[{event:'start',chat},{event:'done',chat,message:saved('done',{content:'Answer',status:'complete'})}]);},
      stop:async()=>{calls.apiStop++;}},
  };
  const source=['syncAnswerNow','answerNow','safeWorkCheckpoint','canContinueCheckpoint','handleEvent','continueCheckpoint','rollBack','send','continueReply','stop'].map(handler).join('\n');
  const methods=new Function('fixture','with(fixture){'+source+';return {send,continueReply,continueCheckpoint,stop,answerNow};}')(env);
  Object.assign(env,methods);
  return {env,state,route,view,composer,calls,...methods};
}

test('a safe checkpoint continues the same assistant view and ID without resubmitting the user or draft',async()=>{
  const f=fixture({turn:async function*(){yield start();yield {event:'thinking',text:'first '};yield checkpoint('work_checkpoint',saved('first '));},
    continuation:async function*(_env,n){yield {event:'start',chat};yield {event:'thinking',text:n===1?'second ':'third'};if(n===1)yield checkpoint('recovery_paused',saved('first second '));else yield {event:'done',chat,message:saved('first second third',{content:'Answer',status:'complete'})};}});
  await f.send('task');
  assert.equal(f.calls.turn.length,1);assert.equal(f.calls.continue.length,2);assert.equal(f.calls.resume.length,2);
  assert.equal(f.view.thinking,'first second third');assert.deepEqual(f.state.messages.map(m=>m.id),[7,99]);assert.equal(f.state.messages[1].status,'complete');
  assert.equal(f.calls.restores,0);assert.equal(f.composer.value,'private unsent draft');assert.deepEqual(f.composer.attachments,[{name:'unsent.txt'}]);
  assert(f.calls.continue.every(call=>call.signal===f.calls.turn[0].signal));assert(f.calls.status.some(status=>status.detail.includes('saved progress')));
});

test('automatic handoffs retain Off, Quick, Balanced and Deep exactly despite a later composer change',async()=>{
  for(const think of [false,'low','medium',true]){
    const f=fixture({think,turn:async function*(env){yield start();env.composer.think=think===false?true:false;yield checkpoint();}});
    await f.send('task');assert.equal(f.calls.turn[0].body.think,think);assert.equal(f.calls.continue[0].think,think);assert.deepEqual(f.calls.resume,[{thinking:think!==false}]);
  }
});

test('repeated unchanged checkpoints automatically finish once without an endless reasoning loop',async()=>{
  const f=fixture({continuation:async function*(){yield {event:'start',chat};yield checkpoint();}});await f.send('task');
  assert.equal(f.calls.continue.length,3);assert.deepEqual(f.calls.continue.map(call=>call.think),['medium','medium',false]);assert.equal(f.state.messages.filter(m=>m.id===99).length,1);
  assert.equal(f.calls.finish.at(-1).message.id,99);assert.equal(f.calls.finish.at(-1).message.status,'length');
  assert.match(f.calls.finish.at(-1).options.errorText,/answer-only pass/);
});

test('continuing progress is bounded by eight handoffs followed by one answer-only pass',async()=>{
  const f=fixture({continuation:async function*(_env,n){yield {event:'start',chat};yield checkpoint('work_checkpoint',saved('window '+n));}});await f.send('task');
  assert.equal(f.calls.continue.length,9);assert(f.calls.continue.slice(0,8).every(call=>call.think==='medium'));assert.equal(f.calls.continue[8].think,false);
});

test('the elapsed work budget finishes from saved work rather than asking for another Continue click',async()=>{
  const f=fixture({turn:async function*(env){yield start();env.state.generation.workStartedAt=Date.now()-13*60*1000;yield checkpoint();}});
  await f.send('task');assert.equal(f.calls.continue.length,1);assert.equal(f.calls.continue[0].think,false);
});

test('a checkpoint after nearly two hours still permits only one answer pass even when it returns no progress',async context=>{
  context.mock.timers.enable({apis:['Date'],now:1_800_000_000_000});
  const f=fixture({turn:async function*(){yield start();context.mock.timers.tick(2*60*60*1000-1000);yield checkpoint();},
    continuation:async function*(){yield {event:'start',chat};yield checkpoint();}});
  await f.send('task');
  assert.equal(f.calls.continue.length,1);assert.equal(f.calls.continue[0].think,false);
  assert.equal(f.state.messages.filter(message=>message.id===99).length,1);
  assert.match(f.calls.finish.at(-1).options.errorText,/answer-only pass/);
});

test('Answer now waits for the durable stopped reply then finishes the same ID without changing the chosen mode',async()=>{
  const f=fixture({turn:async function*(env){yield start();yield {event:'thinking',text:'initial work'};await env.answerNow();assert.equal(env.state.generation.answerRequested,true);yield {event:'done',chat,stopped_by:'another_device',message:saved('initial work',{status:'stopped'})};}});
  await f.send('task');assert.equal(f.calls.apiStop,1);assert.equal(f.calls.turn.length,1);assert.equal(f.calls.continue.length,1);assert.equal(f.calls.continue[0].think,false);assert.equal(f.composer.think,'medium');assert.equal(f.state.messages.at(-1).id,99);assert.equal(f.env.els.answerNow.hidden,true);
});

test('an unacknowledged Answer now stop does not start a racing request',async()=>{
  const f=fixture({turn:async function*(env){yield start();env.api.stop=async()=>{throw Error('offline');};yield {event:'thinking',text:'work'};await env.answerNow();yield {event:'error',code:'upstream',message_saved:saved('work',{status:'error'})};}});
  await f.send('task');assert.equal(f.calls.continue.length,0);assert(f.calls.notices.some(text=>text.includes('Could not confirm')));
});

test('Answer now waits for a pending stop acknowledgement even when the stream saves first',async()=>{
  let acknowledge,stopping;
  const f=fixture({turn:async function*(env){yield start();env.api.stop=scope=>{assert.equal(scope.chat_id,chat.id);return new Promise(resolve=>{acknowledge=resolve;});};yield {event:'thinking',text:'work'};stopping=env.answerNow();yield {event:'done',chat,stopped_by:'another_device',message:saved('work',{status:'stopped'})};}});
  const running=f.send('task');
  for(let i=0;i<10&&!acknowledge;i++)await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));assert(acknowledge);assert.equal(f.calls.continue.length,0);
  acknowledge({stopped:true});await stopping;await running;assert.equal(f.calls.continue.length,1);assert.equal(f.calls.continue[0].think,false);
});

test('Answer now on a tokenless continuation uses its existing durable reply',async()=>{
  const f=fixture({continuation:async function*(env,n){yield {event:'start',chat};if(n===1){await env.answerNow();yield {event:'error',code:'stopped',message_saved:null};}else yield {event:'done',chat,message:saved('work',{content:'Answer',status:'complete'})};}});
  const original=saved();f.state.messages=[{id:7,role:'user'},original];await f.continueReply(original,f.view);
  assert.deepEqual(f.calls.continue.map(call=>call.think),['medium',false]);assert.equal(f.state.messages.at(-1).content,'Answer');
});

test('Answer now racing a naturally complete answer never resumes or replaces it with an error',async()=>{
  const f=fixture({turn:async function*(env){yield start();yield {event:'thinking',text:'work'};await env.answerNow();yield {event:'done',chat,message:saved('work',{content:'Already complete',status:'complete'})};}});
  await f.send('task');assert.equal(f.calls.continue.length,0);assert.equal(f.calls.finish.at(-1).message.content,'Already complete');
});

test('a late failed stop after natural completion cannot resurrect the Answer now control or an error notice',async()=>{
  let rejectStop,stopping;
  const f=fixture({turn:async function*(env){yield start();env.api.stop=()=>new Promise((_resolve,reject)=>{rejectStop=reject;});yield {event:'thinking',text:'work'};stopping=env.answerNow();yield {event:'done',chat,message:saved('work',{content:'Complete',status:'complete'})};}});
  await f.send('task');assert.equal(f.state.generation,null);rejectStop(Error('late timeout'));await stopping;
  assert.equal(f.env.els.answerNow.hidden,true);assert.equal(f.calls.continue.length,0);assert.equal(f.calls.notices.length,0);
});

test('generic errors, lost streams, partial answers and malformed checkpoint messages never authorize an automatic request',async()=>{
  for(const terminal of [{event:'error',code:'upstream',message:'network error',message_saved:saved()},checkpoint('work_checkpoint',null),checkpoint('work_checkpoint',saved('x',{status:'stopped'})),{event:'done',chat,message:saved('x',{content:'partial answer'})},null]){
    const f=fixture({turn:async function*(){yield start();if(terminal)yield terminal;}});await f.send('task');assert.equal(f.calls.continue.length,0);
  }
});

test('Stop at a checkpoint cancels the handoff without stopping another device or restoring a sent draft',async()=>{
  const f=fixture({turn:async function*(env){yield start();yield checkpoint();env.stop();}});await f.send('task');
  assert.equal(f.calls.continue.length,0);assert.equal(f.calls.apiStop,0);assert.equal(f.calls.turn[0].signal.aborted,true);assert.equal(f.calls.restores,0);
});

test('Stop and user abort during an automatic request cannot trigger a second handoff',async()=>{
  for(const mode of ['stop','abort']){
    const f=fixture({continuation:async function*(env){yield {event:'start',chat};yield {event:'thinking',text:'more'};if(mode==='stop')env.stop();else env.state.generation.abort.abort();throw new DOMException('Cancelled','AbortError');}});
    await f.send('task');assert.equal(f.calls.continue.length,1);assert(f.calls.stopped);assert.equal(f.calls.restores,0);
  }
});

test('navigation away and returning to the original route still prevents future automatic requests',async()=>{
  const f=fixture({turn:async function*(env){yield start();yield checkpoint();env.state.generation.autoContinuationCancelled=true;env.route.id='another-chat';env.state.chat={id:'another-chat'};env.route.id=chat.id;env.state.chat={...chat};}});
  await f.send('task');assert.equal(f.calls.continue.length,0);
});

test('a refused or disconnected automatic continuation preserves its last checkpoint and never rolls back the accepted user',async()=>{
  for(const mode of ['refused','eof','error-event']){
    const f=fixture({continuation:async function*(){if(mode==='refused')throw new Error('refused');yield {event:'start',chat};if(mode==='error-event')yield {event:'error',code:'upstream',message:'Connection failed.'};}});
    await f.send('task');assert.equal(f.calls.continue.length,1);assert.equal(f.calls.finish.at(-1).message.id,99);assert.equal(f.calls.restores,0);
  }
});

test('a connection failure after a confirmed checkpoint leaves manual Continue and starts no automatic request',async()=>{
  const f=fixture({turn:async function*(){yield start();yield checkpoint();throw new Error('connection closed after checkpoint');}});
  await f.send('task');assert.equal(f.calls.continue.length,0);assert.equal(f.calls.finish.at(-1).message.id,99);assert.equal(f.calls.restores,0);
});

test('manual Continue uses the same safe handoff loop and does not clear unrelated composer content',async()=>{
  const original=saved();const f=fixture({think:'low',continuation:async function*(_env,n){yield {event:'start',chat};if(n===1)yield checkpoint();else yield {event:'done',chat,message:saved('done',{content:'Answer',status:'complete'})};}});
  f.state.messages=[{id:7,role:'user'},original];await f.continueReply(original,f.view);
  assert.equal(f.calls.turn.length,0);assert.equal(f.calls.continue.length,2);assert(f.calls.continue.every(call=>call.think==='low'));assert.equal(f.state.messages.length,2);assert.equal(f.state.messages[1].id,99);assert.equal(f.calls.restores,0);assert.equal(f.composer.value,'private unsent draft');
});

test('the API sends the explicit selected effort, including default Deep, in every continuation body',async()=>{
  const source=await fs.readFile(new URL('../public/js/api.js',import.meta.url),'utf8');
  const method=source.match(/api\.continueReply = async function\*[^]*?\n\};/)?.[0];assert(method);
  const calls=[],api={};const request=async(url,options)=>{calls.push({url,...options});return {body:'fixture'};};
  new Function('api','request','readNdjson',method)(api,request,async function*(){yield {event:'done'};});
  for(const think of [undefined,false,'low','medium',true]){for await(const _event of api.continueReply(chat.id,null,think)){}assert.deepEqual(calls.at(-1).body,{think:think??true});}
});

test('scoped Answer now stop requests have a finite timeout and carry the exact generation identity',async()=>{
  const source=await fs.readFile(new URL('../public/js/api.js',import.meta.url),'utf8');
  const method=source.match(/stop: \(scope\) => ([^\n]+),/)?.[1];assert(method);
  const scope={chat_id:chat.id,generation_id:'11111111-1111-1111-1111-111111111111'},calls=[];
  const request=async(url,options)=>{calls.push({url,...options});return {};};
  const stop=new Function('request','json','return scope => '+method)(request,value=>value);
  await stop(scope);assert.deepEqual(calls[0].body,scope);assert(calls[0].signal instanceof AbortSignal);assert.equal(calls[0].signal.aborted,false);
  await stop();assert.equal(calls[1].body,undefined);assert.equal(calls[1].signal,undefined);
});

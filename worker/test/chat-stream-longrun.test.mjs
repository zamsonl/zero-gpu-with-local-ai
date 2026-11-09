import assert from 'node:assert/strict';
import test from 'node:test';
import {streamChat,streamTiming} from '../src/chat-stream.js';
import {UpstreamError} from '../src/ollama.js';

const MINUTE=60_000,HOUR=60*MINUTE,epoch=1_800_000_000_000;
const encoder=new TextEncoder();
// Advance the real production timers, allowing the native stream/parser promise
// chain to drain between heartbeats. These are elapsed-time tests, not 24
// instantaneous empty responses standing in for a two-hour connection.
async function flush(){for(let index=0;index<40;index++)await Promise.resolve();}
async function advance(context,ms){
  while(ms>0){const step=Math.min(ms,10_000);context.mock.timers.tick(step);await flush();ms-=step;}
}
function modelServer({records=[],unreachableAt=Infinity,oldNotebook=false}={}){
  const calls=[],open=new Set();let identity,startedAt;
  const fetchImpl=async(url,options={})=>{
    calls.push({url,...options,at:Date.now()});
    if(options.method==='POST'){
      const body=JSON.parse(new TextDecoder().decode(options.body));
      identity={id:body.job_id,token:body.token,cursor:0};startedAt??=Date.now();
      return Response.json(identity,{status:202});
    }
    if(options.method==='DELETE'){for(const close of [...open])close();return Response.json({cancelled:true});}
    if(Date.now()-startedAt>=unreachableAt)throw new TypeError('Tunnel disconnected');
    if(oldNotebook)return Response.json({error:{code:'invalid_poll',message:'Invalid maximum stream duration.'}},{status:400});
    const query=new URL(url).searchParams,seconds=Number(query.get('max_seconds'));
    let cursor=Number(query.get('cursor')),closed=false,controller;
    const timers=[];
    const finish=()=>{
      if(closed)return;closed=true;open.delete(finish);
      for(const timer of timers)clearTimeout(timer);
      options.signal.removeEventListener('abort',abort);
      controller.close();
    };
    const abort=()=>{
      if(closed)return;closed=true;open.delete(finish);
      for(const timer of timers)clearTimeout(timer);
      controller.error(options.signal.reason);
    };
    const write=value=>{if(!closed)controller.enqueue(encoder.encode(JSON.stringify(value)+'\n'));};
    const pulse=()=>{
      if(closed)return;
      write({cursor,heartbeat:true,upstreamStatus:200});
      timers.push(setTimeout(pulse,10_000));
    };
    const body=new ReadableStream({start(value){
      controller=value;open.add(finish);options.signal.addEventListener('abort',abort,{once:true});
      for(let index=cursor;index<records.length;index++){
        const record=records[index],wait=startedAt+record.at-Date.now();
        if(wait>seconds*1000)break;
        const emit=()=>{
          if(closed)return;
          assert.equal(index,cursor,'The fixture must deliver each cursor in order');
          cursor++;write({cursor:index,record:record.value,upstreamStatus:200});
          if(record.value.done)finish();
        };
        if(wait<=0)emit();else timers.push(setTimeout(emit,wait));
        if(closed)break;
      }
      if(!closed){pulse();timers.push(setTimeout(finish,seconds*1000));}
    },cancel(){if(!closed){closed=true;open.delete(finish);for(const timer of timers)clearTimeout(timer);options.signal.removeEventListener('abort',abort);}}});
    return new Response(body);
  };
  return {fetchImpl,calls,get starts(){return calls.filter(call=>call.method==='POST');},get deletes(){return calls.filter(call=>call.method==='DELETE');}};
}
async function fixture(context,config={}){
  context.mock.timers.enable({apis:['Date','setTimeout'],now:epoch});
  const original=globalThis.fetch,server=modelServer(config),abort=new AbortController(),statuses=[],values=[];
  globalThis.fetch=server.fetchImpl;context.after(()=>{globalThis.fetch=original;});
  let settled=false;
  const result=(async()=>{
    try{
      for await(const value of streamChat({target:'https://fixture.trycloudflare.com',inferenceTransport:'jobs-v1',body:{model:'qwen-fixture',stream:true},signal:abort.signal,timing:streamTiming(),onStatus:status=>statuses.push({...status,at:Date.now()})}))values.push(value);
      return {values};
    }catch(error){return {error};}finally{settled=true;}
  })();
  await flush();
  return {server,abort,statuses,values,result,get settled(){return settled;}};
}
function checkIdentity(server){
  assert.equal(server.starts.length,1,'Leg boundaries must not start another inference');
  assert.equal(server.deletes.length,1,'Completion/failure must clean up once');
  const identity=JSON.parse(new TextDecoder().decode(server.starts[0].body));
  const reads=server.calls.filter(call=>!call.method);
  assert(reads.every(call=>call.url.includes('/_jobs/'+identity.job_id+'/stream?')));
  assert(reads.every(call=>new URL(call.url).searchParams.get('max_seconds')==='300'));
  assert(reads.every(call=>call.headers.authorization==='Bearer '+identity.token));
  assert(server.calls.length<=40,'A long healthy job must fit the free external request allowance');
}

test('accepted web prefill lasts beyond six and thirty minutes without spawning a new inference',async context=>{
  const f=await fixture(context,{records:[{at:31*MINUTE+1000,value:{message:{thinking:'First thought after prompt prefill.'}}},{at:32*MINUTE,value:{message:{content:'Answer'},done:true}}]});
  await advance(context,31*MINUTE);assert.equal(f.settled,false);assert.equal(f.values.length,0);
  assert(f.statuses.some(status=>status.detail.includes('Model job accepted')));
  assert(!f.statuses.some(status=>status.state==='retrying'),'Healthy prefill is not a lost connection');
  await advance(context,MINUTE);const result=await f.result;
  assert.equal(result.error,undefined);assert.equal(result.values.length,2);checkIdentity(f.server);
});

test('first output and completion just before the two-hour boundary survive twenty-four real elapsed legs',async context=>{
  const f=await fixture(context,{records:[{at:2*HOUR-1000,value:{message:{thinking:'The original long job is still active.'}}},{at:2*HOUR-500,value:{message:{content:'Completed before the overall deadline.'},done:true}}]});
  await advance(context,2*HOUR-2000);assert.equal(f.settled,false);assert.equal(f.values.length,0);
  await advance(context,1000);assert.equal(f.values.length,1);assert.equal(f.settled,false);
  await advance(context,500);const result=await f.result;
  assert.equal(result.error,undefined);assert.equal(result.values.at(-1).done,true);checkIdentity(f.server);
  assert.equal(f.server.calls.length,26);
});

for(const firstToken of [false,true])test(`the two-hour overall deadline is never reset by ${firstToken?'model output or reconnects':'healthy silent-prefill heartbeats'}`,async context=>{
  const f=await fixture(context,{records:firstToken?[{at:1000,value:{message:{thinking:'Preserved thought.'}}},{at:2*HOUR+1000,value:{done:true}}]:[]});
  await advance(context,2*HOUR-1000);assert.equal(f.settled,false);
  await advance(context,1000);const result=await f.result;
  assert(result.error instanceof UpstreamError);assert.equal(result.error.code,'job_timeout');
  assert.equal(f.values.length,firstToken?1:0);checkIdentity(f.server);
});

test('Stop after forty-five minutes of accepted prefill cancels once and cannot reconnect or restart',async context=>{
  const f=await fixture(context);await advance(context,45*MINUTE);
  const stopped=new Error('User pressed Stop');f.abort.abort(stopped);await flush();
  assert.equal((await f.result).error,stopped);checkIdentity(f.server);
  const calls=f.server.calls.length;await advance(context,2*HOUR);assert.equal(f.server.calls.length,calls);
});

test('a tunnel lost after thirty-seven minutes still exhausts bounded recovery instead of waiting two more hours',async context=>{
  const f=await fixture(context,{unreachableAt:37*MINUTE});
  await advance(context,37*MINUTE);assert.equal(f.settled,false);
  await advance(context,5*MINUTE);const result=await f.result;
  assert(result.error instanceof UpstreamError);assert.equal(result.error.code,'stream_unreachable');checkIdentity(f.server);
});

test('an older notebook fails with a precise restart instruction and never repeats the rejected inference',async context=>{
  const f=await fixture(context,{oldNotebook:true});await flush();const result=await f.result;
  assert.equal(result.error.code,'invalid_poll');assert.match(result.error.message,/Restart Kaggle or Colab with the updated notebook/);
  checkIdentity(f.server);assert.equal(f.server.calls.length,3);
});

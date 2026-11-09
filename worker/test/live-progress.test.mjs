import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {LiveReply,readLiveReply,FLUSH_MS} from '../src/live.js';
import {phaseStatus,withTransportProgress,formatProgressStatus} from '../public/js/progress-status.js';

function fixture(){
  const rows=new Map();
  const db={prepare(sql){return {bind(...values){return {
    async run(){
      if(sql.startsWith('INSERT'))rows.set(values[0],values[1]);
      else if(sql.startsWith('DELETE')&&JSON.parse(rows.get(values[0])||'{}').owner===values[1])rows.delete(values[0]);
      return {meta:{changes:1}};
    },
    async first(){const v=rows.get(values[0]);return v?{v}:null;},
  };}};}};
  const live=new LiveReply(db,{owner:'private-owner',chatId:'chat',userMessageId:1,assistantMessageId:2,thinking:'saved '});
  return {db,rows,live};
}
async function snapshot(db,predicate){
  const deadline=Date.now()+FLUSH_MS+700;
  while(Date.now()<deadline){const value=await readLiveReply(db,'chat');if(value&&predicate(value))return value;await delay(10);}
  assert.fail('The real live-reply flush did not expose the expected progress.');
}
const extracting={state:'recovering',operation:'reasoning_recovery',phase:'extracting',chunk:2,chunks:4,finish_reason:null,detail:'Preserving unfinished work',transport_state:'retrying',transport_detail:'Retry in five seconds',transport_attempt:3};

test('live polling retains the complete workflow and transport envelope without exposing its owner',async()=>{
  const f=fixture();
  try{
    f.live.update(extracting);
    let saved=await snapshot(f.db,value=>value.transport_attempt===3);
    for(const [key,value]of Object.entries(extracting))assert.equal(saved[key],value,key);
    assert.equal(saved.owner,undefined);assert.equal(saved.assistant_message_id,2);
    f.live.update({assistantMessageId:7});
    saved=await snapshot(f.db,value=>value.assistant_message_id===7);
    assert.equal(saved.phase,'extracting');assert.equal(saved.chunk,2);assert.equal(saved.transport_detail,extracting.transport_detail);
  }finally{await f.live.finish();}
  assert.equal(await readLiveReply(f.db,'chat'),null);
});

test('thinking and answer tokens clear obsolete recovery and connection details while preserving operation context',async()=>{
  const f=fixture();
  try{
    f.live.update(extracting);await snapshot(f.db,value=>value.phase==='extracting');
    f.live.update({thinking:'continued thought'});
    let saved=await snapshot(f.db,value=>value.phase==='thinking');
    assert.equal(saved.thinking,'saved continued thought');assert.equal(saved.state,'thinking');assert.equal(saved.operation,'reasoning_recovery');assert.equal(saved.detail,'');
    for(const key of ['chunk','chunks','finish_reason','transport_state','transport_detail','transport_attempt','attempt'])assert.equal(saved[key],undefined,key);
    f.live.update({content:'The answer.'});
    saved=await snapshot(f.db,value=>value.phase==='answering');
    assert.equal(saved.content,'The answer.');assert.equal(saved.state,'answering');assert.equal(saved.detail,'');assert.equal(saved.transport_detail,undefined);
  }finally{await f.live.finish();}
});

test('new statuses replace stale phase metadata and preserve explicit transport resets',async()=>{
  const f=fixture();
  try{
    f.live.update(extracting);await snapshot(f.db,value=>value.phase==='extracting');
    f.live.update({state:'recovering',operation:'reasoning_recovery',phase:'finishing',detail:'Writing the answer',finish_reason:'work_limit',transport_state:null,transport_detail:null,transport_attempt:null});
    let saved=await snapshot(f.db,value=>value.phase==='finishing');
    assert.equal(saved.finish_reason,'work_limit');assert.equal(saved.chunk,undefined);assert.equal(saved.chunks,undefined);
    assert.equal(saved.transport_state,null);assert.equal(saved.transport_detail,null);assert.equal(saved.transport_attempt,null);
    f.live.update({state:'connecting',detail:'Waiting for the model',attempt:2});
    saved=await snapshot(f.db,value=>value.state==='connecting');
    assert.equal(saved.detail,'Waiting for the model');assert.equal(saved.attempt,2);
    for(const key of ['operation','phase','finish_reason','transport_state','transport_detail','transport_attempt'])assert.equal(saved[key],undefined,key);
  }finally{await f.live.finish();}
});

test('legacy partial live rows remain readable and retain normal chat/staleness filtering',async()=>{
  const f=fixture();await f.live.finish();
  const legacy={owner:'legacy-owner',chat_id:'chat',user_message_id:1,content:'partial answer',thinking:'old thought',state:'connecting',detail:'Waiting',updated_at:new Date().toISOString()};
  f.rows.set('gen_live',JSON.stringify(legacy));
  const saved=await readLiveReply(f.db,'chat');
  assert.equal(saved.content,'partial answer');assert.equal(saved.phase,undefined);assert.equal(saved.owner,undefined);assert.equal(saved.detail,'Waiting');
  assert.equal(await readLiveReply(f.db,'another-chat'),null);
  f.rows.set('gen_live',JSON.stringify({...legacy,updated_at:new Date(Date.now()-61000).toISOString()}));
  assert.equal(await readLiveReply(f.db,'chat'),null);
});

test('the canonical owner and follower labels match through recovery, transport and real output',async()=>{
  const f=fixture();
  try{
    const status=withTransportProgress(phaseStatus('reasoning_recovery','extracting',{chunk:1,chunks:3}),{state:'loading',detail:'Loading model',attempt:1});
    f.live.update(status);
    let saved=await snapshot(f.db,value=>value.transport_state==='loading');
    assert.equal(formatProgressStatus(saved),formatProgressStatus(status));
    assert.equal(formatProgressStatus(saved),'Summarizing thinking (1 of 3) · Loading Qwen');
    f.live.update({thinking:'next token'});
    saved=await snapshot(f.db,value=>value.phase==='thinking');
    assert.equal(formatProgressStatus(saved),'Thinking');assert.equal(saved.detail,'');
  }finally{await f.live.finish();}
});

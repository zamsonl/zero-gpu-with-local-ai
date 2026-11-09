import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startStack} from './dev-stack.mjs';
let stack;
before(async()=>{stack=await startStack({port:8861,mockPort:11661,state:'.test-state/session-memory-'+process.pid,auth:'key',vars:{TIMING_SCALE:'0.05'}});});
after(async()=>{await stack?.stop();});
async function call(method,route,body,key=stack.relayKey){const response=await fetch(stack.url+route,{method,headers:{'content-type':'application/json',...(key?{'x-relay-key':key}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};}
test('memory review requires normal API authentication and a real chat; empty memory starts no inference',async()=>{
  const before=stack.mock.stats().chatCalls;
  assert.equal((await call('GET','/v1/chats/absent/memory',undefined,null)).status,401);
  assert.equal((await call('GET','/v1/chats/absent/memory')).status,404);
  const chat=(await call('POST','/v1/chats',{title:'Memory review fixture'})).body.chat;
  const response=await call('GET',`/v1/chats/${chat.id}/memory`);assert.equal(response.status,200);assert.deepEqual(response.body,{memory:null});
  assert.equal(stack.mock.stats().chatCalls,before);
});
test('review returns the exact validated checkpoint, excludes source digest and stale coverage, and never changes history',async()=>{
  const at=new Date().toISOString(),id='memory-review-fixture';
  await call('POST','/v1/import',{chats:[{id,title:'Saved memory fixture',created_at:at,updated_at:at,messages:[{role:'user',content:'Keep port 8247, replacing 8123.'},{role:'assistant',content:'Acknowledged.'}]}]});
  const original=(await call('GET',`/v1/chats/${id}`)).body.messages,through=original[1].id;
  const summary='Exact correction: port 8247 replaces 8123.';
  await stack.sql(`INSERT INTO chat_context (chat_id,summary,through_id,covered_count,source_digest,model,updated_at) VALUES ('${id}','${summary}',${through},2,'not-a-public-field','qwen3.8-hauhau','${at}')`);
  const reviewed=await call('GET',`/v1/chats/${id}/memory`);assert.equal(reviewed.status,200);
  assert.deepEqual(reviewed.body,{memory:{summary,covered_count:2,through_id:through,updated_at:at,model:'qwen3.8-hauhau'}});
  assert.deepEqual((await call('GET',`/v1/chats/${id}`)).body.messages,original);
  await stack.sql(`UPDATE chat_context SET through_id=99999999 WHERE chat_id='${id}'`);
  assert.deepEqual((await call('GET',`/v1/chats/${id}/memory`)).body,{memory:null});
});

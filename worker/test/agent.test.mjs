import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {parseAgentMessages,ACTION_SCHEMA} from '../src/agent.js';
import {startStack} from './dev-stack.mjs';
let stack;
before(async()=>{stack=await startStack({port:8857,mockPort:11557,state:'.test-state/agent',vars:{TIMING_SCALE:'0.1'}});});
after(async()=>{await stack?.stop();});
test('agent validation rejects unsupported roles and oversized context',()=>{
  assert.throws(()=>parseAgentMessages({messages:[{role:'tool',content:'x'}]},100));
  assert.throws(()=>parseAgentMessages({messages:[{role:'user',content:'xx'}]},1));
  assert.equal(ACTION_SCHEMA.properties.action.enum.length,11);
  assert(ACTION_SCHEMA.required.includes('content'));
});
test('legacy coding helpers cannot use the global owner GPU even with the owner relay key',async()=>{
  const before=stack.mock.stats().chatCalls;
  for(const key of [null,stack.relayKey]){
    const response=await fetch(stack.url+'/v1/agent/step',{method:'POST',headers:{'content-type':'application/json',...(key?{'x-relay-key':key}:{})},body:JSON.stringify({messages:[{role:'user',content:'Must not use the owner GPU.'}]})});
    assert.equal(response.status,403);assert.equal((await response.json()).error.code,'own_kaggle_required');
  }
  assert.equal(stack.mock.stats().chatCalls,before);
});

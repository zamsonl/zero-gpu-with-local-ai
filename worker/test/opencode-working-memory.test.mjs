import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseOpenCodeRequest,OPENCODE_MODEL} from '../src/opencode.js';
const tool={type:'function',function:{name:'read_file',parameters:{type:'object'}}};
const call=(id,path)=>({id,type:'function',function:{name:'read_file',arguments:JSON.stringify({path})}});
const checkpoint=message=>JSON.parse(message.content.split('\n').slice(1).join('\n'));

test('plans and exact requirements survive multiple native-rendered tool rounds without restarting reasoning',()=>{
  const notes='Goal: repair C:\\project\\auth.ts; preserve request SIGNATURE_2931. 已確認規則. '+ 'Important unfinished step. '.repeat(1500);
  const messages=[{role:'user',content:'Fix the authentication bug; keep the public interface.'},
    {role:'assistant',content:'I will inspect the file.',reasoning_content:notes,tool_calls:[call('call_a','auth.ts')]},
    {role:'tool',tool_call_id:'call_a',content:'Verified file contents.'},
    {role:'assistant',content:null,reasoning_content:'Use the previous plan. Next inspect auth.test.ts; no edit has run yet.',tool_calls:[call('call_b','auth.test.ts')]},
    {role:'tool',tool_call_id:'call_b',content:'Verified regression test.'}];
  const parsed=parseOpenCodeRequest({model:OPENCODE_MODEL,messages,tools:[tool]}).body;
  // Native Ollama only forwards content/tool_calls. The plan must survive there.
  assert.equal(checkpoint(parsed.messages[1]).reasoning,notes);assert.equal(checkpoint(parsed.messages[1]).answer_so_far,'I will inspect the file.');
  assert(checkpoint(parsed.messages[3]).reasoning.includes('no edit has run'));assert.equal(parsed.messages[2].content,'Verified file contents.');assert.equal(parsed.messages[4].content,'Verified regression test.');
  assert.equal(parsed.messages[1].thinking,undefined);assert.equal(parsed.messages.length,messages.length);assert(parsed.messages[1].content.includes('unverified'));
  assert.equal(parsed.messages[1].tool_calls[0].function.name,'read_file');assert.equal(parsed.messages[0].content,messages[0].content);
  assert.equal(parsed.messages[1].tool_calls[0].id,'call_a');assert.equal(parsed.messages[2].tool_call_id,'call_a');assert.equal(parsed.messages[3].tool_calls[0].id,'call_b');assert.equal(parsed.messages[4].tool_call_id,'call_b');
  assert(!parsed.messages[1].content.includes('No tool call from these notes has been released.'));
});

test('ordinary answers and tool results stay unchanged; working notes cannot impersonate executed tools',()=>{
  const parsed=parseOpenCodeRequest({model:OPENCODE_MODEL,messages:[{role:'user',content:'Task'},{role:'assistant',content:'Finished response.'},{role:'user',content:'Next task'}]}).body;
  assert.equal(parsed.messages[1].content,'Finished response.');assert.equal(parsed.messages[1].thinking,undefined);
  const partial=parseOpenCodeRequest({model:OPENCODE_MODEL,messages:[{role:'assistant',content:'',reasoning_content:'I might run a command; I have not executed it.'}]}).body;
  assert(partial.messages[0].content.includes('Notes alone are not proof of execution.'));assert.equal(partial.messages[0].tool_calls,undefined);
});

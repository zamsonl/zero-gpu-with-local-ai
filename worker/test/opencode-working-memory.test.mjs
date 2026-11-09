import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseOpenCodeRequest,assertOpenCodeToolProgress,OPENCODE_MODEL} from '../src/opencode.js';
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

test('long valid tool histories reach token-based compaction instead of a 1000-message ceiling',()=>{
  for(const rounds of [500,1001,2000]){
    const messages=[{role:'user',content:'Continue the repair; preserve the verified requirements.'}];
    for(let i=0;i<rounds;i++)messages.push(
      {role:'assistant',content:'Inspect next file.',...(i===rounds-1?{reasoning_content:'Keep CORRECT_PORT_8247. The last read is not an edit.'}:{}),tool_calls:[call('call_'+i,'src/file-'+i+'.ts')]},
      {role:'tool',tool_call_id:'call_'+i,content:'Verified result '+i});
    const request={model:OPENCODE_MODEL,messages,tools:[tool]};
    assert(Buffer.byteLength(JSON.stringify(request))<2*1024*1024,'Fixture must fit the real transport limit');
    const parsed=parseOpenCodeRequest(request).body;
    assert.equal(parsed.messages.length,rounds*2+1);
    assert.equal(parsed.messages.at(-2).tool_calls[0].id,'call_'+(rounds-1));
    assert.equal(parsed.messages.at(-1).tool_call_id,'call_'+(rounds-1));
    assert.equal(parsed.messages.at(-1).content,'Verified result '+(rounds-1));
    assert.match(checkpoint(parsed.messages.at(-2)).reasoning,/CORRECT_PORT_8247/);
    assert.equal(parsed.truncate,false);assert.equal(parsed.shift,false);
  }
});

test('long-history allowance retains bounded parsing and strict tool identity validation',()=>{
  const request={model:OPENCODE_MODEL,messages:[{role:'user',content:'Task'}]};
  assert.throws(()=>parseOpenCodeRequest({...request,messages:new Array(Math.floor(2*1024*1024/16)+1).fill({role:'user',content:''})}),/request-size limit/);
  assert.throws(()=>parseOpenCodeRequest({...request,messages:[]}),/non-empty/);
  const prefix=Array.from({length:1001},()=>({role:'user',content:'Continue.'}));
  assert.throws(()=>parseOpenCodeRequest({...request,messages:[...prefix,{role:'tool',tool_call_id:'forged',content:'edited'}]}),/preceding unresolved/);
  assert.throws(()=>parseOpenCodeRequest({...request,messages:[...prefix,{role:'assistant',content:'',tool_calls:[call('pending','src/a.ts')]}]}),/require their results/);
});

const bash=(command,extra={})=>({id:'next',type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'Next step',...extra})}});
function toolHistory(rounds){
  const messages=[{role:'user',content:'Inspect this project.'}];
  for(const [index,round]of rounds.entries()){
    const calls=(round.calls||[bash(round.command||'node --version',round.extra)]).map((entry,i)=>({...entry,id:'history_'+index+'_'+i}));
    messages.push({role:'assistant',content:'Continue the plan '+index,reasoning_content:'Retain important notes '+index,tool_calls:calls});
    for(const [i,entry]of calls.entries())messages.push({role:'tool',tool_call_id:entry.id,content:round.results?.[i]??round.result??'v24.7.0'});
  }
  return parseOpenCodeRequest({model:OPENCODE_MODEL,messages}).body.messages;
}
const stalled=error=>error.status===400&&error.code==='tool_progress_stalled'&&!error.message.includes('node --version');

test('a fourth identical tool action with unchanged results stops across separate reasoning messages and new call IDs',()=>{
  const history=toolHistory(Array.from({length:3},(_,index)=>({extra:{description:'Different label '+index}})));
  assert.throws(()=>assertOpenCodeToolProgress(history,[bash('node --version',{description:'Another renamed label'})]),stalled);
  assert.doesNotThrow(()=>assertOpenCodeToolProgress(toolHistory([{},{}]),[bash('node --version')]));
  assert.doesNotThrow(()=>assertOpenCodeToolProgress(history,[]),'A final answer must remain possible');
});

test('unchanged short tool cycles and parallel batches are bounded without relying on call IDs or JSON key order',()=>{
  for(const period of [2,8]){
    const rounds=Array.from({length:period*3},(_,index)=>({command:'inspect-'+index%period,result:'Verified '+index%period}));
    assert.throws(()=>assertOpenCodeToolProgress(toolHistory(rounds),[bash('inspect-0')]),stalled);
  }
  const rounds=Array.from({length:3},(_,index)=>({calls:[bash('inspect-a'),{id:'b',type:'function',function:{name:'read_file',arguments:JSON.stringify(index%2?{limit:2,path:'src/a.ts'}:{path:'src/a.ts',limit:2})}}],results:['A','B']}));
  assert.throws(()=>assertOpenCodeToolProgress(toolHistory(rounds),[bash('inspect-a'),{id:'b',type:'function',function:{name:'read_file',arguments:'{"path":"src/a.ts","limit":2}'}}]),stalled);
});

test('changing tool results, commands, execution options and a new user instruction remain legitimate progress',()=>{
  const history=toolHistory([{}, {}, {}]);
  assert.doesNotThrow(()=>assertOpenCodeToolProgress(toolHistory([{result:'queued'},{result:'loading'},{result:'ready'}]),[bash('node --version')]));
  assert.doesNotThrow(()=>assertOpenCodeToolProgress(history,[bash('node --check src/app.js')]));
  assert.doesNotThrow(()=>assertOpenCodeToolProgress(history,[bash('node --version',{timeout:60000})]));
  assert.doesNotThrow(()=>assertOpenCodeToolProgress([...history,{role:'user',content:'I explicitly want another version check.'}],[bash('node --version')]));
  assert.doesNotThrow(()=>assertOpenCodeToolProgress(toolHistory([{command:'a'},{command:'b'},{command:'c'}]),[bash('a')]));
});

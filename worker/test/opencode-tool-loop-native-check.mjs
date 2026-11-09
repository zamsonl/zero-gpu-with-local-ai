// Optional installed-OpenCode regression. Loopback mocks exercise the real
// gateway; no Kaggle credentials, remote inference or notebook are used.
// Run from worker: QWEN_OPENCODE_EXE=<local executable> node test/run-tests.mjs test/opencode-tool-loop-native-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {HttpError,errorJson,json,readJsonObject} from '../src/http.js';
import {JobsTransportError,createJobBudget} from '../src/jobs-transport.js';
import {createOpenCodeRuntime,MODEL,MODEL_ID,PROVIDER_ID} from '../../client/agent/opencode-config.mjs';
import {RELAY_ORIGIN} from '../../client/agent/kaggle-session.mjs';

const executable=process.env.QWEN_OPENCODE_EXE;assert(executable,'Set QWEN_OPENCODE_EXE to the installed OpenCode executable.');
const root=path.resolve('.test-state/nl');await fs.mkdir(root,{recursive:true});
const source=(await fs.readFile(new URL('../src/opencode.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
const results=[];
for(const mode of ['repeat','cycle','changed-command','changed-result']){
  let runtime,child,main=0,phase=mode;const serverErrors=[],state=new Map();
  const target={target:'https://model.example.invalid',host:'kaggle',quant:'Q5_K_P',num_ctx:98304,num_batch:256,vision:false,inference_transport:'jobs-v1',job_max_leg_seconds:300,job_control:true};
  const db={prepare:sql=>({bind:(key,value)=>({first:async()=>state.has(key)?{v:state.get(key)}:null,run:async()=>{if(sql.startsWith('DELETE'))state.delete(key);else state.set(key,value);return {meta:{changes:1}};}})})};
  const deps={HttpError,errorJson,json,readJsonObject,JobsTransportError,createJobBudget,
    readTarget:async()=>target,GenerationLock:{acquire:async()=>({lock:{id:crypto.randomUUID(),release:async()=>{}}})},
    streamJobRecords:async function*(options){
      const body=JSON.parse(options.payload),isMain=body.tools?.length&&body.think!==false;
      if(isMain)assert(++main<=9,'A repeated tool request escaped the bounded native fixture');
      const final=isMain&&(phase==='resume'?main>=2:['changed-command','changed-result'].includes(phase)&&main>=7);
      if(!isMain||final)yield {value:{model:MODEL_ID,message:{content:final?'CHECK_COMPLETE':'Local check'},done:false},upstreamStatus:200};
      else{
        const command=phase==='changed-command'?'node -p '+main:phase==='changed-result'?'node -p process.pid':phase==='cycle'&&main%2===0?'node -p 8247':'node --version';
        yield {value:{model:MODEL_ID,message:{thinking:'Read and retain the current verified results.',tool_calls:[{function:{name:'bash',arguments:{command,description:'Read-only check '+main}}}]},done:false},upstreamStatus:200};
      }
      yield {value:{model:MODEL_ID,done:true,done_reason:'stop',prompt_eval_count:500,eval_count:20},upstreamStatus:200};
    },
  };
  const openCodeChat=new Function('deps','with(deps){'+source+';return openCodeChat;}')(deps);
  const server=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const data of req)raw+=data;const background=[];
      const response=await openCodeChat({request:new Request('https://relay.example.invalid/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:raw}),
        env:{AGENT_SESSION:true,AGENT_CONTROL_KEY:'f'.repeat(64),DB:db},ctx:{waitUntil:promise=>background.push(promise)}});
      res.writeHead(response.status,Object.fromEntries(response.headers));
      const reader=response.body.getReader();for(;;){const item=await reader.read();if(item.done)break;res.write(item.value);}res.end();await Promise.all(background);
    }catch(error){serverErrors.push(error.message);if(res.headersSent)res.destroy();else{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message,type:'api_error',code:'fixture_limit'}}));}}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  async function launch(prompt,sessionID){
    const args=['run','--format','json','--thinking','--model',MODEL,...(sessionID?['--session',sessionID]:[]),prompt];
    child=spawn(executable,args,{cwd:root,env:runtime.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
    const timer=setTimeout(()=>child.kill(),30000);const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timer);
    const events=output.split('\n').filter(line=>line.trim().startsWith('{')).map(JSON.parse);
    const tools=events.filter(event=>event.type==='tool_use'&&event.part.state.status==='completed');
    return {code,events,tools,errors};
  }
  try{
    const id='native_loop_'+mode.replaceAll('-','_')+'_123456';
    runtime=await createOpenCodeRuntime({session_id:id,key:'local_fixture_key_12345678901234567890',relay:RELAY_ORIGIN+'/_agent/'+id,owner:'fixture',host:'kaggle',expires_at:new Date(Date.now()+3600000).toISOString(),url:'https://www.kaggle.com/code/fixture/qwen-agent-'+id},{baseDirectory:path.join(root,String(results.length),'t'),stateDirectory:path.join(root,String(results.length),'h'),projectFolder:root});
    assert.equal(runtime.config.permission.doom_loop,'ask');
    runtime.config.provider[PROVIDER_ID].options.baseURL='http://127.0.0.1:'+server.address().port+'/v1';
    runtime.config.permission={'*':'deny',bash:{'*':'deny','node *':'allow'},doom_loop:'deny'};
    runtime.env.OPENCODE_CONFIG_CONTENT=JSON.stringify(runtime.config);await fs.writeFile(path.join(runtime.directory,'opencode.json'),JSON.stringify(runtime.config));
    const run=await launch('Use bash for the requested read-only Node checks, then answer.');
    const blocked=mode==='repeat'||mode==='cycle';
    assert.equal(serverErrors.length,0,serverErrors.join('\n'));assert.equal(run.code,blocked?1:0,run.errors.slice(-500));
    assert.equal(main,mode==='repeat'?4:7);assert.equal(run.tools.length,mode==='repeat'?3:6);
    assert(run.events.some(event=>event.type==='reasoning'),'Native reasoning disappeared');
    if(blocked)assert(run.events.some(event=>event.type==='error'&&JSON.stringify(event.error).includes('tool_progress_stalled')),'Native loop did not stop with the terminal gateway error');
    else assert(run.events.some(event=>event.type==='text'&&event.part.text.includes('CHECK_COMPLETE')),'Legitimate progress did not finish');
    const result={mode,main_requests:main,completed_tools:run.tools.length,passed:true};
    if(mode==='repeat'){
      phase='resume';main=0;const sessionID=run.events.find(event=>event.sessionID)?.sessionID;assert(sessionID);
      const resumed=await launch('I explicitly want one more Node version check now; then answer.',sessionID);
      assert.equal(resumed.code,0,resumed.errors.slice(-500));assert.equal(main,2);assert.equal(resumed.tools.length,1);assert(!resumed.events.some(event=>event.type==='error'));
      result.explicit_new_user_turn_allowed=true;
    }
    results.push(result);
  }finally{
    if(child&&child.exitCode===null)child.kill();await runtime?.cleanup();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
console.log(JSON.stringify({passed:true,hosted_inference_calls:0,kaggle_launches:0,results},null,2));

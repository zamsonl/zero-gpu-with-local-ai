// Optional installed-OpenCode check for the thinking modes (fast, light, normal, deep).
// Loopback mocks exercise the real gateway; no Kaggle credentials, remote inference
// or notebook are used.
// Run from worker: QWEN_OPENCODE_EXE=<local executable> node test/run-tests.mjs test/opencode-modes-native-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {HttpError,errorJson,json,readJsonObject} from '../src/http.js';
import {JobsTransportError,createJobBudget} from '../src/jobs-transport.js';
import {createOpenCodeRuntime,MODEL,MODEL_ID,PROVIDER_ID,THINKING_MODES} from '../../client/agent/opencode-config.mjs';
import {RELAY_ORIGIN} from '../../client/agent/kaggle-session.mjs';

const executable=process.env.QWEN_OPENCODE_EXE;assert(executable,'Set QWEN_OPENCODE_EXE to the installed OpenCode executable.');
const root=path.resolve('.test-state/nm');await fs.mkdir(root,{recursive:true});
const source=(await fs.readFile(new URL('../src/opencode.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
const think={none:false,low:'low',medium:'medium',high:true};
const results=[];
// One plain turn per mode, then a turn in deep mode whose history outgrows the
// window so that OpenCode writes its continuation summary.
for(const scenario of [{mode:null},...Object.keys(THINKING_MODES).map(mode=>({mode})),{mode:'deep',overflow:true}]){
  let runtime,child,main=0;const serverErrors=[],state=new Map(),received=[],sent=[];
  const target={target:'https://model.example.invalid',host:'kaggle',quant:'Q5_K_P',num_ctx:98304,num_batch:256,vision:false,inference_transport:'jobs-v1',job_max_leg_seconds:300,job_control:true};
  const db={prepare:sql=>({bind:(key,value)=>({first:async()=>state.has(key)?{v:state.get(key)}:null,run:async()=>{if(sql.startsWith('DELETE'))state.delete(key);else state.set(key,value);return {meta:{changes:1}};}})})};
  const deps={HttpError,errorJson,json,readJsonObject,JobsTransportError,createJobBudget,
    readTarget:async()=>target,GenerationLock:{acquire:async()=>({lock:{id:crypto.randomUUID(),release:async()=>{}}})},
    streamJobRecords:async function*(options){
      const body=JSON.parse(options.payload),coding=body.tools?.length>0;
      sent.push({coding,think:body.think,num_predict:body.options.num_predict});
      if(coding)assert(++main<=4,'The coding turn escaped the bounded native fixture');
      if(coding&&scenario.overflow&&main===1){
        yield {value:{model:MODEL_ID,message:{thinking:'Check the installed Node version first.',tool_calls:[{function:{name:'bash',arguments:{command:'node --version',description:'Read-only check'}}}]},done:false},upstreamStatus:200};
        yield {value:{model:MODEL_ID,done:true,done_reason:'stop',prompt_eval_count:90000,eval_count:20},upstreamStatus:200};return;
      }
      yield {value:{model:MODEL_ID,message:{content:coding?'CHECK_COMPLETE':'## Goal\nFinish the read-only Node check.\n## Next step\nAnswer.'},done:false},upstreamStatus:200};
      yield {value:{model:MODEL_ID,done:true,done_reason:'stop',prompt_eval_count:500,eval_count:20},upstreamStatus:200};
    },
  };
  const openCodeChat=new Function('deps','with(deps){'+source+';return openCodeChat;}')(deps);
  const server=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const data of req)raw+=data;const background=[];
      const body=JSON.parse(raw);
      received.push({coding:body.tools?.length>0,effort:body.reasoning_effort,system:String(body.messages.find(message=>message.role==='system')?.content||'').slice(0,60)});
      const response=await openCodeChat({request:new Request('https://relay.example.invalid/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:raw}),
        env:{AGENT_SESSION:true,AGENT_CONTROL_KEY:'f'.repeat(64),DB:db},ctx:{waitUntil:promise=>background.push(promise)}});
      res.writeHead(response.status,Object.fromEntries(response.headers));
      const reader=response.body.getReader();for(;;){const item=await reader.read();if(item.done)break;res.write(item.value);}res.end();await Promise.all(background);
    }catch(error){serverErrors.push(error.message);if(res.headersSent)res.destroy();else{res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:error.message,type:'api_error',code:'fixture_limit'}}));}}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const id='native_mode_'+(scenario.mode||'unset')+(scenario.overflow?'_overflow':'')+'_123456';
    runtime=await createOpenCodeRuntime({session_id:id,key:'local_fixture_key_12345678901234567890',relay:RELAY_ORIGIN+'/_agent/'+id,owner:'fixture',host:'kaggle',expires_at:new Date(Date.now()+3600000).toISOString(),url:'https://www.kaggle.com/code/fixture/qwen-agent-'+id},{baseDirectory:path.join(root,String(results.length),'t'),stateDirectory:path.join(root,String(results.length),'h'),projectFolder:root});
    assert.deepEqual(Object.keys(runtime.config.provider[PROVIDER_ID].models[MODEL_ID].variants),Object.keys(THINKING_MODES));
    runtime.config.provider[PROVIDER_ID].options.baseURL='http://127.0.0.1:'+server.address().port+'/v1';
    runtime.config.permission={'*':'deny',bash:{'*':'deny','node *':'allow'},doom_loop:'deny'};
    runtime.env.OPENCODE_CONFIG_CONTENT=JSON.stringify(runtime.config);await fs.writeFile(path.join(runtime.directory,'opencode.json'),JSON.stringify(runtime.config));
    const args=['run','--format','json','--thinking','--model',MODEL,...(scenario.mode?['--variant',scenario.mode]:[]),'Use bash for one read-only Node check, then answer.'];
    child=spawn(executable,args,{cwd:root,env:runtime.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
    const timer=setTimeout(()=>child.kill(),60000);const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timer);
    const events=output.split('\n').filter(line=>line.trim().startsWith('{')).map(JSON.parse);
    assert.equal(serverErrors.length,0,serverErrors.join('\n'));assert.equal(code,0,errors.slice(-500));
    assert(events.some(event=>event.type==='text'&&event.part.text.includes('CHECK_COMPLETE')),'The turn did not finish');
    // Every coding request carries the chosen mode; with none chosen it is normal.
    const expected=think[THINKING_MODES[scenario.mode||'normal']];
    const coding=sent.filter(request=>request.coding);
    assert(coding.length>0);for(const request of coding)assert.equal(request.think,expected,'Mode '+scenario.mode+' reached the model as '+request.think);
    // Titles and continuation summaries never think, whatever mode the turn used.
    const notes=sent.filter(request=>!request.coding);
    for(const request of notes)assert.equal(request.think,false,'A summary or title was allowed to think in mode '+scenario.mode+': '+JSON.stringify(received));
    const result={mode:scenario.mode||'(none chosen)',overflow:!!scenario.overflow,coding_requests:coding.length,model_think:expected,summary_requests:notes.length,passed:true};
    if(scenario.overflow){
      const summaries=received.filter(request=>!request.coding&&request.system.startsWith('Summarize this coding session'));
      assert(summaries.length>0,'OpenCode did not write a continuation summary: '+JSON.stringify(received));
      result.summary_effort_from_opencode=summaries.map(request=>request.effort??null);
    }
    results.push(result);
  }finally{
    if(child&&child.exitCode===null)child.kill();await runtime?.cleanup();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
console.log(JSON.stringify({passed:true,hosted_inference_calls:0,kaggle_launches:0,results},null,2));

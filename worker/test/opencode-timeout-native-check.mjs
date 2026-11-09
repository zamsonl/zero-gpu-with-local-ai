// Optional installed-OpenCode seam check. Uses loopback only, never Kaggle.
// QWEN_OPENCODE_EXE selects the reviewed local executable.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createOpenCodeRuntime,MODEL,MODEL_ID,PROVIDER_ID} from '../../client/agent/opencode-config.mjs';
import {RELAY_ORIGIN} from '../../client/agent/kaggle-session.mjs';
import {HttpError} from '../src/http.js';

const executable=process.env.QWEN_OPENCODE_EXE;
assert(executable,'Set QWEN_OPENCODE_EXE to the installed OpenCode executable.');
// Keep native Bun's Windows paths below MAX_PATH, including its hashed owner.
const root=path.resolve('.test-state/nt');await fs.mkdir(root,{recursive:true});
const gatewaySource=(await fs.readFile(new URL('../src/opencode.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
const deadlineFailure=new Function('HttpError',gatewaySource+';return requestTimeout();')(HttpError);
assert.equal(deadlineFailure.status,400);
const results=[];
for(const mode of ['sdk-deadline','sdk-delivery-grace','streamed-deadline','http-deadline','terminal-http-deadline']){
  const requests=[],serverErrors=[];let runtime,child;
  const server=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const data of req)raw+=data;
      const body=JSON.parse(raw);requests.push({model:body.model,effort:body.reasoning_effort});
      assert.equal(body.model,MODEL_ID);
      if(body.reasoning_effort==='none'){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.end('data: '+JSON.stringify({id:'metadata',object:'chat.completion.chunk',created:1,model:MODEL_ID,choices:[{index:0,delta:{content:'Local check'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
      }
      if(mode==='sdk-deadline'||mode==='sdk-delivery-grace')await new Promise(resolve=>setTimeout(resolve,1200));
      if(mode!=='http-deadline'&&mode!=='terminal-http-deadline'){
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.end('data: '+JSON.stringify({error:{message:deadlineFailure.message,type:'api_error',code:deadlineFailure.code}})+'\n\ndata: [DONE]\n\n');
      }else{
        // Prove the SDK retries a pre-stream HTTP 504, then terminate the
        // fixture with a nonretryable status rather than creating a real loop.
        const main=requests.filter(request=>request.effort!=='none');
        res.writeHead(mode==='http-deadline'&&main.length===1?504:deadlineFailure.status,{'content-type':'application/json'});
        res.end(JSON.stringify({error:{message:deadlineFailure.message,type:'api_error',code:deadlineFailure.code}}));
      }
    }catch(error){serverErrors.push(error.message);res.destroy();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const id='native_timeout_'+mode.replaceAll('-','_')+'_123456';
    const slot=String(results.length);
    runtime=await createOpenCodeRuntime({session_id:id,key:'local_fixture_key_12345678901234567890',relay:RELAY_ORIGIN+'/_agent/'+id,owner:'fixture',host:'kaggle',expires_at:new Date(Date.now()+3600000).toISOString(),url:'https://www.kaggle.com/code/fixture/qwen-agent-'+id},{baseDirectory:path.join(root,slot,'t'),stateDirectory:path.join(root,slot,'h'),projectFolder:root});
    runtime.config.provider[PROVIDER_ID].options.baseURL='http://127.0.0.1:'+server.address().port+'/v1';
    runtime.config.provider[PROVIDER_ID].options.timeout=mode==='sdk-deadline'?1000:mode==='sdk-delivery-grace'?1800:10000;
    runtime.config.permission={'*':'deny'};
    runtime.env.OPENCODE_CONFIG_CONTENT=JSON.stringify(runtime.config);await fs.writeFile(path.join(runtime.directory,'opencode.json'),JSON.stringify(runtime.config));
    child=spawn(executable,['run','--format','json','--model',MODEL,'Answer READY.'],{cwd:root,env:runtime.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    const timer=setTimeout(()=>child.kill(),30000);const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timer);
    const events=stdout.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
    const main=requests.filter(request=>request.effort!=='none');
    assert(main.length>0,'Native client did not reach the loopback fixture: '+stderr.slice(-500));
    assert.equal(code,1,'A deadline must stop the native request');assert.equal(serverErrors.length,0);
    assert.equal(main.length,mode==='http-deadline'?2:1,'Terminal SSE deadlines must not replay inference');
    assert(events.some(event=>event.type==='error'&&JSON.stringify(event.error).includes(mode==='sdk-deadline'?'operation timed out':'two-hour time limit')),'Native deadline cause was not preserved');
    results.push({mode,exit_code:code,main_requests:main.length,events:events.filter(event=>event.type==='error'),stderr:stderr.slice(-500),server_errors:serverErrors});
  }finally{
    if(child&&child.exitCode===null)child.kill();await runtime?.cleanup();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
console.log(JSON.stringify(results,null,2));

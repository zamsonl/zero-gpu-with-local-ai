// Real-program check of "Continue my last conversation". Loopback only; no Kaggle,
// hosted model or credentials.
//   A. The helper asks the installed OpenCode whether a conversation is saved for a folder:
//      none before the first one, one afterwards.
//   B. The real setup page in a real browser: the checkbox is off at first, reaches the
//      launcher as --continue, and is remembered by the next setup window.
// Run from worker:
//   QWEN_OPENCODE_EXE=<local executable> node test/run-tests.mjs test/continue-check.mjs /path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createOpenCodeRuntime,MODEL,MODEL_ID,PROVIDER_ID} from '../../client/agent/opencode-config.mjs';
import {hasSavedConversation} from '../../client/agent/opencode.mjs';
import {RELAY_ORIGIN} from '../../client/agent/kaggle-session.mjs';
import {startSetupServer} from '../../client/agent/setup.mjs';

const executable=process.env.QWEN_OPENCODE_EXE;assert(executable,'Set QWEN_OPENCODE_EXE to the installed OpenCode executable.');
assert(process.argv[2],'Pass the entry path of an already installed Playwright package.');
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'qcc-'));const project=path.join(root,'p');await fs.mkdir(project);
const result={};

// A. The installed OpenCode, with a loopback stand-in for the model.
const model=http.createServer(async(req,res)=>{for await(const _ of req);res.writeHead(200,{'content-type':'text/event-stream'});
  res.end('data: '+JSON.stringify({id:'x',object:'chat.completion.chunk',created:1,model:MODEL_ID,choices:[{index:0,delta:{content:'READY'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
let runtime;
try{
  const id='native_continue_check_123456';
  runtime=await createOpenCodeRuntime({session_id:id,key:'local_fixture_key_12345678901234567890',relay:RELAY_ORIGIN+'/_agent/'+id,owner:'fixture',host:'kaggle',expires_at:new Date(Date.now()+3600000).toISOString(),url:'https://www.kaggle.com/code/fixture/qwen-agent-'+id},{baseDirectory:path.join(root,'t'),stateDirectory:path.join(root,'h'),projectFolder:project});
  runtime.config.provider[PROVIDER_ID].options.baseURL='http://127.0.0.1:'+model.address().port+'/v1';runtime.config.permission={'*':'deny'};
  const env={...runtime.env,OPENCODE_CONFIG_CONTENT:JSON.stringify(runtime.config)};
  await fs.writeFile(path.join(runtime.directory,'opencode.json'),JSON.stringify(runtime.config));
  const invocation={command:executable,args:[]};
  result.savedBeforeFirstConversation=await hasSavedConversation(invocation,{folder:project,env});
  assert.equal(result.savedBeforeFirstConversation,false,'A folder with no conversation must not be continued');
  const code=await new Promise((resolve,reject)=>{const child=spawn(executable,['run','--format','json','--model',MODEL,'Answer READY.'],{cwd:project,env:{...env,PWD:project},windowsHide:true,shell:false,stdio:'ignore'});const timer=setTimeout(()=>child.kill(),60000);child.once('close',value=>{clearTimeout(timer);resolve(value);});child.once('error',reject);});
  assert.equal(code,0,'The stand-in conversation did not complete');
  result.savedAfterFirstConversation=await hasSavedConversation(invocation,{folder:project,env});
  assert.equal(result.savedAfterFirstConversation,true,'A saved conversation was not found');
  result.missingProgramIsTreatedAsNone=await hasSavedConversation({command:path.join(root,'no-such-program.exe'),args:[]},{folder:project,env});
  assert.equal(result.missingProgramIsTreatedAsNone,false);
}finally{await runtime?.cleanup();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));}

// B. The real setup page. It keeps a live event stream open, so wait for its Start button, not for network idle.
const seen=[],cleanup=[],old=['qwen-agent-'+'a'.repeat(24),'qwen-agent-'+'b'.repeat(24)];let browser;
const open=async()=>{let finish;const done=new Promise(resolve=>finish=resolve);
  const local=await startSetupServer({controllerDependencies:{preferenceFile:path.join(root,'prefs.json'),hasRememberedToken:async()=>true,loadSavedToken:async()=>'KGAT_cleanup_fixture_0123456789',findOldNotebooks:async()=>{cleanup.push('find');return {owner:'fixture',old,kept:1};},removeOldNotebooks:async()=>{cleanup.push('remove');return {owner:'fixture',removed:[old[0]],failed:[old[1]],kept:1};},launch:async args=>{seen.push(args);return {done,close:async()=>finish({code:0})};}}});
  return {local,stop:async()=>{finish({code:0});await local.close();}};};
try{
  browser=await chromium.launch({headless:true});
  let setup=await open();
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(setup.local.url,{waitUntil:'load'});await page.waitForSelector('#start:not([disabled])',{timeout:15000});
    assert.equal(await page.isChecked('#resume'),false,'Continue must be off until chosen');
    // C. Remove old notebooks: counted first, deleted only after the dialog is confirmed.
    await page.click('#clean-notebooks');await page.waitForSelector('#clean-dialog[open]',{timeout:10000});
    assert((await page.textContent('#clean-summary')).startsWith('Found 2 finished notebooks'));assert.deepEqual(cleanup,['find']);
    await page.keyboard.press('Escape');await new Promise(resolve=>setTimeout(resolve,400));assert.deepEqual(cleanup,['find'],'Closing the dialog must not delete anything');
    await page.click('#clean-notebooks');await page.waitForSelector('#clean-dialog[open]',{timeout:10000});await page.click('#clean-dialog button[value="remove"]');
    await page.waitForFunction(()=>document.getElementById('clean-result').textContent.startsWith('Removed'),null,{timeout:10000});
    assert.equal(await page.textContent('#clean-result'),'Removed 1 old notebook; 1 could not be removed.');assert.deepEqual(cleanup,['find','find','remove']);
    await page.click('#clean-notebooks');await page.waitForSelector('#clean-dialog[open]',{timeout:10000});await page.keyboard.press('Escape');await new Promise(resolve=>setTimeout(resolve,400));
    assert.deepEqual(cleanup,['find','find','remove','find'],'A dialog dismissed after an earlier yes must not delete again');result.cleanupNeedsConfirmationEveryTime=true;
    await page.fill('#folder',project);await page.check('#resume');await page.check('#gpu-consent');await page.click('#start');
    for(let i=0;i<300&&!seen.length;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(seen.length,1,'Start did not reach the launcher: '+errors.join(' | ')+' | '+await page.textContent('#form-error').catch(()=>''));
    assert(seen[0].includes('--continue'),'The choice did not reach the launcher: '+seen[0].join(' '));
    assert.deepEqual(errors,[]);result.pageSendsContinue=true;await page.close();
  }finally{await setup.stop();}
  setup=await open();
  try{
    const page=await browser.newPage();await page.goto(setup.local.url,{waitUntil:'load'});await page.waitForSelector('#start:not([disabled])',{timeout:15000});
    let remembered=false;for(let i=0;i<100&&!remembered;i++){remembered=await page.isChecked('#resume');if(!remembered)await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(remembered,true,'The next setup window did not remember the choice');result.nextWindowRemembers=true;
    await page.uncheck('#resume');await page.check('#gpu-consent');await page.click('#start');
    for(let i=0;i<300&&seen.length<2;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(seen.length,2);assert(!seen[1].includes('--continue'),'Unticking must start a new conversation');result.untickStartsNew=true;await page.close();
  }finally{await setup.stop();}
}finally{await browser?.close();await fs.rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:true,hosted_inference_calls:0,kaggle_launches:0,...result},null,2));
process.exit(0);

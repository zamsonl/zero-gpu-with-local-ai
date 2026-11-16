// Real-browser check that a reply carries on by itself. Local dev stack with the fake model and an
// already installed Playwright: no GPU, no hosted model and never the live site.
//   A. An answer cut at its length limit continues automatically as the same reply and finishes.
//   B. That automatic continuation is bounded.
//   C. A dropped connection (offline, then back) ends with the same reply complete, not an error.
//   D. Stop while waiting for the connection ends the wait and starts nothing.
// node test/run-tests.mjs test/reply-continuity-browser-check.mjs /path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startStack} from './dev-stack.mjs';

if(!process.argv[2])throw new Error('Pass the entry path of an already installed Playwright package.');
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const stack=await startStack({port:8819,mockPort:11519,state:'.test-state/reply-continuity'});
const mock=(route,body)=>fetch(stack.mock.url+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined).then(response=>response.json());
// The stack's own local database: these are this check's chats only.
const local=route=>fetch(stack.url+route).then(response=>response.json());
const continues=()=>stack.mock.requests().filter(request=>request.path==='/api/generate').length;
// A small TCP relay in front of the dev server stands in for the network: dropping it cuts every
// open connection, including a reply that is streaming, and refuses new ones until restored.
const sockets=new Set();let down=false;
const relay=net.createServer(client=>{
  if(down){client.destroy();return;}
  const upstream=net.connect(8819,'127.0.0.1');
  const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};
  sockets.add(client);sockets.add(upstream);client.pipe(upstream);upstream.pipe(client);
  for(const socket of [client,upstream]){socket.on('error',close);socket.on('close',close);}
});
await new Promise(resolve=>relay.listen(8820,'127.0.0.1',resolve));
const origin='http://127.0.0.1:8820';
const drop=()=>{down=true;for(const socket of [...sockets])socket.destroy();};
const restore=()=>{down=false;};
const result={};
let browser;
try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error)));
  await page.goto(origin,{waitUntil:'networkidle'});
  const sendLabel=()=>page.evaluate(()=>document.getElementById('send').getAttribute('aria-label'));
  const idle=async(timeout=90000)=>{await page.waitForFunction(()=>document.getElementById('send').getAttribute('aria-label')==='Send',null,{timeout});await delay(400);};
  const send=async text=>{await page.fill('#prompt',text);await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('send').getAttribute('aria-label')!=='Send',null,{timeout:15000});};
  const chatId=()=>decodeURIComponent(new URL(page.url()).pathname.split('/').filter(Boolean).at(-1));
  const last=async()=>(await local('/v1/chats/'+encodeURIComponent(chatId()))).messages.at(-1);
  const newest=()=>page.evaluate(()=>document.getElementById('thread').lastElementChild?.textContent??'');
  const thread=()=>page.textContent('#thread');

  // A. Every part ends at the length limit until the fake model is told to finish.
  await mock('/__mock/config',{loaded:true,doneReason:'length',fillerTokens:60,tokenDelayMs:12,thinkingTokens:0});
  await send('Write a long answer');
  for(let i=0;i<800&&continues()<2;i++)await delay(25);
  assert(continues()>=2,'An answer cut at its length limit did not continue by itself');
  await mock('/__mock/config',{doneReason:null});
  await idle();
  const a=await last();
  assert.equal(a.role,'assistant');assert.equal(a.status,'complete','The continued answer did not finish: '+a.status);
  assert(a.content.includes('continued answer'),'The continuation was not appended to the same reply');
  assert(continues()<=7,'More parts than allowed');
  assert(!/relay dropped|connection closed/i.test(await thread()),'An error was shown on a reply that finished');
  result.cutAnswerFinishedAfterParts=continues();

  // B. An answer that never finishes stops after the allowed number of automatic parts.
  const b0=continues();
  await mock('/__mock/config',{doneReason:'length',fillerTokens:8,tokenDelayMs:2});
  await send('Write another long answer');await idle();
  assert.equal(continues()-b0,6,'Automatic continuation must stop after six parts');
  assert.equal((await last()).status,'length');
  result.automaticPartsBounded=continues()-b0;

  // C. The connection drops mid-reply and comes back.
  await mock('/__mock/config',{doneReason:null,thinkingTokens:120,fillerTokens:700,tokenDelayMs:20});
  const c0=continues();
  await send('Third question');await delay(2500);
  drop();
  await page.waitForFunction(()=>(document.getElementById('thread').lastElementChild?.textContent??'').includes('Connection lost'),null,{timeout:40000});
  await delay(2500);
  restore();
  await idle(150000);
  const c=await last();
  assert.equal(c.role,'assistant');assert.equal(c.status,'complete','The reply did not complete after the connection came back: '+c.status);
  assert(!/relay dropped|connection closed|Connection lost/i.test(await newest()),'The reply still shows a connection error: '+(await newest()).slice(-200));
  assert.equal(await sendLabel(),'Send');
  result.droppedReplyCompleted=true;result.continuedFromSavedCopy=continues()-c0;

  // D. Stop while the page is waiting for the connection.
  const d0=continues();
  await send('Fourth question');await delay(2500);
  drop();
  await page.waitForFunction(()=>(document.getElementById('thread').lastElementChild?.textContent??'').includes('Connection lost'),null,{timeout:40000});
  await page.click('#send');
  await idle(20000);
  restore();await delay(5000);
  assert.equal(continues(),d0,'Stop while waiting must not start a continuation');
  assert.equal(await sendLabel(),'Send');
  result.stopEndsTheWait=true;
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({passed:true,...result},null,2));
}finally{
  await browser?.close();for(const socket of [...sockets])socket.destroy();relay.close();await stack.stop();
}

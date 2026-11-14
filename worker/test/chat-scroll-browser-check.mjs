// Real-browser check that the conversation can be scrolled up and read while a
// reply is still thinking, and that following resumes at the bottom. Uses the local
// dev stack with the fake model and an already installed Playwright; no GPU or API calls.
// node test/chat-scroll-browser-check.mjs /path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startStack} from './dev-stack.mjs';

if(!process.argv[2])throw new Error('Pass the entry path of an already installed Playwright package.');
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const stack=await startStack({port:8817,mockPort:11517,state:'.test-state/chat-scroll'});
const mock=(route,body)=>fetch(stack.mock.url+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined).then(response=>response.json());
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.goto(stack.url,{waitUntil:'networkidle'});
  const reading=()=>page.evaluate(()=>{const el=document.getElementById('conversation');return {top:el.scrollTop,gap:el.scrollHeight-el.scrollTop-el.clientHeight,height:el.scrollHeight};});
  const send=async text=>{await page.fill('#prompt',text);await page.keyboard.press('Enter');};
  const idle=async()=>{for(let quiet=0,tries=0;quiet<4;tries++){assert(tries<400,'The fake model never finished its reply');await delay(250);quiet=(await mock('/__mock/stats')).active===0?quiet+1:0;}};

  // A long finished answer gives the conversation something to scroll back through.
  await mock('/__mock/config',{fillerTokens:1500,tokenDelayMs:0,thinkingTokens:0,loaded:true});
  await send('First question');await delay(1500);await idle();
  const settled=await reading();
  assert(settled.height>2400,'The first answer is too short to scroll: '+JSON.stringify(settled));

  // The second reply thinks for a long time; everything below happens while it streams.
  await mock('/__mock/config',{thinkingTokens:9000,tokenDelayMs:5,fillerTokens:50});
  await send('Second question');await delay(2500);
  assert.equal((await mock('/__mock/stats')).active,1,'The second reply is not streaming');
  const following=await reading();
  assert(following.gap<8,'The view does not follow a new reply: '+JSON.stringify(following));

  // Mouse wheel up: the view must stay where the reader put it.
  await page.mouse.move(640,300);await page.mouse.wheel(0,-600);await delay(2000);
  const wheeled=await reading();
  assert(wheeled.gap>400,'Wheel scroll-up snapped back to the bottom: '+JSON.stringify(wheeled));

  // A small upward move, as from a scrollbar drag or a touch, must hold as well.
  await page.evaluate(()=>{const el=document.getElementById('conversation');el.scrollTop=el.scrollHeight;});await delay(600);
  await page.evaluate(()=>{document.getElementById('conversation').scrollTop-=40;});await delay(2000);
  const nudged=await reading();
  assert(nudged.gap>=30,'A small scroll-up snapped back to the bottom: '+JSON.stringify(nudged));

  // Keyboard paging up holds too.
  // Focusing the scroller stands in for a click on message text, which would also
  // risk pressing a control in the reply under the pointer.
  await page.evaluate(()=>{const el=document.getElementById('conversation');el.scrollTop=el.scrollHeight;document.activeElement?.blur();el.tabIndex=-1;el.focus({preventScroll:true});});await delay(600);
  await page.keyboard.press('PageUp');await delay(2000);
  const paged=await reading();
  assert(paged.gap>200,'Page Up snapped back to the bottom: '+JSON.stringify(paged));

  // Returning to the bottom resumes following the reply.
  await page.evaluate(()=>{const el=document.getElementById('conversation');el.scrollTop=el.scrollHeight;});await delay(2000);
  const resumed=await reading();
  assert(resumed.gap<8,'Following did not resume at the bottom: '+JSON.stringify(resumed));
  assert.equal((await mock('/__mock/stats')).active,1,'The reply ended before the checks finished; they must run while it streams');
  console.log(JSON.stringify({passed:true,whileStreaming:true,wheelGap:wheeled.gap,smallMoveGap:nudged.gap,pageUpGap:paged.gap,resumedGap:resumed.gap},null,2));
}finally{
  await browser?.close();await stack.stop();
}

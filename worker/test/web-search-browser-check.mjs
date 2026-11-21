// Real-browser check of web search in the chat. Local dev stack with the fake model and a fake web
// (WEB_SEARCH_BASE / WEB_PAGE_REWRITE point at the mock), an already installed Playwright: no GPU, no
// hosted model, no real web request and never the live site.
//   A. Composer: the Web toggle sits next to Think, starts on, and is remembered on this device.
//   B. A reply that searches and reads shows what it is doing, then a Sources list under the answer
//      (http(s) links only, opening in a new tab without a referrer).
//   C. Web off: the turn says so and the model is offered no tools.
//   D. Phone width (390 px): nothing overflows sideways.
// node test/run-tests.mjs test/web-search-browser-check.mjs /path/to/playwright/index.mjs [screenshot-dir]
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {startStack} from './dev-stack.mjs';

if(!process.argv[2])throw new Error('Pass the entry path of an already installed Playwright package.');
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const shots=process.argv[3]?path.resolve(process.argv[3]):null;
const PORT=8862,MOCK_PORT=11562;
const stack=await startStack({port:PORT,mockPort:MOCK_PORT,state:'.test-state/web-search-browser',
  vars:{WEB_SEARCH_BASE:`http://127.0.0.1:${MOCK_PORT}/__web`,WEB_PAGE_REWRITE:`http://127.0.0.1:${MOCK_PORT}/__web/page`}});
const chats=()=>stack.mock.requests().filter(request=>request.path==='/api/chat').map(request=>request.body);
const result={};
let browser;
try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error)));
  const turns=[];page.on('request',request=>{if(request.method()==='POST'&&/\/v1\/chats\/[^/]+\/turn$/.test(new URL(request.url()).pathname))turns.push(JSON.parse(request.postData()));});
  await page.goto(stack.url,{waitUntil:'networkidle'});
  const idle=async(timeout=60000)=>{await page.waitForFunction(()=>document.getElementById('send').getAttribute('aria-label')==='Send',null,{timeout});await delay(300);};
  const send=async text=>{await page.fill('#prompt',text);await page.keyboard.press('Enter');await page.waitForFunction(()=>document.getElementById('send').getAttribute('aria-label')!=='Send',null,{timeout:15000});};
  const web=()=>page.evaluate(()=>{const button=document.getElementById('web');return {pressed:button.getAttribute('aria-pressed'),label:button.textContent.trim(),stored:localStorage.getItem('qwen.web'),afterThink:document.getElementById('think').nextElementSibling===button};});

  // A. The toggle: next to Think, on by default, remembered across a reload, back on again.
  assert.deepEqual(await web(),{pressed:'true',label:'Web',stored:null,afterThink:true});
  await page.click('#web');
  assert.deepEqual(await web(),{pressed:'false',label:'Web off',stored:'off',afterThink:true});
  await page.reload({waitUntil:'networkidle'});
  assert.equal((await web()).pressed,'false','Web off was not remembered on this device');
  await page.click('#web');
  assert.deepEqual(await web(),{pressed:'true',label:'Web',stored:null,afterThink:true});
  result.toggleRemembered=true;

  // B. Search, then read a page, slowly enough to see each step.
  stack.mock.configure({tokenDelayMs:5,webDelayMs:1200,toolRounds:[[{name:'web_search',arguments:{query:'browser check'}}],[{name:'open_page',arguments:{url:'https://news.test/article'}}]]});
  await send('What is new?');
  const liveText=()=>page.evaluate(()=>{const last=document.getElementById('thread').lastElementChild;return [last?.querySelector('.live-status')?.textContent??'',last?.querySelector('.thinking-summary')?.textContent??''].join(' | ');});
  const seen=new Set();
  for(let i=0;i<400&&!(seen.has('search')&&seen.has('read'));i++){
    const text=await liveText();
    if(text.includes('Searching the web for "browser check"'))seen.add('search');
    if(text.includes('Reading news.test'))seen.add('read');
    await delay(25);
  }
  assert(seen.has('search'),'The reply never said it was searching');
  assert(seen.has('read'),'The reply never said it was reading the page');
  await idle();
  assert.equal(turns.at(-1).web,true,'The turn did not ask for web tools');
  const sources=await page.evaluate(()=>{
    const list=document.getElementById('thread').lastElementChild.querySelector('.msg-sources');
    if(!list)return null;
    return {head:list.querySelector('.sources-head').textContent,links:[...list.querySelectorAll('a')].map(a=>({href:a.getAttribute('href'),target:a.target,rel:a.rel,title:a.querySelector('.source-title').textContent,host:a.querySelector('.source-host').textContent})),
      afterAnswer:list.previousElementSibling?.classList.contains('md'),beforeFooter:list.nextElementSibling?.classList.contains('msg-foot')};
  });
  assert(sources,'No Sources list under the answer');
  assert.equal(sources.head,'Sources'+'Searched “browser check”');
  assert.equal(sources.afterAnswer,true);assert.equal(sources.beforeFooter,true);
  assert.deepEqual(sources.links.map(link=>[link.href,link.title,link.host]),[
    ['https://news.test/article','Mock & Article','news.test · read'],
    ['https://news.test/article?q=browser%20check','News about browser check','news.test'],
    ['https://docs.test/reference','Reference & docs','docs.test'],
  ]);
  for(const link of sources.links){assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.match(link.href,/^https?:\/\//);}
  // A reload builds the same list from the saved message.
  await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.evaluate(()=>document.querySelectorAll('.msg-sources a').length),3,'Sources did not survive a reload');
  result.statusesShown=[...seen];result.sources=sources.links.length;

  // C. Web off for one turn: no tools reach the model.
  await page.click('#web');
  const before=chats().length;
  stack.mock.configure({webDelayMs:0});
  await send('Answer without the web');
  await idle();
  assert.equal(turns.at(-1).web,false);
  assert.equal(chats().length,before+1);
  assert.equal(chats().at(-1).tools,undefined,'Web off still offered tools');
  assert.equal(await page.evaluate(()=>document.getElementById('thread').lastElementChild.querySelector('.msg-sources')),null);
  await page.click('#web');
  result.webOffSendsNoTools=true;

  // D. Phone width: the composer chips and the Sources list fit without sideways scrolling.
  await page.setViewportSize({width:390,height:844});
  await page.reload({waitUntil:'networkidle'});
  await page.evaluate(()=>document.querySelector('.msg-sources')?.scrollIntoView({block:'center'}));
  await delay(300);
  const phone=await page.evaluate(()=>{
    const width=document.documentElement.clientWidth;
    const outside=[...document.querySelectorAll('.composer-bar > *, .msg-sources, .msg-sources a, .source-title')].filter(el=>el.offsetParent&&(el.getBoundingClientRect().right>width+0.5||el.getBoundingClientRect().left<-0.5)).map(el=>el.className||el.id);
    const web=document.getElementById('web').getBoundingClientRect(),send=document.getElementById('send').getBoundingClientRect();
    return {scrollWidth:document.documentElement.scrollWidth,width,outside,webVisible:web.width>0&&web.right<=send.left};
  });
  assert(phone.scrollWidth<=phone.width,`The page scrolls sideways at 390 px (${phone.scrollWidth} > ${phone.width})`);
  assert.deepEqual(phone.outside,[]);
  assert.equal(phone.webVisible,true,'The Web toggle is hidden or overlaps Send at 390 px');
  if(shots){await page.screenshot({path:path.join(shots,'web-390.png')});await page.setViewportSize({width:1280,height:800});await delay(200);await page.evaluate(()=>document.querySelector('.msg-sources')?.scrollIntoView({block:'center'}));await page.screenshot({path:path.join(shots,'web-1280.png')});}
  result.phoneFits=true;
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({passed:true,...result},null,2));
}finally{
  await browser?.close();await stack.stop();
}

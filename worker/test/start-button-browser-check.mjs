// Real-browser check of the Start button in Session (top right): it starts a Kaggle run like the
// card above the message box does. Local dev stack, fake model and fake Kaggle API, an already
// installed Playwright; no GPU, no Kaggle account and never the live site.
//   A. Session → Start → Kaggle sends POST /v1/server/start and Kaggle gets the run, at desktop and
//      at phone width (390 px, touch). On desktop the press moves a few pixels, as a real click often
//      does: the old link-styled button turned that into a link drag, so nothing started.
//   B. A server that stopped says why (here: idle) instead of "isn't running", and Start still works.
//   C. A notebook that checked in moments ago but whose tunnel doesn't answer shows "Reconnecting to
//      the notebook…" with no Start anywhere.
//   D. The sidebar shows the Kaggle GPU time left from Kaggle's own count, with its reset time.
// node test/run-tests.mjs test/start-button-browser-check.mjs /path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {RELAY_KEY,startStack} from './dev-stack.mjs';
import {KAGGLE_TOKEN} from './mock-ollama.mjs';

if(!process.argv[2])throw new Error('Pass the entry path of an already installed Playwright package.');
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const stack=await startStack({port:8854,mockPort:11554,state:'.test-state/start-button',register:false,
  vars:{KAGGLE_API_TOKEN:KAGGLE_TOKEN,KAGGLE_API_BASE:'http://127.0.0.1:11554',KAGGLE_CACHE_DATASET:'',KAGGLE_CACHE_ID:''}});
const relay=(route,body,method='POST')=>fetch(stack.url+route,{method,headers:{'x-relay-key':RELAY_KEY,'content-type':'application/json'},body:body&&JSON.stringify(body)});
const reset=async()=>{
  await stack.sql("DELETE FROM state WHERE k IN ('launch','launches','boot','server_idle','server_stop','kaggle_run_check','target')");
  stack.mock.setDown(false);
};
const result={};
let browser;
try{
  browser=await chromium.launch({headless:true});
  const open=async({width,touch})=>{
    const context=await browser.newContext({viewport:{width,height:touch?844:860},isMobile:touch,hasTouch:touch});
    const page=await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const starts=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/v1/server/start'))starts.push(request.url());});
    await page.goto(stack.url,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>document.getElementById('status-label').textContent!=='Checking');
    return {page,context,errors,starts,press:selector=>touch?page.tap(selector):page.click(selector)};
  };
  const startFromSession=async({width,touch})=>{
    await reset();
    const pushes=stack.mock.kagglePushes().length;
    const {page,context,errors,starts,press}=await open({width,touch});
    await press('#session-toggle');
    await page.waitForSelector('#colab-link[data-mode="start"]',{state:'visible'});
    const link=await page.evaluate(()=>{const a=document.getElementById('colab-link');return {text:a.textContent.trim(),role:a.getAttribute('role'),href:a.getAttribute('href'),draggable:a.draggable};});
    assert.deepEqual(link,{text:'Start',role:'button',href:null,draggable:false},'Session Start is a button');
    if(touch)await press('#colab-link');
    else{
      // A press that drifts 6 px before release, as a hand on a mouse or trackpad often does.
      const box=await page.locator('#colab-link').boundingBox();const x=box.x+box.width/2,y=box.y+box.height/2;
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+6,y+2,{steps:4});await page.mouse.up();
    }
    await page.waitForSelector('.host-popover [data-host="kaggle"]:not([disabled])',{state:'visible',timeout:5000});
    await press('.host-popover [data-host="kaggle"]');
    await page.waitForFunction(()=>document.getElementById('banner').textContent.includes('Starting on Kaggle'),null,{timeout:15000});
    assert.equal(starts.length,1,'one POST /v1/server/start');
    assert.equal(stack.mock.kagglePushes().length-pushes,1,'Kaggle got one run');
    assert.equal(await page.isVisible('#session-rail'),false,'Session closes so the start-up card shows');
    assert.deepEqual(errors,[]);
    await context.close();
    return {posted:starts.length,pushed:1};
  };
  result.desktop=await startFromSession({width:1280,touch:false});
  result.phone=await startFromSession({width:390,touch:true});

  // B. The last server shut itself down after 45 minutes unused.
  await reset();
  assert.equal((await relay('/_relay/register',{target:stack.mock.url,host:'kaggle',num_ctx:65536,control:true})).status,200);
  assert.equal((await relay('/_relay/unregister',{target:stack.mock.url,reason:'idle',detail:'Nobody used it for 45 minutes',uptime_s:5400,idle_minutes:45})).status,200);
  {
    const {page,context,errors}=await open({width:1280,touch:false});
    const card=await page.locator('#banner').innerText();
    assert(card.includes('The server shut down after 45 minutes unused.'),card);
    assert(!card.includes("isn't running"),card);
    assert.equal(await page.locator('#banner .banner-action').innerText(),'Start server');
    assert((await page.locator('#status-detail').textContent()).includes('shut down when idle'));
    result.stopReason=card.split('\n')[0];
    // D. Kaggle's own count of GPU time left, with the reset in this browser's time.
    const meter=await page.locator('#meters .meter').first().innerText();
    assert.match(meter,/Kaggle GPU left/);assert.match(meter,/\d+ h( \d+ min)? of 30 h/);assert.match(meter,/resets \S+ \d{1,2} \S+, \d\d:\d\d/);
    result.meter=meter.replace(/\s+/g,' ');
    assert.deepEqual(errors,[]);
    await context.close();
  }

  // C. The notebook checked in moments ago but its tunnel doesn't answer: reconnecting, no Start.
  await reset();
  assert.equal((await relay('/_relay/register',{target:stack.mock.url,host:'kaggle',num_ctx:65536,control:true})).status,200);
  await relay(`/_relay/command?target=${encodeURIComponent(stack.mock.url)}&idle=20&tunnel=reconnecting`,undefined,'GET');
  stack.mock.setDown(true);
  for(const viewport of [{width:1280,touch:false},{width:390,touch:true}]){
    const {page,context,errors,press}=await open(viewport);
    await page.waitForFunction(()=>document.getElementById('banner').textContent.includes('Reconnecting to the notebook'));
    assert.equal(await page.locator('#banner button',{hasText:'Start'}).count(),0,'no Start on the card');
    assert.equal(await page.locator('#status-label').textContent(),'Reconnecting');
    await press('#session-toggle');
    assert.notEqual((await page.locator('#colab-link').innerText()).trim(),'Start','no Start in Session');
    assert.deepEqual(errors,[]);
    await context.close();
  }
  result.reconnecting='no Start at 1280 and 390 px';
  console.log(JSON.stringify({passed:true,...result},null,2));
}finally{
  await browser?.close();await stack.stop();
}

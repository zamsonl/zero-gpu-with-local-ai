// Real DOM regression/performance check. Uses an already installed Playwright;
// no downloads, model calls, credentials or changes to the user's browser.
// node worker/test/thread-scroll-browser-check.mjs /path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startPreview} from './thread-stream-preview.mjs';

if(!process.argv[2])throw new Error('Pass the entry path of an already installed Playwright package.');
const {chromium}=await import(pathToFileURL(path.resolve(process.argv[2])).href);
const preview=await startPreview({port:0});
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1080,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(preview.url);await page.waitForFunction(()=>!!window.fixture);
  await page.evaluate(()=>window.fixture.large());
  await page.waitForFunction(()=>window.fixture.snapshot().renderedThinkingChars>10000);
  const body=page.locator('.thinking-body');
  await body.hover();await page.mouse.wheel(0,-450);
  await page.waitForFunction(()=>window.fixture.snapshot().jumpLatestVisible);
  const paused=await page.evaluate(()=>({text:window.fixture.view.thinkingBody.textContent,top:window.fixture.view.thinkingBody.scrollTop,start:window.fixture.snapshot().traceStart}));
  const whileStreaming=await page.evaluate(async()=>{
    const view=window.fixture.view;let mutations=0;
    const observer=new MutationObserver(records=>mutations+=records.length);
    observer.observe(view.thinkingBody,{subtree:true,characterData:true,childList:true});
    for(let n=0;n<40;n++){view.appendThinking('\n\nLIVE_AFTER_PAUSE_'+n);await new Promise(requestAnimationFrame);}
    observer.disconnect();return {mutations,text:view.thinkingBody.textContent,top:view.thinkingBody.scrollTop,start:window.fixture.snapshot().traceStart,source:view.thinking};
  });
  assert.equal(whileStreaming.mutations,0);assert.equal(whileStreaming.text,paused.text);
  assert.equal(whileStreaming.start,paused.start);assert(Math.abs(whileStreaming.top-paused.top)<1);
  assert(whileStreaming.source.endsWith('LIVE_AFTER_PAUSE_39'));
  await page.getByRole('button',{name:'Read reasoning from the beginning',exact:true}).click();
  await page.waitForFunction(()=>window.fixture.snapshot().traceStart===0);
  assert((await body.textContent()).startsWith('BEGINNING_MARKER'));
  const firstEnd=await page.evaluate(()=>window.fixture.snapshot().traceEnd);
  await page.getByRole('button',{name:'Read the next reasoning section',exact:true}).click();
  await page.waitForFunction(end=>window.fixture.snapshot().traceStart===end,firstEnd);
  await page.getByRole('button',{name:'Jump to latest reasoning and follow new text',exact:true}).click();
  await page.waitForFunction(()=>!window.fixture.snapshot().jumpLatestVisible);
  assert((await body.textContent()).includes('LIVE_AFTER_PAUSE_39'));
  await page.evaluate(()=>{const view=window.fixture.view;view.thinkingFirst.click();});
  await page.waitForFunction(()=>window.fixture.snapshot().traceStart===0);
  const beforeAnswer=await body.textContent();
  await page.evaluate(()=>{const view=window.fixture.view;view.appendContent('The answer is streaming.');});
  await page.waitForFunction(()=>window.fixture.view.body.textContent.trim()==='The answer is streaming.');
  assert.equal(await body.textContent(),beforeAnswer);assert.equal(await page.locator('.thinking').evaluate(el=>el.open),true);
  const performanceResult=await page.evaluate(()=>window.fixture.stress({frames:240,pauseAt:60,characters:96}));
  assert.equal(performanceResult.readerTextStable,true);assert.equal(performanceResult.readerScrollStable,true);
  assert.equal(performanceResult.pausedMutations,0);
  const final=await page.evaluate(()=>window.fixture.snapshot());
  assert(final.renderedThinkingChars<=24002);assert(final.renderedThinkingNodes<=200);
  assert(performanceResult.p95CallbackMs<20,JSON.stringify(performanceResult));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,scrollPositionHeld:true,earlierTraceReachable:true,sourceCharacters:final.thinkingChars,renderedCharacters:final.renderedThinkingChars,renderedNodes:final.renderedThinkingNodes,...performanceResult},null,2));
}finally{await browser?.close();await preview.close();}

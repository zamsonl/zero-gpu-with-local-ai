// Real Chromium check for a buffered network burst passing through the actual
// API parser and AssistantView. Uses installed Playwright; no model/API calls.
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
  const result=await page.evaluate(async()=>{
    const {api}=await import('/js/api.js');
    const {AssistantView}=await import('/js/thread.js');
    const total=120000,parts=Array.from({length:total},(_,n)=>'arrival '+n+' 😀\n\n');
    const bytes=new TextEncoder().encode(parts.map(text=>JSON.stringify({event:'thinking',text})).join('\n')+'\n');
    async function burst(stop=false){
      const view=new AssistantView({actions:{}},null,{isLast:true});
      document.getElementById('thread').replaceChildren(view.el);view.startLive();
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const originalFetch=window.fetch,abort=new AbortController();
      let cancelled=false;
      window.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(bytes);if(!stop)controller.close();},cancel(){cancelled=true;}}));
      let received=0,draining=true,frames=0,partialPaints=0,firstPaintMs=null,lastFrame=performance.now(),maxFrameGapMs=0,errorName=null;
      const started=performance.now();
      const observe=()=>{
        const now=performance.now();maxFrameGapMs=Math.max(maxFrameGapMs,now-lastFrame);lastFrame=now;frames++;
        if(received>0&&received<total&&view.thinkingBody?.textContent.length){partialPaints++;firstPaintMs??=now-started;}
        if(draining)requestAnimationFrame(observe);
      };
      const stopTimer=stop?setTimeout(()=>abort.abort(),30):null;
      try{for await(const event of api.turn('local-fixture',{text:'fixture'},abort.signal)){view.appendThinking(event.text);received++;if(received===1)requestAnimationFrame(observe);}}
      catch(error){errorName=error.name;}
      finally{clearTimeout(stopTimer);draining=false;window.fetch=originalFetch;view.markStopped();}
      await new Promise(requestAnimationFrame);
      return {received,total,frames,partialPaints,firstPaintMs,maxFrameGapMs,elapsedMs:performance.now()-started,exactSource:view.thinking===parts.slice(0,received).join(''),renderedCharacters:view.thinkingBody.textContent.length,renderedNodes:view.thinkingBody.childElementCount,cancelled,errorName};
    }
    return {complete:await burst(),stopped:await burst(true)};
  });
  console.log(JSON.stringify(result,null,2));
  assert.equal(result.complete.received,result.complete.total);assert.equal(result.complete.exactSource,true);assert.equal(result.complete.errorName,null);
  assert(result.complete.partialPaints>0,'A buffered NDJSON burst must paint real partial output before the entire burst drains.');
  for(const run of Object.values(result)){assert(run.renderedCharacters<=24002);assert(run.renderedNodes<=200);assert.equal(run.exactSource,true);}
  assert(result.stopped.received>0&&result.stopped.received<result.stopped.total,'Stop must interrupt the buffered burst.');
  assert.equal(result.stopped.errorName,'AbortError');assert.equal(result.stopped.cancelled,true);
  assert.deepEqual(errors,[]);
}finally{await browser?.close();await preview.close();}

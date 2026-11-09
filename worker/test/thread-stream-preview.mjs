// Local browser fixture for the real AssistantView. No model, Worker, credentials,
// or external network: node test/thread-stream-preview.mjs --port 8869
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const publicDir=path.resolve(fileURLToPath(new URL('../public/',import.meta.url)));
const page=String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local streaming view fixture</title><link rel="stylesheet" href="/app.css">
<style>body{display:block;overflow:auto;padding:24px;background:var(--bg);color:var(--label)}main{max-width:900px;margin:auto}nav{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}#reading{font:13px monospace;white-space:pre-wrap;margin:12px 0}.msg{margin-top:24px}button{cursor:pointer}</style>
</head><body><main><h1>Local streaming view fixture</h1>
<p>Real production view, synthetic small chunks every 180 ms. No GPU or API calls.</p>
<nav><button id="run" class="button">Run slow reply</button><button id="stop" class="button">Stop</button><button id="continue" class="button">Continue</button><button id="retry" class="button">Show recovery</button><button id="large" class="button">Large live trace</button><button id="stress" class="button">Stress live scrolling</button><button id="theme" class="button">Toggle theme</button></nav>
<div id="reading" role="status"></div><div id="thread"></div></main>
<nav aria-label="Recovery stages"><button id="summarize" class="button">Summarizing thinking</button><button id="connection-retry" class="button">Retry during summary</button><button id="resume-work" class="button">Continuing from saved work</button><button id="summary-fallback" class="button">Preserve original thought</button><button id="finish-work" class="button">Write answer from preserved thought</button></nav>
<script type="module">
import {AssistantView} from '/js/thread.js';
import {phaseStatus,withTransportProgress} from '/js/progress-status.js';
import {prefs,apply} from '/js/prefs.js';
prefs.set({reasoningOpen:true});apply();
let view=null,timer=0,index=0,running=false,phase='idle',writes=0,measurement=null,measuring=null;
const nativeFrame=window.requestAnimationFrame.bind(window);
window.requestAnimationFrame=callback=>nativeFrame(time=>{const start=performance.now();try{callback(time);}finally{if(measuring)measuring.push(performance.now()-start);}});
const chunks=[...('I am checking the first small reasoning chunk.\n\nThen I keep the existing reasoning while output arrives.\n\n').match(/.{1,5}|\n/g),null,...('A partial answer should become visible immediately. It keeps growing while this local fixture runs.').match(/.{1,5}/g)];
const reading=document.getElementById('reading');
function snapshot(){return {phase,index,writes,thinkingChars:view?.thinking.length||0,renderedThinkingChars:view?.thinkingBody?.textContent.length||0,renderedThinkingNodes:view?.thinkingBody?.childElementCount||0,traceStart:Number(view?.thinkingBody?.dataset.traceStart||0),traceEnd:Number(view?.thinkingBody?.dataset.traceEnd||0),scrollTop:view?.thinkingBody?.scrollTop||0,jumpLatestVisible:view?.thinkingLatest?!view.thinkingLatest.hidden:false,content:view?.content||'',visibleContent:view?.body.textContent||'',recovery:view?.liveEl?.textContent||'',windowNoteVisible:view?.thinkingWindowNote?!view.thinkingWindowNote.hidden:false,measurement};}
function update(){reading.textContent=JSON.stringify(snapshot(),null,2);}
function pause(){clearTimeout(timer);timer=0;running=false;}
function message(status){return {id:1,role:'assistant',thinking:view.thinking,content:view.content,status,stats:null};}
function make(){pause();view?.markStopped();view=new AssistantView({actions:{onContinue:()=>resume(),onRegenerate:()=>start()}},null,{isLast:true});document.getElementById('thread').replaceChildren(view.el);view.startLive();index=0;writes=0;}
function tick(){if(!running)return;if(index===chunks.length){pause();phase='complete';view.finish(message('stop'));requestAnimationFrame(update);return;}const chunk=chunks[index++];if(chunk===null)phase='answer';else{writes++;if(phase==='reasoning')view.appendThinking(chunk);else view.appendContent(chunk);}requestAnimationFrame(update);timer=setTimeout(tick,180);}
function start(){make();phase='reasoning';running=true;view.setStatus({state:'waiting',detail:''});timer=setTimeout(tick,1200);update();}
function stop(){if(!view)return;pause();phase='stopped';view.finish(message('stopped'));update();}
function resume(){if(!view||running||index>=chunks.length)return;view.resume({thinking:!view.content});phase=view.content?'answer':'reasoning';running=true;tick();}
function retry(){if(!view)return;pause();phase='retrying';view.sync({thinking:view.thinking,content:view.content,state:'retrying',detail:'Retrying the same model job'});update();}
function large(){make();phase='reasoning';view.appendThinking('BEGINNING_MARKER\n\n'+('A preserved reasoning paragraph.\n\n').repeat(10000)+'END_MARKER');requestAnimationFrame(update);}
async function stress({frames=180,pauseAt=50,characters=96}={}){
  make();phase='stress';running=true;measurement=null;
  view.appendThinking('BEGINNING_MARKER\n\n'+('A preserved reasoning paragraph.\n\n').repeat(30000)+'INITIAL_TAIL');
  const frame=()=>new Promise(resolve=>nativeFrame(resolve));await frame();await frame();
  let frozen=null,pausedMutations=0;const durations=[];measuring=durations;
  const observer=new MutationObserver(records=>{if(frozen)pausedMutations+=records.length;});observer.observe(view.thinkingBody,{subtree:true,childList:true,characterData:true});
  const started=performance.now();
  for(let n=0;n<frames&&running;n++){
    if(n===pauseAt){view.thinkingBody.scrollTop=100;view.thinkingBody.dispatchEvent(new Event('scroll'));frozen={text:view.thinkingBody.textContent,top:view.thinkingBody.scrollTop};}
    view.appendThinking('\n\nSTREAM_'+n+' '+'.'.repeat(characters));writes++;await frame();
  }
  await frame();measuring=null;observer.disconnect();running=false;phase='stress complete';
  const ordered=durations.toSorted((a,b)=>a-b);
  measurement={frames:writes,elapsedMs:performance.now()-started,callbacks:durations.length,p95CallbackMs:ordered[Math.floor(ordered.length*.95)]||0,maxCallbackMs:Math.max(0,...durations),pausedMutations,readerTextStable:frozen?view.thinkingBody.textContent===frozen.text:null,readerScrollStable:frozen?view.thinkingBody.scrollTop===frozen.top:null};update();return measurement;
}
document.getElementById('run').onclick=start;document.getElementById('stop').onclick=stop;document.getElementById('continue').onclick=resume;document.getElementById('retry').onclick=retry;document.getElementById('large').onclick=large;
document.getElementById('stress').onclick=()=>stress();
document.getElementById('theme').onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';};
window.fixture={start,stop,resume,retry,large,stress,snapshot,get view(){return view;}};update();
function recoveryStage(stage,transport=null){make();view.appendThinking('Synthetic saved thinking. The corrected port is 8247; this original source stays available.');const status=phaseStatus('reasoning_recovery',stage,{chunk:2,chunks:5,...(stage==='finishing'?{finish_reason:'summary_fallback'}:{})});view.setStatus(transport?withTransportProgress(status,transport):status);phase=stage;requestAnimationFrame(update);}
document.getElementById('summarize').onclick=()=>recoveryStage('extracting',{state:'connecting',detail:'Waiting for the model server to answer',attempt:1});
document.getElementById('connection-retry').onclick=()=>recoveryStage('extracting',{state:'retrying',detail:'Connection interrupted; retrying in 5 s',attempt:2});
document.getElementById('resume-work').onclick=()=>recoveryStage('resuming');
document.getElementById('summary-fallback').onclick=()=>recoveryStage('fallback');
document.getElementById('finish-work').onclick=()=>recoveryStage('finishing');
</script></body></html>`;

export async function startPreview({port=8869}={}){
  const server=http.createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://127.0.0.1').pathname;
      if(pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page);return;}
      const filename=path.resolve(publicDir,'.'+decodeURIComponent(pathname));
      if(!filename.startsWith(publicDir+path.sep)){res.writeHead(403).end();return;}
      const types={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
      const data=await fs.readFile(filename);res.writeHead(200,{'content-type':types[path.extname(filename)]||'application/octet-stream','cache-control':'no-store'});res.end(data);
    }catch(error){res.writeHead(error.code==='ENOENT'?404:400).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
if(import.meta.main){
  const {values}=parseArgs({options:{port:{type:'string',default:'8869'}}});
  const preview=await startPreview({port:Number(values.port)});console.log('READY '+preview.url);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>preview.close().then(()=>process.exit(0)));
}

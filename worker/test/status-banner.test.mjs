import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {BOOT_STEPS,STAGES,activeBoot,describe} from '../public/js/server-status.js';

// Exercise the real status view and its controls without creating a server or
// performing inference. The existing conversation/composer are separate DOM nodes.
const source=(await fs.readFile(new URL('../public/js/status-ui.js',import.meta.url),'utf8')).replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.attributes={};this.dataset={};this.listeners={};this.hidden=false;this.disabled=false;this.className='';this.ownText='';this.style={setProperty(){}};this.classList={contains:name=>this.className.split(' ').includes(name),toggle:(name,on)=>{const values=this.className.split(' ').filter(value=>value&&value!==name);if(on)values.push(name);this.className=values.join(' ');}};}
  set textContent(value){this.ownText=String(value);this.children=[];}get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
  append(...items){for(let item of items.flat(Infinity).filter(item=>item!=null&&item!==false)){if(typeof item!=='object'){const text=new Element('#text');text.textContent=item;item=text;}item.parentElement=this;this.children.push(item);}}
  prepend(...items){const old=this.children;this.children=[];this.append(...items,...old);}
  replaceChildren(...items){this.children=[];this.ownText='';this.append(...items);}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='hidden')this.hidden=true;if(name==='disabled')this.disabled=true;}
  getAttribute(name){return this.attributes[name]??null;}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  async fire(name,event={}){await Promise.all((this.listeners[name]??[]).map(fn=>fn({preventDefault(){},...event})));}
  focus(){this.document.activeElement=this;}
  querySelectorAll(selector){const matches=node=>selector==='button'?node.tagName==='BUTTON':selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1).split(':')[0])&&(!selector.includes(':not([disabled])')||!node.disabled):selector==='[role="menuitem"]:not([disabled])'?node.getAttribute('role')==='menuitem'&&!node.disabled:false;return this.children.flatMap(child=>[...(matches(child)?[child]:[]),...child.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
}

function fixture({storage=new Map(),storageBlocked=false,initial={server:'offline',host:'kaggle',can_start:true},wait={startedAt:Date.now(),stage:'offline'}}={}){
  const nodes=new Map(),doc={activeElement:null,getElementById:id=>nodes.get(id)??null};
  const h=(tag,props={},...children)=>{const el=new Element(tag);el.document=doc;for(const[key,value]of Object.entries(props)){if(value==null||value===false)continue;if(key==='class')el.className=value;else if(key==='text')el.textContent=value;else if(key==='dataset')Object.assign(el.dataset,value);else if(key.startsWith('on'))el.addEventListener(key.slice(2),value);else el.setAttribute(key,value===true?'':value);}el.append(...children);return el;};
  for(const id of ['status-pill','status-label','status-detail','colab-link','banner','server','session-toggle','conversation','prompt'])nodes.set(id,h(id.includes('pill')||id.includes('toggle')?'button':'div'));
  nodes.get('colab-link').append(h('span',{class:'colab-label'}));nodes.get('server').append(nodes.get('status-pill'),nodes.get('colab-link'));
  nodes.get('conversation').textContent='An earlier saved conversation remains readable.';nodes.get('conversation').scrollTop=175;nodes.get('prompt').value='Unsent draft for this chat';
  const status=new EventTarget();Object.assign(status,{status:initial,wait,busyElsewhere:null,restartWait(){this.dispatchEvent(new Event('change'));},async refresh(){}});
  let popover=null,opened=[],logs=0,stoppedLogs=0,shown=0;
  const store={getItem:key=>{if(storageBlocked)throw Error('blocked');return storage.get(key)??null;},setItem:(key,value)=>{if(storageBlocked)throw Error('blocked');storage.set(key,value);},removeItem:key=>{if(storageBlocked)throw Error('blocked');storage.delete(key);}};
  const env={h,icon:()=>h('svg'),isTouch:()=>false,closePopover(){popover=null;},openPopover(_anchor,panel){popover=panel;return panel;},BOOT_STEPS,STAGES,activeBoot,describe,openServerLog(){},createStartupLog(){logs++;return {element:h('pre',{text:'Real notebook log fixture'}),stop(){stoppedLogs++;}};},clock:()=>'',timeAgo:()=>'',document:doc,localStorage:{getItem:()=>null,setItem(){}},sessionStorage:store,window:{open:url=>opened.push(url)},setInterval(){},requestAnimationFrame:callback=>callback()};
  const StatusView=new Function('env','with(env){'+source+';return StatusView;}')(env);
  const view=new StatusView(status);view.onShowBanner=()=>{shown++;};view.setLaunchUrls({kaggle:'https://www.kaggle.com/code/example/qwen',colab:'https://colab.research.google.com/example'});view.render();
  return {view,status,nodes,storage,doc,get popover(){return popover;},get opened(){return opened;},get logs(){return logs;},get stoppedLogs(){return stoppedLogs;},get shown(){return shown;},change(value){status.status=value;status.dispatchEvent(new Event('change'));},dismiss:()=>nodes.get('banner').querySelector('.banner-dismiss'),restore:()=>nodes.get('server').querySelector('.server-status-restore')};
}
const boot=(stage,at='2026-11-08T02:00:00Z')=>({server:'offline',host:'kaggle',can_start:true,boot:{host:'kaggle',stage,at,detail:stage==='failed'?'The notebook could not start.':'Notebook-reported progress'}});

test('hiding the offline card preserves old messages, scroll position and the unsent prompt',async()=>{
  const f=fixture();const conversation=f.nodes.get('conversation'),prompt=f.nodes.get('prompt');const text=conversation.textContent;
  assert.equal(f.nodes.get('banner').hidden,false);assert(f.dismiss(),'Offline card needs a hide control');
  assert.equal(f.dismiss().getAttribute('aria-label'),'Hide server status');assert.equal(f.dismiss().getAttribute('aria-controls'),'banner');
  await f.dismiss().fire('click');assert.equal(f.nodes.get('banner').hidden,true);assert.equal(f.nodes.get('banner').children.length,0);
  assert.equal(conversation.textContent,text);assert.equal(conversation.scrollTop,175);assert.equal(prompt.value,'Unsent draft for this chat');
  assert.equal(f.doc.activeElement,f.nodes.get('session-toggle'));assert.equal(f.restore().hidden,false);assert.equal(f.restore().textContent,'Show startup status');
  assert.equal(f.nodes.get('colab-link').querySelector('.colab-label').textContent,'Start','Session Start must stay available');
});

test('dismissal survives chat/status rerenders and refresh in the same tab without hiding saved chats',async()=>{
  const f=fixture();await f.dismiss().fire('click');
  f.change({server:'unregistered',host:'kaggle',can_start:true});f.change(boot('loading'));assert(f.nodes.get('banner').hidden);assert.equal(f.logs,0);
  const refreshed=fixture({storage:f.storage,initial:boot('loading')});assert(refreshed.nodes.get('banner').hidden);assert.equal(refreshed.restore().hidden,false);assert.equal(refreshed.logs,0);
  refreshed.change({server:'ready',host:'kaggle',num_ctx:98304});assert(refreshed.nodes.get('banner').hidden);assert(refreshed.restore().hidden);
  refreshed.change({server:'offline',host:'kaggle',can_start:true});assert(refreshed.nodes.get('banner').hidden);assert(!refreshed.restore().hidden);
});

test('Session can restore the startup card without launching a notebook',async()=>{
  const f=fixture();let starts=0;f.view.onStart=async()=>{starts++;};await f.dismiss().fire('click');
  await f.restore().fire('click');assert.equal(f.nodes.get('banner').hidden,false);assert.equal(f.restore().hidden,true);assert.equal(starts,0);assert.equal(f.shown,1);
  assert.equal(f.doc.activeElement,f.dismiss());
});

test('an intentional Kaggle start reveals actual queued and loading progress after dismissal',async()=>{
  const f=fixture();let starts=0;f.view.onStart=async()=>{starts++;f.change(boot('queued'));};await f.dismiss().fire('click');
  await f.nodes.get('colab-link').fire('click');assert(f.popover);assert(f.nodes.get('banner').hidden,'Merely opening the host chooser should not override dismissal');
  const kaggle=f.popover.querySelectorAll('.host-option').find(node=>node.dataset.host==='kaggle');await kaggle.fire('click');
  assert.equal(starts,1);assert.equal(f.nodes.get('banner').hidden,false);assert(f.nodes.get('banner').textContent.includes('Starting on Kaggle'));assert(f.nodes.get('banner').textContent.includes('Waiting for Kaggle to assign two GPUs'));
  f.change(boot('loading'));assert.equal(f.nodes.get('banner').hidden,false);assert(f.nodes.get('banner').textContent.includes('Loading the model onto the GPUs'));
  assert(f.logs>=1);assert(f.shown>=1);
});

test('an intentional Colab launch reveals its instructions without starting a Kaggle notebook',async()=>{
  const f=fixture();let starts=0;f.view.onStart=async()=>{starts++;};await f.dismiss().fire('click');await f.nodes.get('colab-link').fire('click');
  const colab=f.popover.querySelectorAll('.host-option').find(node=>node.dataset.host==='colab');await colab.fire('click');
  assert.equal(starts,0);assert.deepEqual(f.opened,['https://colab.research.google.com/example']);assert.equal(f.nodes.get('banner').hidden,false);assert(f.nodes.get('banner').textContent.includes('Waiting for the Colab notebook'));
});

test('hiding startup stops its inline log feed; showing it resumes the current reported log',async()=>{
  const f=fixture({initial:boot('loading')});assert.equal(f.logs,1);await f.dismiss().fire('click');assert.equal(f.stoppedLogs,1);f.view.render();assert.equal(f.logs,1);
  await f.restore().fire('click');assert.equal(f.logs,2);assert(f.nodes.get('banner').textContent.includes('Real notebook log fixture'));
});

test('a new startup failure remains visible but dismissing the same failure is respected',async()=>{
  const f=fixture();await f.dismiss().fire('click');f.change(boot('failed'));assert.equal(f.nodes.get('banner').hidden,false);assert(f.nodes.get('banner').textContent.includes('The Kaggle notebook stopped'));
  await f.dismiss().fire('click');f.view.render();assert(f.nodes.get('banner').hidden);
  const refreshed=fixture({storage:f.storage,initial:boot('failed')});assert(refreshed.nodes.get('banner').hidden);
  refreshed.change(boot('failed','2026-11-08T03:00:00Z'));assert.equal(refreshed.nodes.get('banner').hidden,false);
});

test('blocked tab storage does not prevent hiding/restoring or change server controls',async()=>{
  const f=fixture({storageBlocked:true});await f.dismiss().fire('click');assert(f.nodes.get('banner').hidden);assert.equal(f.nodes.get('colab-link').dataset.mode,'start');await f.restore().fire('click');assert(!f.nodes.get('banner').hidden);
});

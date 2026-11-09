import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
class Element {
  constructor(){this.value='';this.children=[];this.textContent='';this.disabled=false;this.hidden=false;this.scrollTop=0;this.scrollHeight=100;this.clientHeight=100;}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=[...nodes];}
}
async function harness(initial={session_id:'A',folder:'owned',busy:false,phase:'Ready',pending:null,events:[]}){
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let state=initial,heldState=null,heldTask=null,taskPosts=0;
  const reply=value=>({ok:true,json:async()=>value});
  const api=async(url,options)=>{
    if(url==='/api/state'){if(heldState){const hold=heldState;heldState=null;return hold.promise;}return reply(state);}
    if(url.startsWith('/api/files'))return reply([]);
    if(url==='/api/task'){taskPosts++;if(heldTask)return heldTask.promise;return reply({ok:true});}
    if(url==='/api/reset'){state={...state,session_id:'B',events:[]};return reply({ok:true});}
    throw new Error('Unexpected mock route '+url);
  };
  const run=new (Object.getPrototypeOf(async function(){}).constructor)('document','location','sessionStorage','history','fetch','setInterval','setTimeout',source+'\nreturn {refresh};');
  const controls=await run({getElementById:element,createElement:()=>new Element(),hidden:true},{port:'1234',hash:'#synthetic-token',pathname:'/'},{getItem:()=>null,setItem:()=>{}},{replaceState:()=>{}},api,()=>0,()=>0);
  return {element,controls,reply,setState:v=>state=v,holdState:()=>heldState=deferred(),holdTask:()=>heldTask=deferred(),get taskPosts(){return taskPosts;}};
}
test('accepted task preserves a newer draft and duplicate Send is blocked immediately',async()=>{
  const ui=await harness();const task=ui.holdTask();ui.element('task').value='Original task';
  const first=ui.element('task-form').onsubmit({preventDefault(){}});await Promise.resolve();
  ui.element('task').value='New draft typed while waiting';const second=ui.element('task-form').onsubmit({preventDefault(){}});await Promise.resolve();
  task.resolve(ui.reply({ok:true}));await Promise.all([first,second]);
  assert.equal(ui.taskPosts,1);assert.equal(ui.element('task').value,'New draft typed while waiting');
});
test('a pre-reset poll cannot restore activity from the previous session',async()=>{
  const old={session_id:'A',folder:'owned',busy:false,phase:'Ready',pending:null,events:[{id:1,kind:'user',text:'OLD SESSION'}]};
  const ui=await harness(old);const poll=ui.holdState();const pending=ui.controls.refresh();await Promise.resolve();
  await ui.element('new').onclick();poll.resolve(ui.reply(old));await pending;
  ui.setState({...old,session_id:'B',events:[{id:2,kind:'user',text:'NEW SESSION'}]});await ui.controls.refresh();
  const text=JSON.stringify(ui.element('events').children);
  assert(!text.includes('OLD SESSION'));assert(text.includes('NEW SESSION'));
});

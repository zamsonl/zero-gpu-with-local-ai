import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'node:test';
import {badRequest,readJsonObject} from '../src/http.js';

// Exercise the real continuation parser and its call site before any DB lookup,
// generation lock, or model invocation. No server, credentials, or GPU is used.
const source=(await fs.readFile(new URL('../src/continue.js',import.meta.url),'utf8'))
  .replace(/^import[^\n]*;\r?\n/gm,'').replace(/^export /gm,'');
function fixture(){
  const calls={lookup:0,lock:0,generation:0};
  const deps={badRequest,readJsonObject,settings:()=>({}),
    requireChat:async()=>{calls.lookup++;throw Error('Unexpected database lookup');},
    GenerationLock:{acquire:async()=>{calls.lock++;throw Error('Unexpected lock');}},
    startGeneration:()=>{calls.generation++;throw Error('Unexpected inference');}};
  const methods=new Function('deps','with(deps){'+source+';return {readEffort,continueReply};}')(deps);
  return {...methods,calls};
}
function request(body,headers={}){
  return new Request('https://fixture.invalid/v1/chats/test/continue',{
    method:'POST',...(body===undefined?{}:{body}),headers,
    ...(body instanceof ReadableStream?{duplex:'half'}:{})});
}
async function refusedBeforeGeneration(input,status,code){
  const f=fixture();
  await assert.rejects(f.continueReply({request:input,env:{DB:{}},params:{id:'test'}}),error=>error.status===status&&error.code===code);
  assert.deepEqual(f.calls,{lookup:0,lock:0,generation:0});
}

test('continuation effort keeps empty-body defaults and accepts every supported effort exactly',async()=>{
  const f=fixture();
  for(const body of [undefined,'',' \r\n\t','{}','{"think":null}'])assert.equal(await f.readEffort(request(body)),null);
  for(const think of [true,false,'low','medium'])assert.equal(await f.readEffort(request(JSON.stringify({think}))),think);
  const base=JSON.stringify({think:false,padding:''});
  const exact=JSON.stringify({think:false,padding:'x'.repeat(1024-Buffer.byteLength(base))});
  assert.equal(Buffer.byteLength(exact),1024);assert.equal(await f.readEffort(request(exact)),false);
});

test('continuation rejects a declared oversized body before DB or model access',async()=>{
  await refusedBeforeGeneration(request('{"think":false}',{'content-length':'4096'}),413,'too_large');
});

test('missing and understated Content-Length cannot bypass the actual continuation byte limit',async()=>{
  const body=JSON.stringify({think:false,padding:'x'.repeat(4096)});
  for(const headers of [{},{'content-length':'1'}])await refusedBeforeGeneration(request(body,headers),413,'too_large');
});

test('a chunked continuation body is bounded and cancels its unread remainder',async()=>{
  let cancelled=false;
  const encoder=new TextEncoder();
  const body=new ReadableStream({start(controller){
    controller.enqueue(encoder.encode('{"think":false,"padding":"'));
    controller.enqueue(encoder.encode('x'.repeat(2048)));
    controller.enqueue(encoder.encode('"}'));
  },cancel(){cancelled=true;}});
  const input=request(body);assert.equal(input.headers.get('content-length'),null);
  await refusedBeforeGeneration(input,413,'too_large');assert.equal(cancelled,true);
});

test('the continuation limit counts UTF-8 bytes rather than JavaScript characters',async()=>{
  const body=JSON.stringify({think:false,padding:'é'.repeat(512)});
  assert(body.length<1024);assert(Buffer.byteLength(body)>1024);
  await refusedBeforeGeneration(request(body),413,'too_large');
});

test('invalid JSON, nonobjects and unsupported effort fail before generation',async()=>{
  for(const body of ['{','[]','null','"medium"','{"think":"unsupported"}','{"think":0}'])
    await refusedBeforeGeneration(request(body),400,'bad_request');
});

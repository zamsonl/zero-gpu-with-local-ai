import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';

// Use the production parser with native byte/decoder streams and a controlled
// processing clock. Browser tests separately verify real paint/input scheduling.
const source=await fs.readFile(new URL('../public/js/api.js',import.meta.url),'utf8');
const parserSource=source.slice(source.indexOf('const STREAM_DRAIN_MS'),source.indexOf('/** 16 random bytes'));
function parser({clock=()=>0,timer=setTimeout}={}){
  return new Function('performance','setTimeout',parserSource+'\nreturn readNdjson;')({now:clock},timer);
}
const encode=text=>new TextEncoder().encode(text);
function bytesStream(chunks,{open=false}={}){
  let cancellations=0;
  const stream=new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);if(!open)controller.close();},cancel(){cancellations++;}});
  return {stream,get cancellations(){return cancellations;}};
}
async function collect(iterable){const events=[];for await(const event of iterable)events.push(event);return events;}

test('NDJSON preserves split UTF-8, CRLF, blank lines and the last record without a newline',async()=>{
  const events=[{event:'thinking',text:'  Hello 😀 世界\n\n  '},{event:'content',text:'final 🌏'}];
  const bytes=encode('\r\n'+JSON.stringify(events[0])+'\r\n \n'+JSON.stringify(events[1]));
  const input=bytesStream([...bytes].map(byte=>Uint8Array.of(byte)));
  assert.deepEqual(await collect(parser()(input.stream)),events);assert.equal(input.cancellations,0);
});

test('a buffered burst yields task time while retaining every event in exact order',async()=>{
  const events=Array.from({length:2000},(_,sequence)=>({event:'thinking',sequence,text:'part '+sequence+' 😀\n\n'}));
  const input=bytesStream([encode(events.map(event=>JSON.stringify(event)).join('\n')+'\n')]);
  let now=0,yields=0;const actual=[];
  const read=parser({clock:()=>now,timer:callback=>{yields++;callback();}});
  for await(const event of read(input.stream)){actual.push(event);now++;}
  assert.deepEqual(actual,events);assert(yields>0);assert(yields<events.length);assert.equal(input.cancellations,0);
});

test('an isolated arrival is yielded immediately without waiting for EOF or a timer',async()=>{
  const input=bytesStream([encode('{"event":"thinking","text":"first"}\n')],{open:true});
  const read=parser({timer:()=>assert.fail('Small arrivals must not enter a typing/timer queue.')}),iterator=read(input.stream);
  assert.deepEqual(await iterator.next(),{done:false,value:{event:'thinking',text:'first'}});
  await iterator.return();assert.equal(input.cancellations,1);
});

test('malformed JSON cancels unread stream data and exposes the parse error',async()=>{
  const input=bytesStream([encode('{"event":"thinking","text":"first"}\nnot-json\n')],{open:true});
  const iterator=parser()(input.stream);assert.equal((await iterator.next()).value.text,'first');
  await assert.rejects(iterator.next(),SyntaxError);assert.equal(input.cancellations,1);
});

test('abort stops a buffered burst before another event and cancels its source',async()=>{
  const input=bytesStream([encode('{"sequence":1}\n{"sequence":2}\n')],{open:true});
  const abort=new AbortController(),iterator=parser()(input.stream,abort.signal);
  assert.equal((await iterator.next()).value.sequence,1);abort.abort();
  await assert.rejects(iterator.next(),{name:'AbortError'});assert.equal(input.cancellations,1);
});

test('Stop during a cooperative task boundary rejects before yielding the next buffered event',async()=>{
  const input=bytesStream([encode('{"sequence":1}\n{"sequence":2}\n')],{open:true});
  const abort=new AbortController();let now=0,resume,scheduled;
  const ready=new Promise(resolve=>{scheduled=resolve;});
  const iterator=parser({clock:()=>now,timer:callback=>{resume=callback;scheduled();}})(input.stream,abort.signal);
  assert.equal((await iterator.next()).value.sequence,1);now=20;
  const pending=iterator.next();await ready;abort.abort();resume();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(input.cancellations,1);
});

test('transport errors and invalid trailing records remain failures',async()=>{
  const broken=new ReadableStream({start(controller){controller.error(new Error('transport closed'));}});
  await assert.rejects(collect(parser()(broken)),/transport closed/);
  await assert.rejects(collect(parser()(bytesStream([encode('{"sequence":1}\n{')]).stream)),SyntaxError);
});

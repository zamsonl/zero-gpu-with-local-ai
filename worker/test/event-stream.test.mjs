import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {EventWriter,NDJSON_HEADERS} from '../src/event-stream.js';

test('padding has a fixed cadence while tiny tokens keep arriving and ends before the terminal record',async()=>{
  const lines=[];let disconnected=0;
  const sink=new WritableStream({write(bytes){lines.push(new TextDecoder().decode(bytes));}});
  const events=new EventWriter(sink,()=>disconnected++,{heartbeatMs:25});
  for(let i=0;i<12;i++){await events.send({event:'thinking',text:'x'});await delay(10);}
  await events.send({event:'done',message:{id:1}});
  const count=lines.length;await delay(70);await events.close();
  assert.equal(lines.length,count);assert.equal(disconnected,0);
  const padded=lines.filter(line=>JSON.parse(line).event==='heartbeat');
  assert(padded.length>=3,'Continuous small tokens must not postpone padding');
  assert(padded.every(line=>line.length>=16384));
  assert.equal(JSON.parse(lines.at(-1)).event,'done');
  assert.match(NDJSON_HEADERS['cache-control'],/no-transform/);
  assert.equal(NDJSON_HEADERS['x-accel-buffering'],'no');
});

test('backpressure permits only one pending heartbeat and stops a client that never reads',async()=>{
  let writes=0,aborts=0,gone=0;
  const sink={getWriter(){return {write(){writes++;return new Promise(()=>{});},abort(){aborts++;return Promise.resolve();},close(){return Promise.resolve();}};}};
  const events=new EventWriter(sink,()=>gone++,{heartbeatMs:5,writeTimeoutMs:40});
  await events.send({event:'start'});
  await delay(40);await events.close();
  assert.equal(writes,1,'Heartbeat ticks must not enqueue unbounded pending writes');
  assert.equal(gone,1);assert(events.gone);assert(aborts>=1);
});

test('concurrent event producers serialize writes and cancellation invokes its hook once',async()=>{
  let active=0,maxActive=0;const order=[];
  const sink={getWriter(){return {async write(bytes){active++;maxActive=Math.max(maxActive,active);await delay(2);order.push(JSON.parse(new TextDecoder().decode(bytes)).value);active--;},abort(){return Promise.resolve();},close(){return Promise.resolve();}};}};
  const events=new EventWriter(sink,()=>order.push('gone'),{heartbeatMs:1000});
  await Promise.all([1,2,3].map(value=>events.send({event:'status',value})));
  assert.equal(maxActive,1);assert.deepEqual(order,[1,2,3]);
  events.markGone();events.markGone();await events.close();assert.deepEqual(order,[1,2,3,'gone']);
});

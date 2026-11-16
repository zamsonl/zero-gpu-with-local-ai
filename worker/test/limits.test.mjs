// A long reply must fit inside the Worker's per-request limits. Cloudflare counts every database
// call of a request against a cap; at the default of 10,000 a reply was cut after about 68 minutes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {LOCK_HEARTBEAT_MS,STOP_POLL_MS} from '../src/lock.js';
import {FLUSH_MS} from '../src/live.js';
import {streamTiming} from '../src/chat-stream.js';

test('the configured per-request limits leave room for the longest allowed reply',()=>{
  const config=fs.readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
  const limits=config.split(/^\[limits\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0]??'';
  const read=name=>{const match=new RegExp('^'+name+'[ \\t]*=[ \\t]*(\\d+)','m').exec(limits);return match?Number(match[1]):0;};
  const longest=streamTiming().jobMs;
  // While a reply streams, the Worker checks for Stop, mirrors the reply for other devices and renews its lock.
  const calls=longest/STOP_POLL_MS+longest/FLUSH_MS+longest/LOCK_HEARTBEAT_MS;
  assert(calls>10000,'the default cap of 10,000 calls would be enough; this check is out of date');
  assert(read('subrequests')>=calls*3,'subrequests must be at least three times the '+Math.round(calls)+' database calls of the longest reply');
  assert(read('subrequests')<=10000000,'Cloudflare allows at most 10,000,000');
  assert(read('cpu_ms')>=120000&&read('cpu_ms')<=300000,'a two-hour reply needs more CPU time than the 30-second default, within the 5-minute maximum');
});

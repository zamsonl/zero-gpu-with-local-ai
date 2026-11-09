import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {chooseModernFolder,MODERN_FOLDER_PICKER_SCRIPT} from '../folder-picker.mjs';

function processFixture({output='{"cancelled":true}',code=0,hold=false,error}={}){
  const calls=[];let child;
  const spawnProcess=(command,args,options)=>{
    child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    child.kills=0;child.kill=()=>{child.kills++;return true;};
    const call={command,args,options,input:Buffer.alloc(0),child};calls.push(call);
    child.stdin.on('data',chunk=>{call.input=Buffer.concat([call.input,chunk]);});
    if(!hold)queueMicrotask(()=>{
      if(error){child.emit('error',error);return;}
      const bytes=Buffer.isBuffer(output)?output:Buffer.from(output);
      // Deliberately split bytes to cover a UTF-8 character at chunk boundaries.
      child.stdout.write(bytes.subarray(0,3));child.stdout.write(bytes.subarray(3,31));child.stdout.write(bytes.subarray(31));
      child.emit('close',code);
    });
    return child;
  };
  return {calls,spawnProcess,get child(){return child;}};
}
const io={realpath:async value=>value,stat:async()=>({isDirectory:()=>true})};
const run=(fixture,extra={})=>chooseModernFolder({platform:'win32',spawnProcess:fixture.spawnProcess,io,...extra});

test('modern Explorer dialog uses fixed STA COM program and paths only in JSON stdin',async()=>{
  const initialFolder="C:\\Projects\\ç ”ç©¶ O'Brien $(Write-Output surprise); & project";
  const chosen="C:\\Projects\\ç ”ç©¶ O'Brien";
  const f=processFixture({output:JSON.stringify({cancelled:false,path:chosen})});
  assert.equal(await run(f,{initialFolder,env:{SystemRoot:'C:\\Windows',PATH:'tools',KAGGLE_API_TOKEN:'private-token',OPENCODE_CONFIG:'untrusted',OTHER_PASSWORD:'private'}}),chosen);
  const call=f.calls[0];
  assert.equal(call.command,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.deepEqual(call.options.stdio,['pipe','pipe','pipe']);
  assert(call.args.includes('-STA'));assert(call.args.includes('-NoProfile'));assert(call.args.includes('-NonInteractive'));
  const script=Buffer.from(call.args.at(-1),'base64').toString('utf16le');
  assert.equal(script,MODERN_FOLDER_PICKER_SCRIPT);assert(!script.includes(initialFolder));
  assert(script.includes('IFileOpenDialog'));assert(script.includes('0x20u | 0x40u'));assert(script.includes('GetDisplayName(0x80058000u'));
  assert(!script.includes('FolderBrowserDialog'));assert(!script.includes('BrowseForFolder'));
  assert.deepEqual(JSON.parse(call.input.toString('utf8')),{initialFolder});
  assert.equal(call.options.env.KAGGLE_API_TOKEN,undefined);assert.equal(call.options.env.OPENCODE_CONFIG,undefined);assert.equal(call.options.env.OTHER_PASSWORD,undefined);
  assert.equal(call.child.kills,0);
});

test('a canonical existing directory is returned and a selected file is rejected',async()=>{
  const selected='C:\\project-link',canonical='C:\\actual project';
  const f=processFixture({output:JSON.stringify({path:selected,cancelled:false})});
  let seen;
  assert.equal(await run(f,{io:{realpath:async folder=>{assert.equal(folder,selected);return canonical;},stat:async folder=>{seen=folder;return {isDirectory:()=>true};}}}),canonical);
  assert.equal(seen,canonical);
  const file=processFixture({output:JSON.stringify({path:'C:\\a-file.txt',cancelled:false})});
  await assert.rejects(run(file,{io:{...io,stat:async()=>({isDirectory:()=>false})}}),error=>error.code==='PROJECT_FOLDER_UNAVAILABLE');
  const vanished=processFixture({output:JSON.stringify({path:selected,cancelled:false})});
  await assert.rejects(run(vanished,{io:{...io,realpath:async()=>{throw Error('private-system-details');}}}),error=>error.code==='PROJECT_FOLDER_UNAVAILABLE'&&!error.message.includes('private-system-details'));
});

test('native Cancel and owner cancellation return null and never validate folders',async()=>{
  const f=processFixture();let reads=0;
  assert.equal(await run(f,{io:{realpath:async()=>{reads++;}}}),null);assert.equal(reads,0);
  const signal=AbortSignal.abort();const pre=processFixture({hold:true});
  assert.equal(await run(pre,{signal}),null);assert.equal(pre.calls.length,0);
  const abort=new AbortController(),held=processFixture({hold:true});
  const pending=run(held,{signal:abort.signal});abort.abort();assert.equal(await pending,null);assert.equal(held.child.kills,1);
  // Late exit/error events must not turn cancellation into an unhandled failure.
  held.child.emit('close',1);held.child.emit('error',Error('late child error'));
});

test('native failures are actionable and do not reveal raw stderr or exception details',async()=>{
  for(const options of [{code:1},{error:Error('KGAT_test_private_secret_exception')}]){
    const f=processFixture(options);
    const pending=run(f);f.child.stderr.write('KGAT_test_private_token_from_raw_stderr');
    await assert.rejects(pending,error=>error.code==='FOLDER_PICKER_UNAVAILABLE'&&error.message.includes('Enter the full project folder path')&&!error.message.includes('KGAT_'));
  }
  await assert.rejects(chooseModernFolder({platform:'win32',spawnProcess(){throw Error('raw spawn secret');}}),error=>error.code==='FOLDER_PICKER_UNAVAILABLE'&&!error.message.includes('raw spawn secret'));
});

test('malformed, oversized, non-UTF8 and non-filesystem picker results are rejected',async()=>{
  const invalid=['', 'not json','null','[]','{"cancelled":true,"path":"C:\\\\unexpected"}',
    JSON.stringify({cancelled:false,path:'relative'}),JSON.stringify({cancelled:false,path:'C:\\bad\nfolder'}),
    JSON.stringify({cancelled:false,path:'C:\\ok',extra:true}),JSON.stringify({cancelled:'false',path:'C:\\ok'}),
    'x'.repeat(65537),Buffer.from([0xff,0xff])];
  for(const output of invalid){
    const f=processFixture({output});let reads=0;
    await assert.rejects(run(f,{io:{realpath:async()=>{reads++;}}}),error=>error.code==='FOLDER_PICKER_UNAVAILABLE');
    assert.equal(reads,0);
  }
});

test('initial paths and unsupported systems fail before any native process starts',async()=>{
  for(const initialFolder of ['relative','C:\\bad\u0000folder',null,12]){
    const f=processFixture();await assert.rejects(run(f,{initialFolder}),error=>error.code==='INVALID_INITIAL_FOLDER');assert.equal(f.calls.length,0);
  }
  const f=processFixture();await assert.rejects(run(f,{platform:'linux'}),error=>error.code==='FOLDER_PICKER_UNAVAILABLE');assert.equal(f.calls.length,0);
});

test('a bounded timeout terminates only the owned picker process',async()=>{
  const f=processFixture({hold:true});
  await assert.rejects(run(f,{timeoutMs:15}),error=>error.code==='FOLDER_PICKER_TIMEOUT');assert.equal(f.child.kills,1);
  for(const timeoutMs of [0,-1,Infinity,30*60*1000+1]){
    const g=processFixture();await assert.rejects(run(g,{timeoutMs}),/Invalid folder-selection timeout/);assert.equal(g.calls.length,0);
  }
});

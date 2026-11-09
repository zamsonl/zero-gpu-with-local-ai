import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {DEFAULT_CREDENTIAL_PATH,secureTokenStorageAvailable,createWindowsDpapiProtector,loadSavedKaggleToken,saveKaggleToken,forgetKaggleToken} from '../credential-store.mjs';

const TOKEN='KGAT_test_synthetic_credential_storage_8247';
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qwen-credential-test-'));
  t.after(async()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const key=randomBytes(32),iv=randomBytes(12);
  const protector={protect:async bytes=>{const cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);},unprotect:async bytes=>{const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(0,-16)),cipher.final()]);}};
  return {file:path.join(root,'vault.json'),platform:'win32',protector,root};
}
test('encrypted save/load replaces atomically and forgetting removes only the selected credential',async t=>{
  const f=await fixture(t);assert.equal(await loadSavedKaggleToken(f),null);
  const result=await saveKaggleToken(TOKEN,f);assert.equal(result.protected,true);
  const encoded=await fs.readFile(f.file,'utf8');assert(!encoded.includes(TOKEN));assert.equal(JSON.parse(encoded).protection,'windows-dpapi-current-user');
  assert.equal(await loadSavedKaggleToken(f),TOKEN);
  const replacement=TOKEN+'_new';await saveKaggleToken(replacement,f);assert.equal(await loadSavedKaggleToken(f),replacement);
  assert.deepEqual(await fs.readdir(f.root),['vault.json']);
  assert.equal(await forgetKaggleToken(f),true);assert.equal(await forgetKaggleToken(f),false);assert.equal(await loadSavedKaggleToken(f),null);
});
test('invalid or unavailable credentials fail safely without exposing token text or plaintext fallback',async t=>{
  const f=await fixture(t);
  for(const token of ['bad',TOKEN+'!',TOKEN+'x'.repeat(300)])await assert.rejects(saveKaggleToken(token,f),error=>error.code==='INVALID_KAGGLE_TOKEN'&&!error.message.includes(token));
  assert.equal(secureTokenStorageAvailable('linux'),false);assert.equal(secureTokenStorageAvailable('win32'),true);
  await assert.rejects(saveKaggleToken(TOKEN,{...f,platform:'linux'}),error=>error.code==='SECURE_STORAGE_UNAVAILABLE'&&!error.message.includes(TOKEN));
  assert.deepEqual(await fs.readdir(f.root),[]);
  await saveKaggleToken(TOKEN,f);
  await assert.rejects(loadSavedKaggleToken({...f,platform:'darwin'}),{code:'SECURE_STORAGE_UNAVAILABLE'});
  await assert.rejects(loadSavedKaggleToken({...f,protector:{unprotect:async()=>{throw new Error(TOKEN);}}}),error=>error.code==='SAVED_TOKEN_UNAVAILABLE'&&!error.message.includes(TOKEN));
});
test('corrupt, oversized, extra-field and decrypted malformed stores are rejected',async t=>{
  const f=await fixture(t);
  for(const value of ['{',JSON.stringify({version:1,protection:'plaintext',ciphertext:TOKEN}),JSON.stringify({version:1,protection:'windows-dpapi-current-user',ciphertext:'YQ==',token:TOKEN}),'x'.repeat(17000)]){
    await fs.writeFile(f.file,value);await assert.rejects(loadSavedKaggleToken(f),error=>error.code==='SAVED_TOKEN_UNAVAILABLE'&&!error.message.includes(TOKEN));
  }
  await saveKaggleToken(TOKEN,f);
  await assert.rejects(loadSavedKaggleToken({...f,protector:{unprotect:async()=>Buffer.from('not a token')}}),{code:'SAVED_TOKEN_UNAVAILABLE'});
});
test('failed replacement keeps the previous saved token and erases its temporary encrypted file',async t=>{
  const f=await fixture(t);await saveKaggleToken(TOKEN,f);
  await assert.rejects(saveKaggleToken(TOKEN+'_new',{...f,fs:{...fs,rename:async()=>{throw new Error(TOKEN);}}}),error=>error.code==='SAVED_TOKEN_WRITE_FAILED'&&!error.message.includes(TOKEN));
  assert.equal(await loadSavedKaggleToken(f),TOKEN);assert.deepEqual(await fs.readdir(f.root),['vault.json']);
});
test('DPAPI child uses fixed code, clean environment and stdin rather than secret arguments',async()=>{
  let captured,received;
  const protector=createWindowsDpapiProtector({env:{SystemRoot:'C:\\Windows',PATH:'safe',KAGGLE_API_TOKEN:TOKEN,OPENAI_API_KEY:'unrelated'},spawnProcess:(command,args,options)=>{
    captured={command,args,options};const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};child.stdin=new EventEmitter();child.stdin.end=value=>{received=value;queueMicrotask(()=>{child.stdout.emit('data',Buffer.from('protected result').toString('base64'));child.emit('close',0);});};return child;
  }});
  assert.equal((await protector.protect(Buffer.from(TOKEN))).toString(),'protected result');
  assert.equal(Buffer.from(received,'base64').toString(),TOKEN);assert(!JSON.stringify(captured).includes(TOKEN));assert.equal(captured.options.env.KAGGLE_API_TOKEN,undefined);assert.equal(captured.options.env.OPENAI_API_KEY,undefined);assert.equal(captured.options.shell,false);assert.equal(captured.options.windowsHide,true);
  const script=Buffer.from(captured.args.at(-1),'base64').toString('utf16le');assert(script.includes('CurrentUser'));assert(!script.includes(TOKEN));assert(script.includes('[Console]::In.ReadToEnd()'));
});
test('actual Windows account encryption roundtrips only a synthetic token', {skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);delete f.protector;
  await saveKaggleToken(TOKEN,f);assert.equal(await loadSavedKaggleToken(f),TOKEN);
  assert(!String(await fs.readFile(f.file)).includes(TOKEN));assert(DEFAULT_CREDENTIAL_PATH.endsWith('kaggle-token.dpapi.json'));
});
test('a broken DPAPI input pipe stops its helper and exposes only a safe error',async()=>{
  let killed=0;
  const protector=createWindowsDpapiProtector({spawnProcess:()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};child.stdin=new EventEmitter();child.stdin.end=()=>queueMicrotask(()=>child.stdin.emit('error',new Error(TOKEN)));child.kill=()=>{killed++;};return child;
  }});
  await assert.rejects(protector.protect(Buffer.from(TOKEN)),error=>error.code==='SAVED_TOKEN_UNAVAILABLE'&&!error.message.includes(TOKEN));assert.equal(killed,1);
});

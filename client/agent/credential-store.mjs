// Remember only the user's Kaggle token, encrypted for the current Windows user.
// Tokens travel to DPAPI over stdin, never command arguments, environment or logs.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cleanChildEnvironment} from './opencode-config.mjs';

export const DEFAULT_CREDENTIAL_PATH=path.join(os.homedir(),'.qwen','kaggle-token.dpapi.json');
const TOKEN=/^KGAT_[A-Za-z0-9_-]{16,251}$/;
const MAX_FILE_BYTES=16384,MAX_CIPHER_BYTES=8192;
const PROTECTION='windows-dpapi-current-user';

export const secureTokenStorageAvailable=(platform=process.platform)=>platform==='win32';
function error(code,message){const value=new Error(message);value.code=code;return value;}
function unavailable(){return error('SECURE_STORAGE_UNAVAILABLE','Remembering a Kaggle token requires Windows account encryption. Paste your token for this run; no plaintext fallback is used.');}
function unreadable(){return error('SAVED_TOKEN_UNAVAILABLE','The saved Kaggle token could not be unlocked for this Windows account. Forget it and enter your own token again.');}
function tokenValue(value){
  if(typeof value!=='string'||!TOKEN.test(value.trim()))throw error('INVALID_KAGGLE_TOKEN','Enter only your own modern Kaggle API token, starting with KGAT_.');
  return value.trim();
}
function decodeBase64(value,maxBytes){
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(maxBytes/3)*4||value.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw unreadable();
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>maxBytes||bytes.toString('base64')!==value)throw unreadable();
  return bytes;
}

function dpapiScript(method){
  if(!['Protect','Unprotect'].includes(method))throw new Error('Invalid credential protection operation.');
  return `$ErrorActionPreference='Stop'; $raw=$null; $result=$null; try { Add-Type -AssemblyName System.Security; $raw=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::${method}($raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)); } catch { [Console]::Error.Write('Credential protection failed.'); exit 1; } finally { if($raw){[Array]::Clear($raw,0,$raw.Length)}; if($result){[Array]::Clear($result,0,$result.Length)} }`;
}

export function createWindowsDpapiProtector({spawnProcess=spawn,env=process.env,timeoutMs=15000}={}){
  const operation=(method,bytes)=>new Promise((resolve,reject)=>{
    let child,settled=false,output='';
    const finish=(failure,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(failure){try{child?.kill();}catch{}reject(unreadable());}else resolve(value);};
    const timer=setTimeout(()=>{try{child?.kill();}catch{}finish(true);},timeoutMs);
    try{
      const binary=path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const script=Buffer.from(dpapiScript(method),'utf16le').toString('base64');
      child=spawnProcess(binary,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',script],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:cleanChildEnvironment(env)});
      child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>Math.ceil(MAX_CIPHER_BYTES/3)*4+16){try{child.kill();}catch{}finish(true);}});
      child.stderr.resume();
      child.once('error',()=>finish(true));
      child.once('close',code=>{
        if(code!==0)return finish(true);
        try{finish(false,decodeBase64(output.trim(),method==='Unprotect'?256:MAX_CIPHER_BYTES));}catch{finish(true);}
      });
      child.stdin.once('error',()=>finish(true));
      child.stdin.end(bytes.toString('base64'));
    }catch{try{child?.kill();}catch{}finish(true);}
  });
  return {protect:bytes=>operation('Protect',bytes),unprotect:bytes=>operation('Unprotect',bytes)};
}

export async function loadSavedKaggleToken({file=DEFAULT_CREDENTIAL_PATH,platform=process.platform,protector,fs:io=fs}={}){
  let info;
  try{info=await io.lstat(file);}catch(cause){if(cause?.code==='ENOENT')return null;throw unreadable();}
  if(!secureTokenStorageAvailable(platform))throw unavailable();
  if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>MAX_FILE_BYTES)throw unreadable();
  let plain;
  try{
    const raw=await io.readFile(file);
    if(raw.length>MAX_FILE_BYTES)throw unreadable();
    const record=JSON.parse(raw.toString('utf8'));
    if(!record||record.version!==1||record.protection!==PROTECTION||Object.keys(record).sort().join(',')!=='ciphertext,protection,version')throw unreadable();
    const cipher=decodeBase64(record.ciphertext,MAX_CIPHER_BYTES);
    plain=await(protector||createWindowsDpapiProtector()).unprotect(cipher);
    if(!Buffer.isBuffer(plain)||plain.length>256)throw unreadable();
    return tokenValue(plain.toString('utf8'));
  }catch{throw unreadable();}
  finally{if(Buffer.isBuffer(plain))plain.fill(0);}
}

export async function saveKaggleToken(token,{file=DEFAULT_CREDENTIAL_PATH,platform=process.platform,protector,fs:io=fs}={}){
  if(!secureTokenStorageAvailable(platform))throw unavailable();
  const value=tokenValue(token),plain=Buffer.from(value,'utf8');
  let temporary;
  try{
    const cipher=await(protector||createWindowsDpapiProtector()).protect(plain);
    if(!Buffer.isBuffer(cipher)||!cipher.length||cipher.length>MAX_CIPHER_BYTES||cipher.includes(plain))throw unreadable();
    const record=JSON.stringify({version:1,protection:PROTECTION,ciphertext:cipher.toString('base64')})+'\n';
    await io.mkdir(path.dirname(file),{recursive:true,mode:0o700});
    temporary=path.join(path.dirname(file),'.kaggle-token-'+randomUUID()+'.tmp');
    await io.writeFile(temporary,record,{encoding:'utf8',mode:0o600,flag:'wx'});
    await io.rename(temporary,file);temporary=null;
    return {path:file,protected:true};
  }catch{throw error('SAVED_TOKEN_WRITE_FAILED','The Kaggle token could not be saved with Windows account encryption. You can continue without remembering it.');}
  finally{plain.fill(0);if(temporary)await io.unlink(temporary).catch(()=>{});}
}

export async function forgetKaggleToken({file=DEFAULT_CREDENTIAL_PATH,fs:io=fs}={}){
  try{await io.unlink(file);return true;}catch(cause){if(cause?.code==='ENOENT')return false;throw error('SAVED_TOKEN_DELETE_FAILED','The saved Kaggle token could not be removed. Check access to the local credential file.');}
}

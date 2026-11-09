import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const MAX_FILE=512*1024;
const SKIP=new Set(['.git','node_modules','.venv','venv','__pycache__','.ssh','.aws','.azure','.qwen','.codex']);
const denied=name=>SKIP.has(name.toLowerCase()) || /^\.env(?:\.|$)|^id_(rsa|ed25519)|^credentials(?:\.|$)/i.test(name);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class Workspace {
  constructor(root,stateDir) {this.root=root;this.stateDir=stateDir;this.child=null;}
  static async open(root,stateDir) {
    const resolved=await fs.realpath(root);
    if(!(await fs.stat(resolved)).isDirectory()) throw new Error('Choose a folder.');
    return new Workspace(resolved,path.resolve(stateDir));
  }
  async resolve(relative='',{newFile=false}={}) {
    if(typeof relative!=='string'||relative.includes('\0')||path.isAbsolute(relative)||relative.includes(':')) throw new Error('Use a path relative to the selected folder.');
    const parts=relative.split(/[\\/]/).filter(p=>p&&p!=='.');
    if(parts.some(p=>p==='..'||denied(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('This path is outside the workspace or excluded.');
    let current=this.root;
    for(let i=0;i<parts.length;i++) {
      current=path.join(current,parts[i]);
      try {
        const stat=await fs.lstat(current);
        if(stat.isSymbolicLink()) throw new Error('Links and junctions are excluded.');
        const real=await fs.realpath(current);
        const rel=path.relative(this.root,real);
        if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)) throw new Error('Path escapes the selected folder.');
      } catch(error) {if(error.code==='ENOENT'&&newFile&&i===parts.length-1) return current;throw error;}
    }
    return current;
  }
  async entries(relative='') {
    const entries=await fs.readdir(await this.resolve(relative),{withFileTypes:true});
    return entries.filter(e=>!denied(e.name)&&!e.isSymbolicLink()).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name)).map(e=>({name:e.name,type:e.isDirectory()?'folder':'file',path:relative?relative.replace(/\\/g,'/')+'/'+e.name:e.name}));
  }
  async listPage(relative=''){const entries=await this.entries(relative);return {entries:entries.slice(0,400),truncated:entries.length>400};}
  async list(relative=''){return (await this.listPage(relative)).entries;}
  async read(relative) {
    const file=await this.resolve(relative);
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>MAX_FILE) throw new Error('Read a text file smaller than 512 KiB.');
    // A growing log must not turn a small stat() into an unbounded readFile().
    const handle=await fs.open(file,'r');const buffer=Buffer.alloc(MAX_FILE+1);let count=0;
    try{for(;;){const {bytesRead}=await handle.read(buffer,count,buffer.length-count,null);count+=bytesRead;if(count>MAX_FILE)throw new Error('Read a text file smaller than 512 KiB.');if(!bytesRead)break;}}
    finally{await handle.close();}
    const bytes=buffer.subarray(0,count);
    if(bytes.includes(0)) throw new Error('Binary files are excluded.');
    const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    return {path:relative,content,hash:hash(bytes)};
  }
  async search(query,relative='',signal) {
    if(typeof query!=='string'||!query||query.length>200) throw new Error('Search needs 1–200 literal characters.');
    const matches=[];let visited=0,truncated=false;
    const walk=async(dir,depth=0)=>{
      if(depth>12){truncated=true;return;}
      signal?.throwIfAborted();
      for(const entry of await this.entries(dir)) {
        signal?.throwIfAborted();
        if(visited++>=1500||matches.length>=80){truncated=true;return;}
        if(entry.type==='folder') {await walk(entry.path,depth+1);continue;}
        try {
          const {content}=await this.read(entry.path);
          for(const [i,line] of content.split('\n').entries()) if(line.toLowerCase().includes(query.toLowerCase())) {
            matches.push({path:entry.path,line:i+1,text:line.slice(0,400)});if(matches.length>=80){truncated=true;return;}
          }
        }catch{/* Inaccessible, nontext and excluded files remain local. */}
      }
    };
    await walk(relative);return {matches,truncated};
  }
  async snapshot(relative) {
    try{return await this.read(relative);}catch(error){if(error.code==='ENOENT'){await this.resolve(relative,{newFile:true});return {path:relative,content:'',hash:null};}throw error;}
  }
  async write(relative,content,expectedHash,signal) {
    signal?.throwIfAborted();
    if(typeof content!=='string'||Buffer.byteLength(content)>MAX_FILE) throw new Error('Edits are limited to 512 KiB.');
    const before=await this.snapshot(relative);
    signal?.throwIfAborted();
    if(before.hash!==expectedHash) throw new Error('The file changed since review. Read it again before approving.');
    const file=await this.resolve(relative,{newFile:true});
    signal?.throwIfAborted();
    let backup=null;
    if(before.hash!==null) {
      await fs.mkdir(this.stateDir,{recursive:true});
      backup=path.join(this.stateDir,randomUUID()+'.json');
      await fs.writeFile(backup,JSON.stringify({path:relative,content:before.content,hash:before.hash,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
    }
    // Recheck after backup and use exclusive temp creation. A terminal running outside this
    // helper can still change the filesystem; this is path validation, not an OS sandbox.
    if((await this.snapshot(relative)).hash!==expectedHash) throw new Error('File changed during review.');
    const temp=file+'.qwen-'+randomUUID()+'.tmp';
    try {signal?.throwIfAborted();await fs.writeFile(temp,content,{flag:'wx',mode:0o600,signal});await this.resolve(relative,{newFile:true});signal?.throwIfAborted();await fs.rename(temp,file);}
    finally {await fs.rm(temp,{force:true}).catch(()=>{});}
    return {path:relative,bytes:Buffer.byteLength(content),backup};
  }
  async terminal(command,signal,{timeoutMs=120000}={}) {
    signal?.throwIfAborted();
    if(typeof command!=='string'||!command.trim()||command.length>16000) throw new Error('Invalid command.');
    if(this.child) throw new Error('A command is already running.');
    const windows=process.platform==='win32';
    const powershell="$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "+command;
    const args=windows?['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(powershell,'utf16le').toString('base64')]:['-lc',command];
    const env={...process.env};
    for(const key of Object.keys(env)) if(/TOKEN|SECRET|API_KEY|RELAY_KEY|PASSWORD/i.test(key)) delete env[key];
    const child=spawn(windows?'powershell.exe':'/bin/sh',args,{cwd:this.root,env,windowsHide:true,detached:!windows,stdio:['ignore','pipe','pipe']});
    this.child=child;let output='',truncated=false,timedOut=false,killPromise=null;
    const append=bytes=>{const text=bytes.toString();if(output.length+text.length>60000) truncated=true;output=(output+text).slice(0,60000);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const kill=()=>{
      if(killPromise)return killPromise;
      killPromise=windows?new Promise(resolve=>{const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',resolve);killer.once('exit',resolve);}):Promise.resolve().then(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
      return killPromise;
    };
    const cancel=()=>{void kill();};
    const timer=setTimeout(()=>{timedOut=true;void kill();},timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted) cancel();
    try {
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
      if(killPromise)await killPromise;
      return {exit_code:code,output,truncated,timed_out:timedOut,stopped:!!signal?.aborted};
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.child=null;}
  }
}

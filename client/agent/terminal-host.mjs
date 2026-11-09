// A one-use loopback handoff keeps model credentials out of command arguments,
// the setup renderer and temporary files. Only the reviewed CLI gets its env.
import {spawn} from 'node:child_process';
const [origin,capability]=process.argv.slice(2);
let child;
try{
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin||'')||!/^[a-f0-9]{64}$/.test(capability||''))throw new Error('OpenCode must be opened from the local setup interface.');
  const response=await fetch(origin+'/terminal/bootstrap',{headers:{authorization:'Bearer '+capability},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('The private terminal handoff expired. Reopen setup.');
  const payload=await response.json();
  if(typeof payload.command!=='string'||!Array.isArray(payload.args)||!payload.args.every(value=>typeof value==='string')||typeof payload.cwd!=='string'||!payload.env||typeof payload.env!=='object')throw new Error('Invalid terminal handoff.');
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('The coding terminal needs an interactive console.');
  child=spawn(payload.command,payload.args,{cwd:payload.cwd,env:payload.env,shell:false,stdio:'inherit',windowsHide:false});
  const completion=new Promise(resolve=>child.once('close',code=>resolve(Number.isInteger(code)?code:1)));
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  for(const key of Object.keys(payload.env))delete payload.env[key];
  const started=await fetch(origin+'/terminal/started',{method:'POST',headers:{authorization:'Bearer '+capability,'content-type':'application/json'},body:JSON.stringify({tty:true}),signal:AbortSignal.timeout(10000)});
  if(!started.ok)throw new Error('Setup did not confirm the terminal session.');
  process.exitCode=await completion;
}catch{
  console.error('OpenCode could not open. Return to the setup window for the current stage and event log.');
  try{child?.kill();}catch{}
  process.exitCode=1;
}

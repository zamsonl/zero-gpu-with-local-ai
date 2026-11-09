const form=document.querySelector('#connect-form');
const input=document.querySelector('#workspace-key');
const button=document.querySelector('#connect-submit');
const status=document.querySelector('#connect-status');
let busy=false;
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  let key=input.value.trim();
  if(!key){status.textContent='Enter the workspace key from your Advanced Setup.';input.focus();return;}
  if(key.startsWith('KGAT_')){status.textContent='This page needs your workspace RELAY_KEY, not a Kaggle API token.';return;}
  busy=true;button.disabled=true;status.textContent='Checking your workspace key…';
  try{
    const response=await fetch('/v1/config',{headers:{'x-relay-key':key},cache:'no-store',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw new Error(response.status===401||response.status===403?'That key was not accepted. Check the RELAY_KEY on this deployment.':'The workspace could not be reached. Check the deployment and retry.');}
    const config=await response.json();if(!config||typeof config.model!=='string')throw new Error('This address did not return the expected workspace.');
    localStorage.setItem('qwen.relayKey',key);input.value='';key='';
    status.textContent='Connected. Opening your workspace…';location.replace('/');
  }catch(error){status.textContent=error.name==='TimeoutError'?'The connection timed out. Check your deployment and retry.':error.message;}
  finally{key='';busy=false;button.disabled=false;}
});

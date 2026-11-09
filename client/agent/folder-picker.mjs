// Windows' modern Explorer folder dialog. User paths travel as JSON over stdin;
// the PowerShell/C# program is fixed and never interpolates a selected path.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {cleanChildEnvironment} from './opencode-config.mjs';

const MAX_OUTPUT_BYTES=65536;
const DEFAULT_TIMEOUT_MS=10*60*1000;

const CSHARP=String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace QwenSetup {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"), ClassInterface(ClassInterfaceType.None)]
  internal class FileOpenDialog { }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint displayName, out IntPtr name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }

  // Flatten the inherited IModalWindow/IFileDialog methods in their native
  // vtable order. Only the methods used below are called, but no slots are skipped.
  [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, uint placement);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IntPtr items);
    void GetSelectedItems(out IntPtr items);
  }

  public static class NativeFolderPicker {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
    private static extern int SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, out IShellItem item);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    public static string Choose(string initialFolder) {
      IFileOpenDialog dialog=null;
      IShellItem initial=null, selected=null;
      IntPtr displayName=IntPtr.Zero;
      try {
        dialog=(IFileOpenDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST |
        // FOS_NOCHANGEDIR | FOS_DONTADDTORECENT.
        dialog.SetOptions(options | 0x20u | 0x40u | 0x800u | 0x8u | 0x02000000u);
        dialog.SetTitle("Choose your Qwen project folder");
        dialog.SetOkButtonLabel("Use this folder");
        if (!String.IsNullOrEmpty(initialFolder) && Directory.Exists(initialFolder)) {
          Guid iid=new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
          int create=SHCreateItemFromParsingName(initialFolder, IntPtr.Zero, ref iid, out initial);
          if (create>=0 && initial!=null) dialog.SetFolder(initial);
        }
        int result=dialog.Show(GetForegroundWindow());
        if (result==unchecked((int)0x800704C7)) return null;
        if (result<0) Marshal.ThrowExceptionForHR(result);
        dialog.GetResult(out selected);
        selected.GetDisplayName(0x80058000u, out displayName); // SIGDN_FILESYSPATH.
        return Marshal.PtrToStringUni(displayName);
      } finally {
        if (displayName!=IntPtr.Zero) Marshal.FreeCoTaskMem(displayName);
        if (selected!=null) Marshal.FinalReleaseComObject(selected);
        if (initial!=null) Marshal.FinalReleaseComObject(initial);
        if (dialog!=null) Marshal.FinalReleaseComObject(dialog);
      }
    }
  }
}
`;

export const MODERN_FOLDER_PICKER_SCRIPT=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
try {
  $payload=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $source=@'
${CSHARP}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop | Out-Null
  $selected=[QwenSetup.NativeFolderPicker]::Choose([string]$payload.initialFolder)
  if ($null -eq $selected) {
    [Console]::Out.Write('{"cancelled":true}')
  } else {
    [Console]::Out.Write((@{cancelled=$false;path=$selected} | ConvertTo-Json -Compress))
  }
} catch {
  [Console]::Error.Write('The Windows Explorer folder dialog could not open.')
  exit 1
}
`;

function pickerError(code,message){const error=new Error(message);error.code=code;return error;}
const unavailable=()=>pickerError('FOLDER_PICKER_UNAVAILABLE','The Windows Explorer folder dialog could not open. Enter the full project folder path instead.');
const validWindowsPath=value=>typeof value==='string'&&value.length>0&&value.length<=32767&&!/[\u0000-\u001f]/.test(value)&&path.win32.isAbsolute(value);

/** Return the existing selected folder, or null when the user/owner cancels. */
export async function chooseModernFolder({initialFolder='',signal,timeoutMs=DEFAULT_TIMEOUT_MS,spawnProcess=spawn,platform=process.platform,env=process.env,io=fs}={}){
  if(signal?.aborted)return null;
  if(platform!=='win32')throw pickerError('FOLDER_PICKER_UNAVAILABLE','Enter the full project folder path on this system.');
  if(initialFolder!==''&&!validWindowsPath(initialFolder))throw pickerError('INVALID_INITIAL_FOLDER','Enter an absolute project folder path.');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>30*60*1000)throw new Error('Invalid folder-selection timeout.');
  const selected=await new Promise((resolve,reject)=>{
    let child,settled=false,outputBytes=0;const output=[];
    const kill=()=>{try{child?.kill();}catch{}};
    const finish=(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error){kill();reject(error);}else resolve(value);
    };
    const abort=()=>{kill();finish(null,null);};
    const timer=setTimeout(()=>finish(pickerError('FOLDER_PICKER_TIMEOUT','Folder selection took too long. Browse again or enter the full project path.')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{
      const executable=path.win32.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      child=spawnProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(MODERN_FOLDER_PICKER_SCRIPT,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:cleanChildEnvironment(env)});
      child.stdout.on('data',value=>{
        const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);outputBytes+=bytes.length;
        if(outputBytes>MAX_OUTPUT_BYTES){finish(unavailable());return;}output.push(bytes);
      });
      child.stderr.resume();
      child.once('error',()=>finish(unavailable()));
      child.once('close',code=>{
        if(settled)return;
        if(code!==0){finish(unavailable());return;}
        try{
          const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output)).replace(/^\uFEFF/,'');
          const result=JSON.parse(raw);
          if(result&&typeof result==='object'&&!Array.isArray(result)&&result.cancelled===true&&Object.keys(result).length===1){finish(null,null);return;}
          if(!result||typeof result!=='object'||Array.isArray(result)||result.cancelled!==false||Object.keys(result).sort().join(',')!=='cancelled,path'||!validWindowsPath(result.path))throw new Error();
          finish(null,result.path);
        }catch{finish(unavailable());}
      });
      child.stdin.once('error',()=>finish(unavailable()));
      child.stdin.end(JSON.stringify({initialFolder}),'utf8');
    }catch{finish(unavailable());}
  });
  if(!selected||signal?.aborted)return null;
  try{
    const folder=await io.realpath(selected);
    if(!validWindowsPath(folder)||!(await io.stat(folder)).isDirectory())throw new Error();
    return signal?.aborted?null:folder;
  }catch{throw pickerError('PROJECT_FOLDER_UNAVAILABLE','The selected folder is no longer available. Choose another folder or enter its full path.');}
}

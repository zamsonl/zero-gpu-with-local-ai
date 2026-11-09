Option Explicit
Dim shell, files, folder, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder
On Error Resume Next
result = shell.Run("node """ & folder & "\setup.mjs""", 0, True)
If Err.Number <> 0 Then
  Err.Clear
  If MsgBox("Node.js 20 or newer is needed for Qwen setup. Open the official download page?", 36, "Heretic Qwen setup") = 6 Then
    shell.Run "https://nodejs.org/en/download", 1, False
  End If
  WScript.Quit 1
End If
On Error GoTo 0
If result <> 0 Then
  MsgBox "Qwen setup could not open. Check that Node.js 20 or newer is installed, then try again. You can also run node opencode.mjs --setup in this folder.", 48, "Heretic Qwen setup"
End If

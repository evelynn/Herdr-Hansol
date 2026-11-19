# 指定プロセスのコンソール（herdr-core の端末）へ OSC 7501 を書く。フックのプロセスは別のコンソールを持つことがあるため、
# FreeConsole → AttachConsole(端末の本体プロセス) → WriteConsole の順で書く。
# 使い方: powershell -NoProfile -File console-write.ps1 -TargetPid <pid> -Body "state=working:app=cursor:msg=..."
param(
  [Parameter(Mandatory = $true)][uint32]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Body
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HcCon {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool WriteConsoleW(IntPtr h, string b, uint n, out uint w, IntPtr r);
}
'@
[void][HcCon]::FreeConsole()
if (-not [HcCon]::AttachConsole($TargetPid)) { exit 2 }
$h = [HcCon]::CreateFileW('CONOUT$', [uint32]3221225472, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
$text = [string][char]27 + ']7501;' + $Body + [string][char]7
$w = [uint32]0
if (-not [HcCon]::WriteConsoleW($h, $text, [uint32]$text.Length, [ref]$w, [IntPtr]::Zero)) { exit 3 }
exit 0

$ErrorActionPreference = 'Stop'
$start = Join-Path $PSScriptRoot 'start.ps1'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data\config.json'))) { throw 'Run setup first.' }
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $startup 'QQ Codex Bridge.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $start + '" -NoBrowser'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output 'Current-user startup entry installed.'

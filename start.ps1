param([switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'runtime.ps1')
$disabled = Join-Path $PSScriptRoot 'data\autoconnect.disabled'
if (Test-Path -LiteralPath $disabled) { Remove-Item -LiteralPath $disabled }
Start-BridgeGuardian
$health = Start-BridgeService
$url = 'http://127.0.0.1:' + (Get-BridgeConfig).statusPort
Write-Output ('QQ bridge is running. ' + $url)
if (-not $NoBrowser) { Start-Process -FilePath $url }

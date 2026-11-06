param([switch]$KeepAdapter)
. (Join-Path $PSScriptRoot 'runtime.ps1')
# A manual stop persists across app restarts until the user starts the bridge.
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data\autoconnect.disabled'),(Get-Date).ToString('o'))
Invoke-BridgeStartup {
  $config = Get-BridgeConfig
  $health = Get-BridgeHealth
  if ($health) {
    Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:'+$config.statusPort+'/stop') -Headers @{Authorization=('Bearer '+$config.controlToken)} -TimeoutSec 5 | Out-Null
    for ($attempt=0; $attempt -lt 60; $attempt++) {
      if (-not (Get-Process -Id $health.pid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $health.pid -ErrorAction SilentlyContinue) { throw 'Service is still finishing a request.' }
  }
}
Write-Output 'QQ bridge stopped. Automatic recovery is suspended. Start the bridge to resume.'

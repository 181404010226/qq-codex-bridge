. (Join-Path $PSScriptRoot 'runtime.ps1')
$mutex = [Threading.Mutex]::new($false,('Local\QQCodexGuardian-'+(Get-BridgeIdentity)))
try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { $mutex.Dispose(); return }
$guardianFile = Join-Path $PSScriptRoot 'data\guardian-process.json'
$guardianLog = Join-Path $PSScriptRoot 'data\guardian.log'
$config = Get-BridgeConfig
$failedHealth = 0
$lastState = ''
$lastStart = [DateTime]::MinValue
$retrySeconds = 5
function Write-GuardianState([string]$State) {
  if ($State -eq $script:lastState) { return }
  $script:lastState = $State
  $record = @{pid=$PID;root=$PSScriptRoot;state=$State;updated=(Get-Date).ToString('o')}
  [IO.File]::WriteAllText($guardianFile,($record | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  if ((Test-Path -LiteralPath $guardianLog) -and (Get-Item -LiteralPath $guardianLog).Length -gt 1048576) {
    Move-Item -LiteralPath $guardianLog -Destination ($guardianLog+'.previous') -Force
  }
  [IO.File]::AppendAllText($guardianLog,((@{at=(Get-Date).ToString('o');state=$State} | ConvertTo-Json -Compress)+[Environment]::NewLine))
}
try {
  while ($true) {
    try {
      if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data\autoconnect.disabled')) {
        Write-GuardianState 'manually_stopped'
      } else {
        $qqOpen = @(Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { (-not $config.qqExecutable -or $_.Path -eq $config.qqExecutable) }).Count -gt 0
        $codexOpen = @(Get-Process -Name Codex -ErrorAction SilentlyContinue).Count -gt 0
        $health = Get-BridgeHealth
        if ($health) {
          $failedHealth = 0
          $retrySeconds = 5
          if (-not $qqOpen) { Write-GuardianState 'waiting_qq' }
          elseif (-not $codexOpen) { Write-GuardianState 'waiting_codex' }
          elseif (-not $health.qqConnected) { Write-GuardianState 'waiting_qq_login_or_adapter' }
          elseif (-not $health.desktopConnected) { Write-GuardianState 'connecting_codex' }
          else { Write-GuardianState 'connected' }
        } elseif ($qqOpen -and $codexOpen) {
          $failedHealth++
          if (((Get-Date)-$lastStart).TotalSeconds -ge $retrySeconds) {
            # Kill only a hung Node service whose saved root AND command line match.
            $lockFile = Join-Path $PSScriptRoot 'data\service.lock'
            if (Test-Path -LiteralPath $lockFile) {
              $savedService = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
              $serviceProcess = Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$savedService.pid)
              if ($serviceProcess) {
                if ($failedHealth -lt 4) { Start-Sleep -Seconds 5; continue }
                if ($savedService.root -ne $PSScriptRoot -or $serviceProcess.Name -ne 'node.exe' -or -not $serviceProcess.CommandLine.Contains((Join-Path $PSScriptRoot 'qq-bridge.cjs'))) { throw 'Service process identity mismatch.' }
                Stop-Process -Id $serviceProcess.ProcessId
              }
            }
            $lastStart = Get-Date
            Write-GuardianState 'recovering_service'
            Start-BridgeService | Out-Null
            $retrySeconds = [Math]::Min(60,$retrySeconds*2)
          }
        } else { Write-GuardianState 'waiting_apps' }
      }
    } catch {
      # Keep messages token-free. Detailed service failures stay in its own log.
      Write-GuardianState 'retrying_connection'
    }
    Start-Sleep -Seconds 5
  }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }

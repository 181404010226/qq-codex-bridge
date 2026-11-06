$ErrorActionPreference = 'Stop'
function Get-BridgeNode {
  $bridgeNodeCandidates = @()
  $bundledNode = Join-Path $PSScriptRoot 'runtime\node\node.exe'
  if (Test-Path -LiteralPath $bundledNode) { $bridgeNodeCandidates += $bundledNode }
  $savedNode = Join-Path $PSScriptRoot 'data\node-path.txt'
  if (Test-Path -LiteralPath $savedNode) { $bridgeNodeCandidates += [IO.File]::ReadAllText($savedNode).Trim() }
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $bridgeNodeCandidates += $nodeCommand.Source }
  foreach ($bridgeNode in $bridgeNodeCandidates) {
    if (-not (Test-Path -LiteralPath $bridgeNode -PathType Leaf)) { continue }
    & $bridgeNode --no-warnings -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(2);require('node:sqlite');" 2>$null
    if ($LASTEXITCODE -eq 0) { return $bridgeNode }
  }
  throw 'Node.js 22.13+ is required.'
}
function Get-BridgeConfig { return Get-Content -LiteralPath (Join-Path $PSScriptRoot 'data\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
function Test-BridgePort([int]$Port) {
  $bridgeSocket = [Net.Sockets.TcpClient]::new()
  try { $pending = $bridgeSocket.BeginConnect('127.0.0.1', $Port, $null, $null); if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }; $bridgeSocket.EndConnect($pending); return $true }
  catch { return $false }
  finally { $bridgeSocket.Dispose() }
}
function Get-BridgeHealth {
  $bridgeConfig = Get-BridgeConfig
  try { $bridgeHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:'+$bridgeConfig.statusPort+'/health') -TimeoutSec 2 } catch { return $null }
  if ($bridgeHealth.app -ne 'qq-codex-bridge' -or $bridgeHealth.root -ne $PSScriptRoot) { throw 'The status port belongs to another application or bridge folder.' }
  return $bridgeHealth
}
function Get-BridgeIdentity {
  $bridgeHash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($bridgeHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant()))).Replace('-','').Substring(0,20) }
  finally { $bridgeHash.Dispose() }
}
function Invoke-BridgeStartup([scriptblock]$Operation) {
  $bridgeMutex = [Threading.Mutex]::new($false,('Local\QQCodexStartup-'+(Get-BridgeIdentity)))
  $bridgeOwned = $false
  try {
    try { $bridgeOwned = $bridgeMutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $bridgeOwned = $true }
    if (-not $bridgeOwned) { throw 'Another bridge startup is still running.' }
    & $Operation
  } finally { if ($bridgeOwned) { $bridgeMutex.ReleaseMutex() }; $bridgeMutex.Dispose() }
}
function Start-BridgeService {
  Invoke-BridgeStartup {
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data\autoconnect.disabled')) { return $null }
    $bridgeHealth = Get-BridgeHealth
    if ($bridgeHealth) { return $bridgeHealth }
    $bridgeConfig = Get-BridgeConfig
    if (Test-BridgePort $bridgeConfig.statusPort) { throw 'The status port is occupied.' }
    $bridgeNode = Get-BridgeNode
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data\node-path.txt'),$bridgeNode,[Text.UTF8Encoding]::new($false))
    $bridgeNodeArgs = '--no-warnings "' + (Join-Path $PSScriptRoot 'qq-bridge.cjs') + '"'
    Start-Process -FilePath $bridgeNode -ArgumentList $bridgeNodeArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\service.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data\service.stderr.log') | Out-Null
    for ($bridgeAttempt=0; $bridgeAttempt -lt 40; $bridgeAttempt++) {
      Start-Sleep -Milliseconds 250
      $bridgeHealth = Get-BridgeHealth
      if ($bridgeHealth) { return $bridgeHealth }
    }
    throw 'Bridge did not start. See data/service.stderr.log.'
  }
}
function Start-BridgeGuardian {
  $bridgePowerShell = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $bridgePowerShell)) { $bridgePowerShell = Join-Path $PSHOME 'pwsh.exe' }
  $bridgeGuardianArgs = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'guardian.ps1') + '"'
  Start-Process -FilePath $bridgePowerShell -ArgumentList $bridgeGuardianArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
}

param(
    [int]$Port = 32190,
    [int]$CdpPort = 9222
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectDirectory '.local'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 3
    if ($status.app -ne 'antigravity-wallpaper' -or $status.mode -ne 'cdp') {
        throw "Port $Port is already used by another service or a preview-only instance."
    }
    exit 0
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$cliArgs = @('src/cli.js', '--port', "$Port", '--cdp-port', "$CdpPort")
Start-Process -FilePath $nodePath -ArgumentList $cliArgs -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'service.log') -RedirectStandardError (Join-Path $logDirectory 'service-error.log')

param(
    [string]$Exe,
    [int]$Port = 32190,
    [int]$CdpPort = 9222,
    [string]$Proxy
)

$ErrorActionPreference = 'Stop'
$startScript = Join-Path $PSScriptRoot 'start-background.ps1'

& $startScript -Port $Port -CdpPort $CdpPort

if (-not $Exe) {
    $Exe = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
}

if (-not (Test-Path -LiteralPath $Exe)) {
    throw "Antigravity.exe not found at '$Exe'. Pass -Exe <path> to specify its location."
}

$launchArgs = @(
    "--remote-debugging-port=$CdpPort",
    '--remote-debugging-address=127.0.0.1'
)
if ($Proxy) {
    $launchArgs += "--proxy-server=$Proxy"
}

Start-Process -FilePath $Exe -ArgumentList $launchArgs

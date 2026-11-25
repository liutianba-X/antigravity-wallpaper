param(
    [string]$Exe,
    [int]$Port = 32190,
    [int]$CdpPort = 9222,
    [string]$Proxy,
    [string]$Steam,
    [string[]]$Library
)

$ErrorActionPreference = 'Stop'
$startScript = Join-Path $PSScriptRoot 'start-background.ps1'

$startParams = @{ Port = $Port; CdpPort = $CdpPort }
if ($Steam) { $startParams.Steam = $Steam }
if ($Library) { $startParams.Library = $Library }
& $startScript @startParams

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
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    $env:NO_PROXY = 'localhost,127.0.0.1'
}

Start-Process -FilePath $Exe -ArgumentList $launchArgs

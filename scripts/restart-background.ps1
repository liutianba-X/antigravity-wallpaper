param(
    [int]$Port = 32190,
    [int]$CdpPort = 9222,
    [string]$Steam,
    [string[]]$Library
)

$ErrorActionPreference = 'Stop'
$stopScript = Join-Path $PSScriptRoot 'stop-background.ps1'
$startScript = Join-Path $PSScriptRoot 'start-background.ps1'

& $stopScript -Port $Port

$startParams = @{ Port = $Port; CdpPort = $CdpPort }
if ($Steam) { $startParams.Steam = $Steam }
if ($Library) { $startParams.Library = $Library }
& $startScript @startParams

$deadline = (Get-Date).AddSeconds(5)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 1
        if ($status.app -eq 'antigravity-wallpaper') {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 200
    }
}

if (-not $ready) {
    throw "Wallpaper service did not respond on http://127.0.0.1:$Port after restart. Check .local/service-error.log."
}

Write-Host "Restarted wallpaper service on http://127.0.0.1:$Port."

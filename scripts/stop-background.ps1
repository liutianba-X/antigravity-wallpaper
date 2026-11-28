param(
    [int]$Port = 32190
)

$ErrorActionPreference = 'Stop'

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if (-not $listeners.Count) {
    Write-Host "Wallpaper service is not running on port $Port."
    exit 0
}

$isWallpaperService = $false
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 2
    if ($status.app -eq 'antigravity-wallpaper') {
        $isWallpaperService = $true
    }
} catch {
    # Fallback to command line check if HTTP status is temporarily unresponsive.
}

$stopped = @()
foreach ($pidToStop in $listeners) {
    if (-not $isWallpaperService) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue
        if (-not $proc -or $proc.CommandLine -notlike '*src/cli.js*') {
            throw "Port $Port is used by another process (PID $pidToStop). Refusing to stop it."
        }
    }
    Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
    $stopped += $pidToStop
}

$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline) {
    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $stillListening) { break }
    Start-Sleep -Milliseconds 150
}

Write-Host "Stopped wallpaper service on port $Port (PID: $($stopped -join ', '))."

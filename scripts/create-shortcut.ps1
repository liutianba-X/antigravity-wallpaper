param(
    [string]$Name = 'Antigravity (Wallpaper)',
    [string]$Exe,
    [int]$Port = 32190,
    [int]$CdpPort = 9222,
    [string]$Proxy,
    [string]$Steam,
    [string[]]$Library
)

$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$launchScript = Join-Path $PSScriptRoot 'launch.ps1'

if (-not $Exe) {
    $defaultExe = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'
    if (Test-Path -LiteralPath $defaultExe) {
        $Exe = $defaultExe
    }
}

$argParts = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', ('"' + $launchScript + '"'),
    '-Port', "$Port",
    '-CdpPort', "$CdpPort"
)
if ($Exe) {
    $argParts += @('-Exe', ('"' + $Exe + '"'))
}
if ($Proxy) {
    $argParts += @('-Proxy', ('"' + $Proxy + '"'))
}
if ($Steam) {
    $argParts += @('-Steam', ('"' + $Steam + '"'))
}
if ($Library) {
    $cleanLibs = @($Library | Where-Object { $_ })
    if ($cleanLibs.Count -gt 0) {
        $argParts += @('-Library', ('"' + ($cleanLibs -join ';') + '"'))
    }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = ($argParts -join ' ')
$shortcut.WorkingDirectory = $projectDirectory
$shortcut.WindowStyle = 7
$shortcut.Description = 'Launch Antigravity with local wallpaper service'
if ($Exe -and (Test-Path -LiteralPath $Exe)) {
    $shortcut.IconLocation = "$Exe,0"
}
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath"

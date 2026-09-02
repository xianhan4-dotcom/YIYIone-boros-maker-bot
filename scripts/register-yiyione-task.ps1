param(
    [string]$TaskName = "YIYIone-Boros-MakerBot",
    [string]$ProjectDir = "",
    [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
    $ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
}

if (-not $PythonPath) {
    $envPath = Join-Path $ProjectDir ".env"
    if (Test-Path -LiteralPath $envPath) {
        $configured = Get-Content -LiteralPath $envPath -Encoding UTF8 |
            Where-Object { $_ -match '^\s*BOROS_REAL_PYTHON_PATH\s*=\s*(.+?)\s*$' } |
            Select-Object -First 1
        if ($configured -and $configured -match '^\s*BOROS_REAL_PYTHON_PATH\s*=\s*(.+?)\s*$') {
            $PythonPath = $Matches[1].Trim()
        }
    }
}

if (-not $PythonPath) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $PythonPath = $pythonCommand.Source
    }
}

if (-not $PythonPath) {
    throw "Python interpreter not found. Set BOROS_REAL_PYTHON_PATH in .env or pass -PythonPath."
}

if (-not (Test-Path -LiteralPath $PythonPath)) {
    throw "Python interpreter not found: $PythonPath"
}
if (-not (Test-Path -LiteralPath $ProjectDir)) {
    throw "Project directory not found: $ProjectDir"
}
if ($PythonPath -match '[\\/]WindowsApps[\\/]python\.exe$') {
    throw "WindowsApps Python shim is not supported. Set BOROS_REAL_PYTHON_PATH to the real interpreter."
}

$action = New-ScheduledTaskAction `
    -Execute $PythonPath `
    -Argument "-m bot" `
    -WorkingDirectory $ProjectDir

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "YIYIone autonomous Boros maker-only bot. Critical risk writes bot/data/trading.lock.json." `
    -Force | Out-Null

Write-Host "Registered task: $TaskName"
Write-Host "Command: $PythonPath -m bot"
Write-Host "Working directory: $ProjectDir"

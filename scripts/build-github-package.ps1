param(
    [string]$PackageName = "YIYIone-boros-maker-bot",
    [string]$OutputDirectory = "release"
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
$stageRoot = [System.IO.Path]::GetFullPath((Join-Path $outputRoot $PackageName))
$zipPath = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ($PackageName + ".zip")))

if (-not $outputRoot.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must remain inside the project workspace."
}
if (-not $stageRoot.StartsWith(($outputRoot + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Staging directory must remain inside the selected output directory."
}

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

function Copy-FileSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$DestinationRelative
    )

    $sourcePath = Join-Path $projectRoot $Source
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Required source file missing: $sourcePath"
    }
    $destinationPath = Join-Path $stageRoot $DestinationRelative
    $destinationParent = Split-Path -Parent $destinationPath
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

function Copy-TreeSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$DestinationRelative,
        [string[]]$ExcludePatterns = @()
    )

    $sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $Source))
    if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        throw "Required source directory missing: $sourceRoot"
    }

    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
        $relative = $file.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/')
        $excluded = $false
        foreach ($pattern in $ExcludePatterns) {
            if ($relative -match $pattern) {
                $excluded = $true
                break
            }
        }
        if ($excluded) { continue }

        $destinationPath = Join-Path $stageRoot (Join-Path $DestinationRelative $relative)
        $destinationParent = Split-Path -Parent $destinationPath
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destinationPath -Force
    }
}

$rootFiles = @(
    "README.md",
    ".gitignore",
    ".env.example",
    "requirements.txt",
    "package.json",
    "package-lock.json",
    "tsconfig.json"
)
foreach ($file in $rootFiles) {
    Copy-FileSafe -Source $file -DestinationRelative $file
}

$commonExcludes = @(
    '(^|/)__pycache__(/|$)',
    '\.pyc$',
    '(^|/)node_modules(/|$)',
    '(^|/)\.env$',
    '\.log$',
    '\.db(?:-(?:wal|shm))?$'
)

Copy-TreeSafe -Source "bot" -DestinationRelative "bot" -ExcludePatterns ($commonExcludes + @(
    '(^|/)data/trading\.lock\.json$'
))
Copy-TreeSafe -Source "strategy" -DestinationRelative "strategy" -ExcludePatterns $commonExcludes
Copy-TreeSafe -Source "scripts" -DestinationRelative "scripts" -ExcludePatterns $commonExcludes
Copy-TreeSafe -Source ".github\agents" -DestinationRelative ".github\agents" -ExcludePatterns $commonExcludes

$docFiles = @(
    "docs\ARCHIVE_INTEGRATION.md",
    "docs\BOROS_MAKER_REWARD_MODEL.md",
    "docs\MCP_MIGRATION.md",
    "exports\Boros_PostOnly_Exit_Strategy.md"
)
foreach ($file in $docFiles) {
    if (Test-Path -LiteralPath (Join-Path $projectRoot $file)) {
        Copy-FileSafe -Source $file -DestinationRelative (Join-Path "docs" (Split-Path -Leaf $file))
    }
}

Copy-TreeSafe -Source "boros-bot" -DestinationRelative "node-strategy" -ExcludePatterns ($commonExcludes + @(
    '(^|/)old-versions(/|$)',
    '(^|/)bot-state\.json$',
    '(^|/)anomalies\.jsonl$',
    '(^|/)key-events\.csv$',
    '(^|/)start-(?:bot|btc|eth)\.ps1$'
))

$forbiddenNames = @('.env', 'bot-state.json', 'anomalies.jsonl', 'key-events.csv')
$forbidden = Get-ChildItem -LiteralPath $stageRoot -Recurse -File | Where-Object {
    $forbiddenNames -contains $_.Name -or
    $_.FullName -match '[\\/]node_modules[\\/]' -or
    $_.Extension -in @('.pyc', '.db', '.rar')
}
if ($forbidden) {
    throw "Forbidden files entered package: $($forbidden.FullName -join ', ')"
}

Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal

$fileCount = (Get-ChildItem -LiteralPath $stageRoot -Recurse -File | Measure-Object).Count
$zip = Get-Item -LiteralPath $zipPath
Write-Host "Package directory: $stageRoot"
Write-Host "Package archive:   $zipPath"
Write-Host "Files: $fileCount"
Write-Host "ZIP bytes: $($zip.Length)"

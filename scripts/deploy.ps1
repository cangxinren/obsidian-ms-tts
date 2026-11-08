param(
  [Parameter(Mandatory = $true)]
  [string]$Vault,
  [string]$PluginId = 'ms-tts-reader'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$source = $projectRoot
$destination = Join-Path $Vault ".obsidian\plugins\$PluginId"

if (-not (Test-Path (Join-Path $source 'main.js'))) {
  throw "main.js not found in $source. Run 'npm run build' first."
}

if (Test-Path $destination) {
  $backupRoot = Join-Path $env:LOCALAPPDATA 'ms-tts-reader\backups'
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $backup = Join-Path $backupRoot "$PluginId-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item -Path $destination -Destination $backup -Recurse
  Write-Host "Backed up existing plugin to $backup"
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null

foreach ($file in @('main.js', 'manifest.json', 'styles.css')) {
  $from = Join-Path $source $file
  if (Test-Path $from) {
    Copy-Item -Path $from -Destination (Join-Path $destination $file) -Force
    Write-Host "Copied $file"
  }
}

Write-Host "Installed to $destination"

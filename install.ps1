#requires -Version 5.1
<#
.SYNOPSIS
    Install the Obsidian Annex plugin into a vault's plugin folder.

.DESCRIPTION
    Copies the self-contained manifest.json + main.js into
    <VaultRoot>\.obsidian\plugins\obsidian-annex\ (created if missing).
    Idempotent: re-running overwrites the installed files.

.PARAMETER VaultRoot
    Absolute path to the Obsidian vault that should receive the plugin.

.EXAMPLE
    .\install.ps1 -VaultRoot "D:\MyVault"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultRoot,

    [string]$PluginId = 'obsidian-annex'
)

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$target = Join-Path $VaultRoot (Join-Path '.obsidian\plugins' $PluginId)

$files = @('manifest.json', 'main.js')

foreach ($f in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $f))) {
        throw "Missing source file: $(Join-Path $source $f)"
    }
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $source $f) -Destination (Join-Path $target $f) -Force
    Write-Host ("copied {0} -> {1}" -f $f, $target)
}

Write-Host "Obsidian Annex installed to $target"
Write-Host "Enable it under Settings > Community plugins (turn off Restricted mode if needed)."

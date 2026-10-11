#requires -Version 5.1
<#
.SYNOPSIS
    Install the Obsidian Annex plugin into a vault's plugin folder.

.DESCRIPTION
    Copies the self-contained manifest.json + main.js into
    <VaultRoot>\.obsidian\plugins\obsidian-annex\ (created if missing).
    Idempotent: re-running overwrites the installed files, removes a stale
    pointer.js left by older versions (the plugin is one file now), and removes
    the pre-rename `annex-bridge` folder so the vault does not end up with both.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -VaultRoot "D:\Vault"
#>
[CmdletBinding()]
param(
    [string]$VaultRoot = 'C:\Users\Aaron\Assistant',
    [string]$PluginId  = 'obsidian-annex'
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

# Older versions shipped a separate pointer.js; the plugin is one file now and
# Obsidian's renderer cannot resolve relative requires anyway.
$stale = Join-Path $target 'pointer.js'
if (Test-Path -LiteralPath $stale) {
    Remove-Item -LiteralPath $stale -Force
    Write-Host "removed stale pointer.js from $target"
}

# Pre-rename installs lived in a sibling folder; drop it so the vault does not
# carry two copies of the same plugin.
$staleDir = Join-Path (Split-Path $target -Parent) 'annex-bridge'
if (($staleDir -ne $target) -and (Test-Path -LiteralPath $staleDir)) {
    Remove-Item -LiteralPath $staleDir -Recurse -Force
    Write-Host "removed stale plugin folder $staleDir"
}

Write-Host "Obsidian Annex installed to $target"
Write-Host "Enable it under Settings > Community plugins."
Write-Host "After a rename you may need to re-enable the plugin in Obsidian."

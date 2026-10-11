#requires -Version 5.1
<#
.SYNOPSIS
    Install the Annex Bridge Obsidian plugin into a vault's plugin folder.

.DESCRIPTION
    Copies manifest.json, main.js and pointer.js into
    <VaultRoot>\.obsidian\plugins\annex-bridge\ (created if missing).
    Idempotent: re-running simply overwrites the installed files.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -VaultRoot "D:\Vault"
#>
[CmdletBinding()]
param(
    [string]$VaultRoot = 'C:\Users\Aaron\Assistant',
    [string]$PluginId  = 'annex-bridge'
)

$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$target = Join-Path $VaultRoot (Join-Path '.obsidian\plugins' $PluginId)

$files = @('manifest.json', 'main.js', 'pointer.js')

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

Write-Host "Annex Bridge installed to $target"
Write-Host "Enable it under Settings > Community plugins."

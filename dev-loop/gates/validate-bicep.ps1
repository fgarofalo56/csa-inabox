<#
.SYNOPSIS
    Validates all Bicep templates in the repository.

.DESCRIPTION
    Finds all .bicep files and runs bicep build to validate syntax and compilation.

    Exit codes:
      0 - every file compiled
      1 - at least one file failed to compile
      2 - COULD NOT RUN (bicep is not installed). This is deliberately distinct
          from 1: "the toolchain is absent" is not "your templates are broken",
          and validate-all.ps1 reports it as NOT VERIFIED rather than as a pass
          or a failure. See #3811.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot
)

# Resolved in the BODY, not in the param default: under Windows PowerShell 5.1
# $PSScriptRoot is empty inside a param default when the script carries
# [CmdletBinding()] AND is invoked with `powershell.exe -File`, so the old
# default died at parameter binding with "Cannot bind argument to parameter
# 'Path' because it is an empty string", producing no output at all.
# Measured on 5.1.26100.9168 vs pwsh 7.6.5 across four invocation modes: only
# that one combination breaks. `&`, dot-sourcing, -Command, every pwsh 7 mode,
# and a bare param() without [CmdletBinding()] all populate it correctly.
# Resolving in the BODY works in all of them. See #3811.
if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$ErrorActionPreference = 'Continue'
$errors = @()

# -WhatIf is HONOURED, not merely tolerated. apps/copilot/tools/readonly.py:551-559
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist, and
# no gate declared SupportsShouldProcess - so parameter binding failed and the
# tool returned RC=1 with EMPTY stdout on every host, for all five gates.
# Measured before this change:
#   [validate-bicep -WhatIf] RC=1 :: A parameter cannot be found that matches
#                                    parameter name 'WhatIf'.
# The $PSScriptRoot fix elsewhere in this file could not help that consumer:
# the script never reached its body. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0.
# A -WhatIf returning 0 would be quotable as a pass over an empty run, which is
# the exact defect this gate family exists to remove.
if ($WhatIfPreference) {
    Write-Host "=== Bicep Validation Gate (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would compile every *.bicep under: $RepoRoot"
    Write-Host "  (excluding node_modules, .venv, dbt-env and .claude/worktrees)"
    Write-Host "  Nothing was compiled and nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "=== Bicep Validation Gate ===" -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot"

# Check the toolchain BEFORE walking the tree. Without this the gate reports
# "N file(s) failed validation" for every file it never actually compiled,
# which is a false statement about the templates. It is also checked up front
# so a missing bicep costs a message instead of a full recursive walk.
if (-not (Get-Command bicep -ErrorAction SilentlyContinue)) {
    Write-Host "bicep not found in PATH - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Install: az bicep install   (or see https://aka.ms/bicep-install)" -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass and not a failure." -ForegroundColor Yellow
    exit 2
}

# Find all .bicep files.
# .claude/worktrees is excluded because Get-ChildItem -Recurse does NOT consult
# .gitignore: every agent worktree carries a full copy of the repo, so without
# this the walk found 50545 .bicep files against 351 tracked ones (~144x) and
# the gate became a multi-hour operation over abandoned branches. See #3811.
#
# temp/ is excluded for the mirror-image reason: it is gitignored scratch space
# that currently holds 353 stale .bicep copies against 351 tracked ones, so a
# broken template in an abandoned experiment would red `make validate` for an
# unrelated change. The gate judges the tree, not the scratchpad.
$bicepFiles = Get-ChildItem -Path $RepoRoot -Filter "*.bicep" -Recurse -File |
    Where-Object { $_.FullName -notmatch 'node_modules|\.venv|dbt-env|\.claude[\\/]worktrees|[\\/]temp[\\/]' }

Write-Host "Found $($bicepFiles.Count) Bicep files"

# Zero files is COULD NOT RUN, not a pass.
#
# The worktree exclusion above is correct but it made this gate silently
# vacuous in the one place every agent in this repo actually works: inside
# .claude/worktrees, $RepoRoot IS an excluded path, so the walk returned 0 files
# and the gate exited 0 - printing "Found 0 Bicep files / [PASS]" on a diff
# containing a broken .bicep, and letting validate-all report
# "All gates passed! (1 gate(s) measured.)". A gate that measured nothing must
# not be counted as a measurement; validate-dbt.ps1 made the same call for the
# same reason. See #3811.
if ($bicepFiles.Count -eq 0) {
    Write-Host "No Bicep files found under $RepoRoot - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Nothing was compiled, so this is NOT a pass." -ForegroundColor Yellow
    Write-Host "  If you are inside .claude/worktrees, that path is excluded from the walk:" -ForegroundColor Yellow
    Write-Host "  run this gate with -RepoRoot pointing at the main checkout to validate templates." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

foreach ($file in $bicepFiles) {
    $relativePath = $file.FullName.Replace($RepoRoot, '').TrimStart('\', '/')
    Write-Host "  Validating: $relativePath" -NoNewline

    try {
        $output = bicep build $file.FullName 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " [PASS]" -ForegroundColor Green
            # Clean up generated ARM template
            $armFile = [System.IO.Path]::ChangeExtension($file.FullName, '.json')
            if (Test-Path $armFile) {
                Remove-Item $armFile -Force
            }
        } else {
            Write-Host " [FAIL]" -ForegroundColor Red
            $errors += @{ File = $relativePath; Error = ($output | Out-String) }
        }
    } catch {
        Write-Host " [ERROR]" -ForegroundColor Red
        $errors += @{ File = $relativePath; Error = $_.Exception.Message }
    }
}

Write-Host ""
if ($errors.Count -gt 0) {
    Write-Host "=== VALIDATION FAILED ===" -ForegroundColor Red
    Write-Host "$($errors.Count) file(s) failed validation:"
    foreach ($err in $errors) {
        Write-Host "  - $($err.File): $($err.Error)" -ForegroundColor Yellow
    }
    exit 1
} else {
    Write-Host "=== ALL BICEP FILES VALID ===" -ForegroundColor Green
    exit 0
}

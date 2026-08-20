<#
.SYNOPSIS
    Orchestrates all validation gates.

.DESCRIPTION
    Runs all validation gate scripts and reports overall pass/fail.
    Detects which files changed and only runs relevant gates.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [switch]$RunAll
)

$ErrorActionPreference = 'Continue'
$gatesDir = Join-Path $PSScriptRoot ""
$results = @()

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CSA-in-a-Box Validation Gates" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Detect changed files
$changedFiles = @()
try {
    $changedFiles = git diff --name-only HEAD~1 2>$null
    if (-not $changedFiles) {
        $changedFiles = git diff --name-only --cached 2>$null
    }
} catch {
    Write-Host "Could not detect changed files, running all gates" -ForegroundColor Yellow
    $RunAll = $true
}

function ShouldRunGate {
    param([string[]]$Patterns)
    if ($RunAll) { return $true }
    foreach ($file in $changedFiles) {
        foreach ($pattern in $Patterns) {
            if ($file -like $pattern) { return $true }
        }
    }
    return $false
}

# Gate 1: Bicep
if (ShouldRunGate @("*.bicep", "deploy/bicep/*")) {
    Write-Host "Running: Bicep validation..." -ForegroundColor White
    & (Join-Path $gatesDir "validate-bicep.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Bicep"; Passed = ($LASTEXITCODE -eq 0) }
} else {
    Write-Host "Skipping: Bicep (no .bicep files changed)" -ForegroundColor DarkGray
}

# Gate 2: Python
if (ShouldRunGate @("*.py", "scripts/*", "domains/*")) {
    Write-Host "Running: Python validation..." -ForegroundColor White
    & (Join-Path $gatesDir "validate-python.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Python"; Passed = ($LASTEXITCODE -eq 0) }
} else {
    Write-Host "Skipping: Python (no .py files changed)" -ForegroundColor DarkGray
}

# Gate 3: dbt
if (ShouldRunGate @("*.sql", "domains/*/dbt/*", "dbt_project.yml")) {
    Write-Host "Running: dbt validation..." -ForegroundColor White
    & (Join-Path $gatesDir "validate-dbt.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "dbt"; Passed = ($LASTEXITCODE -eq 0) }
} else {
    Write-Host "Skipping: dbt (no dbt files changed)" -ForegroundColor DarkGray
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Validation Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$allPassed = $true
foreach ($r in $results) {
    $status = if ($r.Passed) { "[PASS]" } else { "[FAIL]"; $allPassed = $false }
    $color = if ($r.Passed) { "Green" } else { "Red" }
    Write-Host "  $($r.Gate): $status" -ForegroundColor $color
}

# A gate suite that ran NOTHING must not report a pass. $allPassed is
# initialised $true and is only ever moved by a gate that actually ran and
# failed, so an empty $results reaches the success branch below by default:
# "I measured nothing" and "everything passed" would otherwise print the same
# words and return the same exit code.
#
# That case is not rare. It is EVERY console-only, docs-only, workflow-only or
# script-only change, because dev-loop/gates has no TypeScript leg at all -
# there is no validate-typescript.ps1, and nothing here mentions the console.
# See #3811.
#
# Exit stays 0 deliberately. Exiting 1 would be a second false statement
# ("Some gates failed" is equally untrue) and would break docs-only loops.
# What changes is that the OUTPUT can no longer be quoted as a pass.
if ($results.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "NOT VERIFIED - 0 gates ran for this change." -ForegroundColor Yellow
    Write-Host "  This is NOT a pass. Nothing in this diff is covered by a gate in dev-loop/gates/." -ForegroundColor Yellow
    Write-Host "  Console changes are gated by fiab-console-ci (next build + vitest), not by this script." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
if ($allPassed) {
    Write-Host "All gates passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Some gates failed. Fix issues and re-run." -ForegroundColor Red
    exit 1
}

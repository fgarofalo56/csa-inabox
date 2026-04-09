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

Write-Host ""
if ($allPassed) {
    Write-Host "All gates passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Some gates failed. Fix issues and re-run." -ForegroundColor Red
    exit 1
}

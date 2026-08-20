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

# A gate has THREE possible outcomes, not two. Collapsing "could not run" into
# "passed" is the defect behind #3811 in its second form:
#
#   0     - the gate ran and found nothing wrong
#   2     - the gate COULD NOT RUN (its toolchain is absent, there was nothing
#           for it to check). By convention across dev-loop/gates.
#   $null - the gate SCRIPT could not be invoked at all. $LASTEXITCODE is not
#           written in that case, so this is only distinguishable because it is
#           reset to $null before each call below.
#   other - the gate ran and found a problem.
function GateStatus {
    param($Code)
    if ($null -eq $Code) { return 'NotRun' }
    if ($Code -eq 0)     { return 'Pass' }
    if ($Code -eq 2)     { return 'NotRun' }
    return 'Fail'
}

# Gate 1: Bicep
if (ShouldRunGate @("*.bicep", "deploy/bicep/*")) {
    Write-Host "Running: Bicep validation..." -ForegroundColor White
    # Reset BEFORE the call. $ErrorActionPreference is 'Continue', which makes a
    # CommandNotFoundException non-terminating - so if the gate script is
    # missing or renamed, $LASTEXITCODE is never written and retains the
    # PREVIOUS gate's value. A missing gate script inherited a stale 0 and
    # printed [PASS]. Measured, not assumed. See #3811.
    $LASTEXITCODE = $null
    & (Join-Path $gatesDir "validate-bicep.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Bicep"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Bicep (no .bicep files changed)" -ForegroundColor DarkGray
}

# Gate 2: Python
if (ShouldRunGate @("*.py", "scripts/*", "domains/*")) {
    Write-Host "Running: Python validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-python.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Python"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Python (no .py files changed)" -ForegroundColor DarkGray
}

# Gate 3: dbt
if (ShouldRunGate @("*.sql", "domains/*/dbt/*", "dbt_project.yml")) {
    Write-Host "Running: dbt validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-dbt.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "dbt"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: dbt (no dbt files changed)" -ForegroundColor DarkGray
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Validation Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$anyFailed = $false
$anyNotRun = $false
foreach ($r in $results) {
    switch ($r.Status) {
        'Pass'  { $label = "[PASS]";         $color = "Green" }
        'Fail'  { $label = "[FAIL]";         $color = "Red";    $anyFailed = $true }
        default { $label = "[NOT VERIFIED]"; $color = "Yellow"; $anyNotRun = $true }
    }
    Write-Host "  $($r.Gate): $label" -ForegroundColor $color
}

# A gate suite that ran NOTHING must not report a pass. The verdict below is
# driven by flags that only a gate which actually RAN can set, so an empty
# $results would otherwise fall through to the success branch by default:
# "I measured nothing" and "everything passed" would print the same words and
# return the same exit code.
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
if ($anyFailed) {
    Write-Host "Some gates failed. Fix issues and re-run." -ForegroundColor Red
    exit 1
} elseif ($anyNotRun) {
    # A gate that could not run is not a pass. Reported loudly, but exit stays
    # 0 for the same reason as the zero-gates case above: "Some gates failed"
    # would be a false statement about a gate that never ran.
    $notRunCount = @($results | Where-Object { $_.Status -eq 'NotRun' }).Count
    Write-Host "NOT FULLY VERIFIED - $notRunCount of $($results.Count) gate(s) could not run." -ForegroundColor Yellow
    Write-Host "  This is NOT a pass. See the gate output above for what is missing." -ForegroundColor Yellow
    exit 0
} else {
    Write-Host "All gates passed!" -ForegroundColor Green
    exit 0
}

<#
.SYNOPSIS
    Orchestrates all validation gates.

.DESCRIPTION
    Runs all validation gate scripts and reports overall pass/fail.
    Detects which files changed and only runs relevant gates.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot,
    [switch]$RunAll
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
$gatesDir = Join-Path $PSScriptRoot ""
$results = @()

# The gates this script has a call site for. Compared against config.yaml's
# validation_gates: block further down - see the drift check for why.
$invokedGates = @()

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CSA-in-a-Box Validation Gates" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -WhatIf is HONOURED, not merely tolerated. apps/copilot/tools/readonly.py:551-559
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist, and
# no gate declared SupportsShouldProcess - so parameter binding failed and the
# tool returned RC=1 with EMPTY stdout on every host, for all five gates.
# Measured before this change:
#   [validate-all -WhatIf] RC=1 :: A parameter cannot be found that matches
#                                  parameter name 'WhatIf'.
# The $PSScriptRoot fix above could not help that consumer: the script never
# reached its body. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0. It
# does not invoke any gate, so it cannot be quoted as a pass over an empty run.
if ($WhatIfPreference) {
    Write-Host "-WhatIf: would orchestrate the gates in dev-loop/gates/ against" -ForegroundColor White
    Write-Host "  repo root: $RepoRoot"
    Write-Host "  No gate was invoked. Nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

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
#
# `*.bicepparam` is here because config.yaml DECLARES it as a bicep trigger and
# this script ignored it. Measured on a change touching only
# platform/fiab/bicep/prod.bicepparam:
#     Skipping: Bicep (no .bicep files changed)
# while the registry said triggers: ["*.bicep", "*.bicepparam"]. A param file is
# half of what a template compiles from; skipping it is a coverage hole, and the
# drift check below could not see it because it reconciles NAMES only. See #3811.
$invokedGates += 'bicep'
if (ShouldRunGate @("*.bicep", "*.bicepparam", "deploy/bicep/*")) {
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
$invokedGates += 'python'
if (ShouldRunGate @("*.py", "scripts/*", "domains/*")) {
    Write-Host "Running: Python validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-python.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Python"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Python (no .py files changed)" -ForegroundColor DarkGray
}

# Gate 3: dbt
$invokedGates += 'dbt'
if (ShouldRunGate @("*.sql", "domains/*/dbt/*", "dbt_project.yml")) {
    Write-Host "Running: dbt validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-dbt.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "dbt"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: dbt (no dbt files changed)" -ForegroundColor DarkGray
}

# Gate 4: Deployment
#
# This gate has existed since the dev loop shipped. It was declared in
# config.yaml, documented, and asserted-to-exist by
# dev-loop/tests/integration-test.ps1 - and invoked by NOTHING. This
# orchestrator ran three gates and never mentioned it, so `make validate`
# never what-if'd a template. Wired up here; the drift check below is what
# stops it happening again. See #3811.
#
# The trigger is `deploy/bicep/*` ONLY - matching what config.yaml declares
# ("deploy/bicep/**"). It previously also carried "*.bicep" and "*.bicepparam",
# which fired this gate for any Loom template change: measured on a
# platform/fiab/bicep/prod.bicepparam-only diff, this ran a subscription-level
# ESLZ what-if that has nothing to do with the Loom deploy path. deploy/bicep is
# an adjacent ESLZ pipeline (DLZ/DMLZ), not where Loom deploys from.
$invokedGates += 'deployment'
if (ShouldRunGate @("deploy/bicep/*")) {
    Write-Host "Running: Deployment validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-deployment.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Deployment"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Deployment (no deploy/bicep files changed)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Registry drift: does dev-loop/config.yaml agree with what this script runs?
#
# config.yaml is DECORATIVE - nothing reads it. This orchestrator carries its
# own copy of the gate list AND its own copy of the trigger globs, and the two
# representations drifted silently for the entire life of the dev loop: that is
# exactly how `deployment` came to be declared, documented, exposed to the
# in-product Copilot, and invoked by nobody.
#
# The check below does not remove the duplication - driving the loop from
# config.yaml would, and is a larger change tracked separately. What it does is
# make the duplication LOUD: add a gate to one side only and the next run says
# so. See #3811.
# ---------------------------------------------------------------------------
$driftFound = $false
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) "config.yaml"

Write-Host ""
Write-Host "Checking gate registry (dev-loop/config.yaml) against invoked gates..." -ForegroundColor White

if (-not (Test-Path $configPath)) {
    Write-Host "  config.yaml not found at $configPath - drift NOT CHECKED." -ForegroundColor Yellow
    $driftFound = $true
} else {
    # Windows PowerShell 5.1 has no ConvertFrom-Yaml, so parse the one block
    # that matters. Gate names are the 2-space-indented keys directly under
    # `validation_gates:`; the block ends at the first line starting in column
    # 0. Nested keys (script:, triggers:, ...) sit at 4 spaces and cannot match.
    $declared = @()
    $inBlock = $false
    foreach ($line in (Get-Content $configPath -Encoding UTF8)) {
        if ($line -match '^validation_gates:') { $inBlock = $true; continue }
        if (-not $inBlock) { continue }
        if ($line -match '^\S') { break }
        if ($line -match '^  ([A-Za-z0-9_-]+):') { $declared += $Matches[1] }
    }

    # `all` IS this script. It is the orchestrator, not one of the gates it runs.
    $declared = @($declared | Where-Object { $_ -ne 'all' })

    if ($declared.Count -eq 0) {
        Write-Host "  No gates parsed out of config.yaml - drift NOT CHECKED." -ForegroundColor Yellow
        Write-Host "  Expected a 'validation_gates:' block with 2-space-indented gate names." -ForegroundColor Yellow
        $driftFound = $true
    } else {
        foreach ($g in @($declared | Where-Object { $invokedGates -notcontains $_ })) {
            Write-Host "  DRIFT: '$g' is declared in config.yaml but NEVER INVOKED by this script." -ForegroundColor Yellow
            $driftFound = $true
        }
        foreach ($g in @($invokedGates | Where-Object { $declared -notcontains $_ })) {
            Write-Host "  DRIFT: '$g' is invoked by this script but NOT DECLARED in config.yaml." -ForegroundColor Yellow
            $driftFound = $true
        }
        if (-not $driftFound) {
            # Deliberately narrow wording. This check reconciles gate NAMES and
            # nothing else - the TRIGGER globs live in two places too, and they
            # were measured disagreeing while this line still said "OK":
            #
            #   Skipping: Bicep (no .bicep files changed)   <- registry declares
            #                                                  *.bicepparam too
            #   Running: Deployment validation...           <- registry declares
            #                                                  deploy/bicep/**
            #   OK - 4 declared gate(s), all invoked.
            #
            # Both triggers are corrected above, but an unqualified "OK" would
            # still be quotable as "registry and orchestrator agree" on a future
            # divergence this check cannot see. So it says what it checked.
            Write-Host "  OK - $($declared.Count) declared gate name(s), all invoked (triggers NOT compared)." -ForegroundColor Green
        }
    }
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
    if ($driftFound) {
        Write-Host "  The gate registry also disagrees with this orchestrator - see the drift report above." -ForegroundColor Yellow
    }
    exit 0
}

Write-Host ""
if ($anyFailed) {
    Write-Host "Some gates failed. Fix issues and re-run." -ForegroundColor Red
    exit 1
} elseif ($anyNotRun -or $driftFound) {
    # A gate that could not run is not a pass, and neither is a gate registry
    # this script disagrees with. Reported loudly, but exit stays 0 for the same
    # reason as the zero-gates case above: "Some gates failed" would be a false
    # statement about a gate that never ran.
    if ($anyNotRun) {
        $notRunCount = @($results | Where-Object { $_.Status -eq 'NotRun' }).Count
        Write-Host "NOT FULLY VERIFIED - $notRunCount of $($results.Count) gate(s) could not run." -ForegroundColor Yellow
        Write-Host "  This is NOT a pass. See the gate output above for what is missing." -ForegroundColor Yellow
    }
    if ($driftFound) {
        Write-Host "NOT FULLY VERIFIED - the gate registry and this orchestrator disagree." -ForegroundColor Yellow
        Write-Host "  See the drift report above. A declared gate that nothing invokes measures nothing." -ForegroundColor Yellow
    }
    exit 0
} else {
    Write-Host "All gates passed!" -ForegroundColor Green
    exit 0
}

<#
.SYNOPSIS
    End-to-end integration test for the dev loop.

.DESCRIPTION
    Tests the Ralph loop workflow:
    1. Pick a task from Archon
    2. Execute validation gates
    3. Report results
    This is a dry-run test - it validates the dev loop machinery without deploying.
#>

[CmdletBinding()]
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

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Dev Loop Integration Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$testResults = @()
$testCount = 0
$passCount = 0

function Test-Assertion {
    param(
        [string]$Name,
        [scriptblock]$Test
    )

    $script:testCount++
    Write-Host "  TEST: $Name" -NoNewline

    try {
        $result = & $Test
        if ($result) {
            Write-Host " [PASS]" -ForegroundColor Green
            $script:passCount++
            $script:testResults += @{ Name = $Name; Status = "PASS" }
        } else {
            Write-Host " [FAIL]" -ForegroundColor Red
            $script:testResults += @{ Name = $Name; Status = "FAIL" }
        }
    } catch {
        Write-Host " [ERROR: $($_.Exception.Message)]" -ForegroundColor Red
        $script:testResults += @{ Name = $Name; Status = "ERROR" }
    }
}

# ---------------------------------------------------------------------------
# Test 1: Configuration
# ---------------------------------------------------------------------------
Write-Host "--- Configuration Tests ---" -ForegroundColor White

Test-Assertion "config.yaml exists" {
    Test-Path (Join-Path $PSScriptRoot "..\config.yaml")
}

Test-Assertion "config.yaml has loop: and validation_gates: blocks" {
    $configPath = Join-Path $PSScriptRoot "..\config.yaml"
    $content = Get-Content $configPath -Raw
    # (?m) is required and was missing. PowerShell's -match has no Multiline
    # option by default, so `^loop:` anchored at the start of the whole STRING -
    # and config.yaml opens with a comment line, so this assertion returned
    # False on every run since it was written. Measured against origin/main's
    # committed config.yaml as well as the working tree: False on both.
    #
    # It is the mirror image of the three gate assertions below, which could
    # never fail: this one could never pass. Same file, same root cause -
    # nobody read the result. See #3811.
    $content -match "(?m)^loop:" -and $content -match "(?m)^validation_gates:"
}

Test-Assertion "All gate scripts exist" {
    $gates = @("validate-bicep.ps1", "validate-python.ps1", "validate-dbt.ps1", "validate-all.ps1", "validate-deployment.ps1")
    $gatesDir = Join-Path $PSScriptRoot "..\gates"
    $allExist = $true
    foreach ($gate in $gates) {
        if (-not (Test-Path (Join-Path $gatesDir $gate))) {
            $allExist = $false
        }
    }
    $allExist
}

# ---------------------------------------------------------------------------
# Test 2: Validation Gates (Dry Run)
# ---------------------------------------------------------------------------
Write-Host "`n--- Validation Gate Tests ---" -ForegroundColor White

# These three assertions used to invoke a gate, capture its output into a
# variable nothing read, and `return $true` unconditionally - so they passed
# whatever the gate did, including not running at all. That is a test that
# cannot fail, and it went from harmless to actively misleading when the gates
# gained exit code 2: on a default clone (no bicep, no dbt) validate-bicep and
# validate-dbt now report NOT VERIFIED, and these tests kept printing [PASS]
# over the top of it. See #3811.
#
# The assertion is now on the exit code. 0/1/2 are the gate's declared codes;
# anything else - notably 1 from a parameter-binding failure that produced no
# output, or $null from a gate script that could not be invoked - fails.
# $LASTEXITCODE is reset to $null before each call for the same reason
# validate-all.ps1 does it: it is not written when the call itself fails, and
# would otherwise retain the PREVIOUS gate's value.
function Test-GateExitCode {
    param([string]$GateScript)

    $script:LASTEXITCODE = $null
    & (Join-Path $PSScriptRoot "..\gates\$GateScript") -RepoRoot $RepoRoot 2>&1 | Out-Null
    $code = $LASTEXITCODE
    if ($null -eq $code) {
        Write-Host " (gate did not set an exit code)" -NoNewline -ForegroundColor Yellow
        return $false
    }
    if ($code -notin 0, 1, 2) {
        Write-Host " (unexpected exit code $code)" -NoNewline -ForegroundColor Yellow
        return $false
    }
    return $true
}

Test-Assertion "Bicep validation gate exits 0, 1 or 2" {
    Test-GateExitCode "validate-bicep.ps1"
}

Test-Assertion "Python validation gate exits 0, 1 or 2" {
    Test-GateExitCode "validate-python.ps1"
}

Test-Assertion "dbt validation gate exits 0, 1 or 2" {
    Test-GateExitCode "validate-dbt.ps1"
}

# ---------------------------------------------------------------------------
# Test 3: Repository Structure
# ---------------------------------------------------------------------------
Write-Host "`n--- Repository Structure Tests ---" -ForegroundColor White

Test-Assertion "DLZ main.bicep exists" {
    Test-Path (Join-Path $RepoRoot "deploy/bicep/DLZ/main.bicep")
}

Test-Assertion "DMLZ main.bicep exists" {
    Test-Path (Join-Path $RepoRoot "deploy/bicep/DMLZ/main.bicep")
}

Test-Assertion "Shared dbt project exists" {
    Test-Path (Join-Path $RepoRoot "domains/shared/dbt/dbt_project.yml")
}

Test-Assertion "Sales domain exists" {
    Test-Path (Join-Path $RepoRoot "domains/sales/README.md")
}

Test-Assertion "Governance RBAC matrix exists" {
    Test-Path (Join-Path $RepoRoot "csa_platform/governance/rbac/rbac-matrix.json")
}

Test-Assertion "Data product template exists" {
    Test-Path (Join-Path $RepoRoot "templates/data-product/contract-template.json")
}

Test-Assertion ".editorconfig exists" {
    Test-Path (Join-Path $RepoRoot ".editorconfig")
}

Test-Assertion "pyproject.toml exists" {
    Test-Path (Join-Path $RepoRoot "pyproject.toml")
}

Test-Assertion "CI test workflow exists" {
    Test-Path (Join-Path $RepoRoot ".github/workflows/test.yml")
}

Test-Assertion "CODEOWNERS exists" {
    Test-Path (Join-Path $RepoRoot ".github/CODEOWNERS")
}

# ---------------------------------------------------------------------------
# Test 4: Task Templates
# ---------------------------------------------------------------------------
Write-Host "`n--- Task Template Tests ---" -ForegroundColor White

Test-Assertion "Task templates file exists" {
    Test-Path (Join-Path $PSScriptRoot "..\task-templates\templates.json")
}

Test-Assertion "Task templates is valid JSON" {
    $path = Join-Path $PSScriptRoot "..\task-templates\templates.json"
    $null -ne (Get-Content $path -Raw | ConvertFrom-Json)
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Integration Test Results" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Total:  $testCount"
Write-Host "  Passed: $passCount" -ForegroundColor Green
$failCount = $testCount - $passCount
if ($failCount -gt 0) {
    Write-Host "  Failed: $failCount" -ForegroundColor Red
}

Write-Host ""
if ($failCount -eq 0) {
    Write-Host "All tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Some tests failed:" -ForegroundColor Red
    $testResults | Where-Object { $_.Status -ne "PASS" } | ForEach-Object {
        Write-Host "  - $($_.Name): $($_.Status)" -ForegroundColor Red
    }
    exit 1
}

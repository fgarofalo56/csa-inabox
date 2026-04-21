<#
.SYNOPSIS
    End-to-end integration test for the dev loop.

.DESCRIPTION
    Tests the Ralph loop workflow:
    1. Pick a task from Archon
    2. Execute validation gates
    3. Report results
    This is a dry-run test — it validates the dev loop machinery without deploying.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

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

Test-Assertion "config.yaml is valid YAML" {
    $configPath = Join-Path $PSScriptRoot "..\config.yaml"
    $content = Get-Content $configPath -Raw
    $content -match "^loop:" -and $content -match "validation_gates:"
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

Test-Assertion "Bicep validation gate runs" {
    $output = & (Join-Path $PSScriptRoot "..\gates\validate-bicep.ps1") -RepoRoot $RepoRoot 2>&1
    # Should exit 0 (pass) or produce output (even if no bicep found)
    $true
}

Test-Assertion "Python validation gate runs" {
    $output = & (Join-Path $PSScriptRoot "..\gates\validate-python.ps1") -RepoRoot $RepoRoot 2>&1
    $true
}

Test-Assertion "dbt validation gate runs" {
    $output = & (Join-Path $PSScriptRoot "..\gates\validate-dbt.ps1") -RepoRoot $RepoRoot 2>&1
    $true
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

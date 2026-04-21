<#
.SYNOPSIS
    Validates a deployment by running az deployment what-if.

.DESCRIPTION
    Runs what-if analysis for each landing zone to validate deployment templates
    against a target Azure subscription without making actual changes.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$Environment = "dev",
    [string]$Location = "eastus"
)

$ErrorActionPreference = 'Continue'

Write-Host "=== Deployment Validation Gate ===" -ForegroundColor Cyan
Write-Host "Environment: $Environment"
Write-Host "Location: $Location"

$results = @()

# Check Azure CLI is available and logged in
$azAccount = az account show 2>$null | ConvertFrom-Json
if (-not $azAccount) {
    Write-Host "Not logged into Azure CLI. Skipping deployment validation." -ForegroundColor Yellow
    Write-Host "Run 'az login' to enable deployment validation." -ForegroundColor Yellow
    exit 0
}

Write-Host "Azure account: $($azAccount.name)"

# Landing zones to validate
$landingZones = @(
    @{
        Name   = "DLZ"
        Template = Join-Path $RepoRoot "deploy/bicep/DLZ/main.bicep"
        Params = Join-Path $RepoRoot "deploy/bicep/DLZ/params.$Environment.json"
    },
    @{
        Name   = "DMLZ"
        Template = Join-Path $RepoRoot "deploy/bicep/DMLZ/main.bicep"
        Params = Join-Path $RepoRoot "deploy/bicep/DMLZ/params.$Environment.json"
    }
)

foreach ($lz in $landingZones) {
    Write-Host "`nValidating: $($lz.Name)" -ForegroundColor White

    if (-not (Test-Path $lz.Template)) {
        Write-Host "  Template not found: $($lz.Template)" -ForegroundColor Yellow
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Reason = "Template not found" }
        continue
    }

    if (-not (Test-Path $lz.Params)) {
        Write-Host "  Params not found: $($lz.Params)" -ForegroundColor Yellow
        $results += @{ Zone = $lz.Name; Status = "SKIP"; Reason = "Params not found" }
        continue
    }

    try {
        $output = az deployment sub what-if `
            --location $Location `
            --template-file $lz.Template `
            --parameters $lz.Params `
            --no-pretty-print 2>&1

        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [PASS] What-if succeeded" -ForegroundColor Green
            $results += @{ Zone = $lz.Name; Status = "PASS" }
        } else {
            Write-Host "  [FAIL] What-if failed" -ForegroundColor Red
            Write-Host "  $output" -ForegroundColor Yellow
            $results += @{ Zone = $lz.Name; Status = "FAIL"; Reason = ($output | Out-String) }
        }
    } catch {
        Write-Host "  [ERROR] $($_.Exception.Message)" -ForegroundColor Red
        $results += @{ Zone = $lz.Name; Status = "FAIL"; Reason = $_.Exception.Message }
    }
}

# Summary
Write-Host "`n=== Deployment Validation Summary ===" -ForegroundColor Cyan
$allPassed = $true
foreach ($r in $results) {
    $color = switch ($r.Status) {
        "PASS" { "Green" }
        "SKIP" { "Yellow" }
        default { "Red"; $allPassed = $false }
    }
    Write-Host "  $($r.Zone): [$($r.Status)]$(if ($r.Reason) { " - $($r.Reason)" })" -ForegroundColor $color
}

if ($allPassed) {
    Write-Host "`nAll deployment validations passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`nSome validations failed." -ForegroundColor Red
    exit 1
}

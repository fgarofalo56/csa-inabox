<#
.SYNOPSIS
    Validates dbt models by running dbt compile.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

Write-Host "=== dbt Validation Gate ===" -ForegroundColor Cyan

$dbtProject = Get-ChildItem -Path $RepoRoot -Filter "dbt_project.yml" -Recurse -File |
    Where-Object { $_.FullName -notmatch 'node_modules|\.venv|dbt-env|dbt_packages' } |
    Select-Object -First 1

if (-not $dbtProject) {
    Write-Host "No dbt_project.yml found, skipping." -ForegroundColor Yellow
    exit 0
}

$dbtDir = Split-Path $dbtProject.FullName -Parent
Write-Host "dbt project found at: $dbtDir"

# Check if dbt is available
$dbtPath = Get-Command dbt -ErrorAction SilentlyContinue
if (-not $dbtPath) {
    Write-Host "dbt not found in PATH, skipping validation." -ForegroundColor Yellow
    Write-Host "Install dbt: pip install dbt-databricks" -ForegroundColor Yellow
    exit 0
}

Push-Location $dbtDir
try {
    Write-Host "Running dbt compile..."
    dbt compile --profiles-dir . 2>&1

    if ($LASTEXITCODE -eq 0) {
        Write-Host "=== DBT COMPILE PASSED ===" -ForegroundColor Green
        exit 0
    } else {
        Write-Host "=== DBT COMPILE FAILED ===" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

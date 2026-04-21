<#
.SYNOPSIS
    Validates Python code using ruff linter.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

Write-Host "=== Python Validation Gate ===" -ForegroundColor Cyan

# Check if ruff is available
$ruffPath = Get-Command ruff -ErrorAction SilentlyContinue
if (-not $ruffPath) {
    Write-Host "ruff not found, installing..." -ForegroundColor Yellow
    pip install ruff --quiet 2>$null
}

Write-Host "Running ruff lint on Python files..."
$pythonDirs = @("scripts", "domains", "tools", "governance", "dev-loop") |
    ForEach-Object { Join-Path $RepoRoot $_ } |
    Where-Object { Test-Path $_ }

if ($pythonDirs.Count -eq 0) {
    Write-Host "No Python directories found, skipping." -ForegroundColor Yellow
    exit 0
}

ruff check $pythonDirs --select E,F,W --ignore E501

if ($LASTEXITCODE -eq 0) {
    Write-Host "=== PYTHON LINT PASSED ===" -ForegroundColor Green
    exit 0
} else {
    Write-Host "=== PYTHON LINT FAILED ===" -ForegroundColor Red
    exit 1
}

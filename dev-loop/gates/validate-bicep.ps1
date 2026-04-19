<#
.SYNOPSIS
    Validates all Bicep templates in the repository.

.DESCRIPTION
    Finds all .bicep files and runs bicep build to validate syntax and compilation.
    Returns exit code 0 on success, 1 on any failure.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Continue'
$errors = @()

Write-Host "=== Bicep Validation Gate ===" -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot"

# Find all .bicep files
$bicepFiles = Get-ChildItem -Path $RepoRoot -Filter "*.bicep" -Recurse -File |
    Where-Object { $_.FullName -notmatch 'node_modules|\.venv|dbt-env' }

Write-Host "Found $($bicepFiles.Count) Bicep files"

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

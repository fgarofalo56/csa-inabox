<#
.SYNOPSIS
    Validates all Bicep templates in the repository.

.DESCRIPTION
    Finds all .bicep files and runs bicep build to validate syntax and compilation.

    Exit codes:
      0 - every file compiled
      1 - at least one file failed to compile
      2 - COULD NOT RUN (bicep is not installed). This is deliberately distinct
          from 1: "the toolchain is absent" is not "your templates are broken",
          and validate-all.ps1 reports it as NOT VERIFIED rather than as a pass
          or a failure. See #3811.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Continue'
$errors = @()

Write-Host "=== Bicep Validation Gate ===" -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot"

# Check the toolchain BEFORE walking the tree. Without this the gate reports
# "N file(s) failed validation" for every file it never actually compiled,
# which is a false statement about the templates. It is also checked up front
# so a missing bicep costs a message instead of a full recursive walk.
if (-not (Get-Command bicep -ErrorAction SilentlyContinue)) {
    Write-Host "bicep not found in PATH - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Install: az bicep install   (or see https://aka.ms/bicep-install)" -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass and not a failure." -ForegroundColor Yellow
    exit 2
}

# Find all .bicep files.
# .claude/worktrees is excluded because Get-ChildItem -Recurse does NOT consult
# .gitignore: every agent worktree carries a full copy of the repo, so without
# this the walk found 50545 .bicep files against 351 tracked ones (~144x) and
# the gate became a multi-hour operation over abandoned branches. See #3811.
$bicepFiles = Get-ChildItem -Path $RepoRoot -Filter "*.bicep" -Recurse -File |
    Where-Object { $_.FullName -notmatch 'node_modules|\.venv|dbt-env|\.claude[\\/]worktrees' }

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

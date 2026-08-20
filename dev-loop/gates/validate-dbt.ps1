<#
.SYNOPSIS
    Validates dbt models by running dbt compile.

.DESCRIPTION
    Exit codes:
      0 - dbt compile succeeded
      1 - dbt compile failed
      2 - COULD NOT RUN (no dbt project found, or dbt is not installed).
          Previously both of those returned 0, which validate-all.ps1 printed
          as "dbt: [PASS]" - so on any machine without dbt (which is the
          default clone: dbt is in neither `make setup` nor `make setup-all`)
          this gate reported a pass having compiled nothing. See #3811.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

Write-Host "=== dbt Validation Gate ===" -ForegroundColor Cyan

# Toolchain check FIRST, before the recursive walk. The walk below is a
# full-tree enumeration; on a developer machine carrying agent worktrees that
# is tens of thousands of directories, and it is pure waste when dbt is absent
# and the answer is exit 2 either way. Same ordering as validate-bicep.ps1.
$dbtPath = Get-Command dbt -ErrorAction SilentlyContinue
if (-not $dbtPath) {
    Write-Host "dbt not found in PATH - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Install dbt: pip install dbt-databricks" -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

# .claude/worktrees is excluded because Get-ChildItem -Recurse does NOT consult
# .gitignore. Without it this gate selected a stale copy of domains/doj from an
# abandoned agent worktree rather than the project in the repo. See #3811.
$dbtProjects = @(Get-ChildItem -Path $RepoRoot -Filter "dbt_project.yml" -Recurse -File |
    Where-Object { $_.FullName -notmatch 'node_modules|\.venv|dbt-env|dbt_packages|\.claude[\\/]worktrees' })

if ($dbtProjects.Count -eq 0) {
    Write-Host "No dbt_project.yml found - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

$dbtProject = $dbtProjects[0]

# Honest about scope: this gate compiles ONE project. Which one depends on
# filesystem walk order, which is not stable across machines. Compiling all of
# them is a real change in what runs and is tracked separately on #3811.
if ($dbtProjects.Count -gt 1) {
    Write-Host "WARNING: $($dbtProjects.Count) dbt projects found; this gate validates only the first." -ForegroundColor Yellow
    Write-Host "  A pass here is a statement about 1 of $($dbtProjects.Count) projects. See #3811." -ForegroundColor Yellow
}

$dbtDir = Split-Path $dbtProject.FullName -Parent
Write-Host "dbt project found at: $dbtDir"

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

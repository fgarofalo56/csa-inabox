<#
.SYNOPSIS
    Validates Python code using ruff linter.

.DESCRIPTION
    Exit codes:
      0 - ruff reported no findings
      1 - ruff reported findings
      2 - COULD NOT RUN (ruff unavailable, or no Python directories present).

    NOTE ON SCOPE: this gate lints scripts, domains, tools, governance and
    dev-loop - 37 of the repo's 762 tracked .py files - and its command-line
    --select overrides the larger rule set in pyproject.toml. A pass here is
    not a statement about the repo's Python. Tracked on #3811.
#>

[CmdletBinding(SupportsShouldProcess)]
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

# -WhatIf is HONOURED, not merely tolerated. apps/copilot/tools/readonly.py:551-559
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist, and
# no gate declared SupportsShouldProcess - so parameter binding failed and the
# tool returned RC=1 with EMPTY stdout on every host, for all five gates.
# Measured before this change:
#   [validate-python -WhatIf] RC=1 :: A parameter cannot be found that matches
#                                     parameter name 'WhatIf'.
# The $PSScriptRoot fix above could not help that consumer: the script never
# reached its body. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0.
if ($WhatIfPreference) {
    Write-Host "=== Python Validation Gate (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would install ruff if absent, then lint the gate's scoped"
    Write-Host "  directories under: $RepoRoot"
    Write-Host "  Nothing was linted and nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "=== Python Validation Gate ===" -ForegroundColor Cyan

# Check if ruff is available
$ruffPath = Get-Command ruff -ErrorAction SilentlyContinue
if (-not $ruffPath) {
    Write-Host "ruff not found, installing..." -ForegroundColor Yellow
    pip install ruff --quiet 2>$null
    # Re-check rather than assuming the install worked. Without this, a failed
    # install left ruff unresolvable, the ruff call below threw a
    # non-terminating CommandNotFoundException under the default
    # ErrorActionPreference, and $LASTEXITCODE kept pip's stale 0 - printing
    # "=== PYTHON LINT PASSED ===" for a lint that never ran. See #3811.
    $ruffPath = Get-Command ruff -ErrorAction SilentlyContinue
    if (-not $ruffPath) {
        Write-Host "ruff still not available after install attempt - CANNOT VALIDATE." -ForegroundColor Yellow
        Write-Host "  Install manually: pip install ruff" -ForegroundColor Yellow
        Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
        exit 2
    }
}

Write-Host "Running ruff lint on Python files..."
$pythonDirs = @(@("scripts", "domains", "tools", "governance", "dev-loop") |
    ForEach-Object { Join-Path $RepoRoot $_ } |
    Where-Object { Test-Path $_ })

if ($pythonDirs.Count -eq 0) {
    Write-Host "No Python directories found - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

try {
    ruff check $pythonDirs --select E,F,W --ignore E501
} catch {
    Write-Host "ruff could not be executed - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
    exit 2
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "=== PYTHON LINT PASSED ===" -ForegroundColor Green
    exit 0
} else {
    Write-Host "=== PYTHON LINT FAILED ===" -ForegroundColor Red
    exit 1
}

<#
.SYNOPSIS
    Validates Python code using ruff linter.

.DESCRIPTION
    Exit codes:
      0 - ruff reported no findings
      1 - ruff reported findings
      2 - COULD NOT RUN (ruff unavailable, or no Python directories present).

    SCOPE: this gate lints scripts, domains, tools, governance, dev-loop and
    csa_platform under pyproject.toml's rule set - 207 of the repo's 762
    tracked .py files. That is the SAME population and the SAME rules CI
    already enforces (`ruff check domains/ scripts/ csa_platform/ tools/` in
    test.yml:219 and validate.yml:267), plus dev-loop and governance, which
    hold no tracked .py today.

    It got there from 37 files and a weakened rule set. csa_platform - 170
    files, the core platform package - was linted by CI on every push and by
    NOTHING in `make validate`, while the orchestrator's trigger fired this
    gate for any *.py anywhere. So a csa_platform-only change selected the
    gate, was never examined by it, and the suite printed "All gates passed!".
    A trigger wider than the check population does not merely leave a gap; it
    manufactures a positive. Both sides are now the same list, and
    validate-all.ps1's Gate 2 trigger is commented to keep them that way.

    The command line no longer carries `--select E,F,W --ignore E501`, which
    overrode the 22 rule families pyproject.toml selects. Measured free:
    `ruff check scripts domains tools csa_platform dev-loop` under the
    pyproject rules is RC=0 on the tree as it stands.

    STILL NOT COVERED: the other 555 tracked .py files - examples (189),
    apps (180), portal (58), tests (56), azure-functions (20), cli (18),
    sdk (16) and the stragglers. `make lint` already spans portal and
    examples and is RED there: 758 findings under the pyproject rules, 196
    even under the old weak ones. That is a debt-paydown project, not this
    gate's to absorb - absorbing it would red every unrelated change over
    debt this gate did not create. Those trees are gated by test.yml /
    validate.yml / sdk-contract.yml, not by `make validate`, and a .py change
    confined to them selects NO gate and exits 3 NOT VERIFIED rather than a
    green it did not earn. See #3811.
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
# THIS LIST IS HALF OF A PAIR. validate-all.ps1's Gate 2 trigger is the other
# half, and the two must stay identical: a directory here but not there is a
# coverage hole, a directory there but not here manufactures a PASS over a file
# nothing examined. `governance` is absent from the tree and Test-Path drops it;
# it stays listed on both sides so creating it does not silently open either
# hole. See #3811.
$pythonDirs = @(@("scripts", "domains", "tools", "governance", "dev-loop", "csa_platform") |
    ForEach-Object { Join-Path $RepoRoot $_ } |
    Where-Object { Test-Path $_ })

if ($pythonDirs.Count -eq 0) {
    Write-Host "No Python directories found - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

try {
    # No `--select E,F,W --ignore E501`. That override replaced the 22 rule
    # families pyproject.toml selects with three, so the gate and CI graded the
    # same files differently and `make validate` was the more lenient of the
    # two. Dropping it was measured free: RC=0 over every directory above.
    ruff check $pythonDirs
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

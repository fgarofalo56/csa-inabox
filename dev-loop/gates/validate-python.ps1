<#
.SYNOPSIS
    Validates Python code using ruff linter.

.DESCRIPTION
    Exit codes:
      0 - ruff reported no findings
      1 - ruff reported findings, or the population contract is broken
      2 - COULD NOT RUN (python, git or ruff unavailable; empty population).

    SCOPE, AND WHY IT IS NOT DEFINED HERE. The population this gate lints is
    declared once, in scripts/ci/python_lint_scope.py, and BOTH halves of the
    gate derive from it: this script lints it, and validate-all.ps1's Gate 2
    trigger is asserted against it on every run via -TriggerGlobs. There is no
    edit that widens one side without the other.

    That indirection is the fix, not decoration. #3811 was filed because the
    trigger fired for all 762 tracked .py while the check read a small fraction
    of them. Narrowing the trigger to six directories closed most of it and left
    NINE files behind, because the two sides were still computed by two
    different methods:

      TRIGGER  = git's view      - tracked files under those directories
      CHECK    = ruff's view     - files ruff finds by WALKING those directories

    .gitignore:34 contains `data/`, ruff respects gitignore, and so ruff's walk
    skipped scripts/data/ entirely. Measured on this tree:

      ruff check scripts domains tools csa_platform dev-loop            -> RC=0
      ruff check scripts domains tools csa_platform dev-loop \
        --no-respect-gitignore                                          -> RC=1,
                                                                    216 errors

    Nine tracked files, 216 findings, 10 of them F401 unused-import, in the
    gate's own headline directory, reported as a PASS. The gate fired for a
    change to one of them and then read a different, clean set of files.

    So this script no longer names directories on a ruff command line. The
    module hands ruff EXPLICIT tracked paths - which ruff opens regardless of
    gitignore - and asserts, every run, that ruff actually opened every one of
    them. The 216 are held per file by a ratchet (#3990) and printed on every
    run; they can no longer grow, and they can no longer hide.

    The command line carries no `--select E,F,W --ignore E501`. That override
    replaced the 22 rule families pyproject.toml selects with three, so the gate
    and CI graded the same files differently and `make validate` was the more
    lenient of the two. .github/workflows/test.yml and validate.yml now call the
    same module, so the two populations cannot disagree again either.

    STILL NOT COVERED: tracked .py outside those directories - examples, apps,
    portal, tests, azure-functions, cli, sdk. `make lint` already spans portal
    and examples and is RED there (758 findings under the pyproject rules), so
    absorbing them here would red every unrelated change over debt this gate did
    not create. Those trees are gated by test.yml / validate.yml /
    sdk-contract.yml, and a .py change confined to them selects NO gate and
    exits 3 NOT VERIFIED rather than a green it did not earn. The live counts
    are printed by every run of this gate - read those, not a number in a
    comment. See #3811.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot,

    # The globs validate-all.ps1 matched to SELECT this gate. Supplied, they are
    # asserted to describe exactly the population below; a mismatch in either
    # direction is a hard failure. Omitted (a bare `make validate-python`), the
    # population contract is still enforced - only the orchestrator-side half of
    # the pair is unprovable, and that is stated rather than assumed.
    [string[]]$TriggerGlobs
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
$toolRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $RepoRoot) {
    $RepoRoot = $toolRoot
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
    Write-Host "  Would install ruff if absent, then lint every tracked .py/.ipynb under"
    Write-Host "  the directories declared in scripts/ci/python_lint_scope.py, within: $RepoRoot"
    Write-Host "  Nothing was linted and nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "=== Python Validation Gate ===" -ForegroundColor Cyan

# The scope module is TOOLING, so it is resolved against this script's own
# checkout - NOT against -RepoRoot, which is the SUBJECT being linted and may be
# a synthetic repo built by gate-selftest.ps1 that contains no scripts/ at all.
$scopeScript = Join-Path $toolRoot "scripts/ci/python_lint_scope.py"
if (-not (Test-Path $scopeScript)) {
    Write-Host "scripts/ci/python_lint_scope.py not found under $toolRoot - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  It defines the population this gate lints; without it the scope is UNKNOWN." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

# `python` first: on this estate `python3` resolves to the Microsoft Store shim,
# which exits 9009 with a "Python was not found" banner rather than running
# anything. `python3` is still tried second for Linux CI hosts and containers.
$pythonExe = $null
foreach ($candidate in @('python', 'python3')) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($found) { $pythonExe = $found.Source; break }
}
if (-not $pythonExe) {
    Write-Host "python not found - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

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

$scopeArgs = @($scopeScript, '--repo-root', $RepoRoot)
if ($PSBoundParameters.ContainsKey('TriggerGlobs')) {
    # Even an EMPTY -TriggerGlobs is asserted: an empty trigger against a
    # non-empty check is a coverage hole, and passing @() must red rather than
    # skip the assertion. Hence ContainsKey, not a truthiness test.
    $scopeArgs += '--assert-trigger-globs'
    $scopeArgs += @($TriggerGlobs)
} else {
    Write-Host "  (invoked without -TriggerGlobs: the population contract is checked," -ForegroundColor DarkGray
    Write-Host "   the orchestrator's trigger is not. validate-all.ps1 supplies it.)" -ForegroundColor DarkGray
}

try {
    $global:LASTEXITCODE = $null
    & $pythonExe @scopeArgs
    $scopeExit = $global:LASTEXITCODE
} catch {
    Write-Host "python_lint_scope.py could not be executed - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
    exit 2
}

# $null means the process never launched, which is NOT a pass and NOT a
# failure - it is the third outcome. Collapsing it into either is the defect
# GateStatus in validate-all.ps1 exists to prevent.
if ($null -eq $scopeExit) {
    Write-Host "python_lint_scope.py did not report an exit code - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

if ($scopeExit -eq 0) {
    Write-Host "=== PYTHON LINT PASSED ===" -ForegroundColor Green
    exit 0
} elseif ($scopeExit -eq 2) {
    Write-Host "=== PYTHON LINT COULD NOT RUN ===" -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
} else {
    Write-Host "=== PYTHON LINT FAILED ===" -ForegroundColor Red
    exit 1
}

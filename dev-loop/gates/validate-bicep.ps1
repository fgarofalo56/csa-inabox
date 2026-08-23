<#
.SYNOPSIS
    Validates all Bicep templates in the repository.

.DESCRIPTION
    Finds all .bicep files and runs bicep build to validate syntax and compilation.

    Compilation output goes to a scratch directory OUTSIDE the repository. The
    gate never writes into the tree it is judging, so it never has to delete
    anything from it either. See #3894.

    Exit codes:
      0 - every file in a NON-EMPTY population compiled
      1 - at least one file failed to compile
      2 - COULD NOT RUN. This is deliberately distinct from 1 - "nothing was
          measured" is not "your templates are broken" - and validate-all.ps1
          reports it as NOT VERIFIED rather than as a pass or a failure.
          Two causes, each with its own message:
            * the toolchain is absent (bicep is not installed)   - see #3811
            * ZERO POPULATION: the walk matched no file to compile - see #3894
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

$ErrorActionPreference = 'Continue'
$errors = @()

# -WhatIf is HONOURED, not merely tolerated. apps/copilot/tools/readonly.py:551-559
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist, and
# no gate declared SupportsShouldProcess - so parameter binding failed and the
# tool returned RC=1 with EMPTY stdout on every host, for all five gates.
# Measured before this change:
#   [validate-bicep -WhatIf] RC=1 :: A parameter cannot be found that matches
#                                    parameter name 'WhatIf'.
# The $PSScriptRoot fix elsewhere in this file could not help that consumer:
# the script never reached its body. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0.
# A -WhatIf returning 0 would be quotable as a pass over an empty run, which is
# the exact defect this gate family exists to remove.
if ($WhatIfPreference) {
    Write-Host "=== Bicep Validation Gate (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would compile every *.bicep under: $RepoRoot"
    Write-Host "  (excluding node_modules, .venv, dbt-env, temp and any NESTED .claude/worktrees)"
    Write-Host "  Compilation output would go to a scratch directory outside the repo."
    Write-Host "  Nothing was compiled and nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "=== Bicep Validation Gate ===" -ForegroundColor Cyan

# RESOLVE the root to its canonical provider path before anything else uses it.
#
# The exclusions below are matched by stripping this prefix off each file's
# FullName, and a prefix that does not match the spelling Get-ChildItem returns
# strips NOTHING - leaving an absolute path, which re-arms #3894 exactly. There
# are at least three spellings of the same root in normal use:
#
#   E:\Repos\...\agent-x     exact case, backslash   - stripped
#   e:\repos\...\agent-x     lowercase               - stripped (OrdinalIgnoreCase)
#   E:/Repos/.../agent-x     FORWARD SLASH           - NOT stripped before this
#
# The third is not exotic, it is the NATURAL spelling here: an agent inside a
# worktree running `validate-all.ps1 -RepoRoot "$(pwd)"` from Git Bash produces
# forward slashes, and Get-ChildItem returns FullName with BACKSLASHES whatever
# it was given. Measured against the real worktree before this fix:
#   Population: 0 Bicep file(s) to compile (351 found, 351 excluded)   RC=2
# i.e. the #3894 defect, in full, through a different spelling. A relative root
# ('.', 'dev-loop/..') failed the same way.
#
# Resolve-Path -> .ProviderPath normalises every one of those to the single
# spelling the filesystem provider uses, so the prefix compare cannot miss.
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction SilentlyContinue)
if (-not $resolvedRoot) {
    Write-Host "Repo root: $RepoRoot"
    Write-Host "UNRESOLVABLE ROOT - this gate measured NOTHING. CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  -RepoRoot does not resolve to a path that exists." -ForegroundColor Yellow
    Write-Host "  Nothing was walked and nothing was compiled. This is NOT a pass." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED. See #3894." -ForegroundColor Yellow
    exit 2
}
$rootPrefix = $resolvedRoot.ProviderPath.TrimEnd('\', '/')

Write-Host "Repo root: $rootPrefix"

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

# Paths are matched RELATIVE TO the resolved root, never as absolute strings.
# That one detail is the whole of the #3894 worktree fix: the exclusions below
# describe where a file sits INSIDE the repo, so they must not be evaluated
# against the path the repo itself happens to live at.
#
# Matching the absolute path meant that when the root WAS
# .claude/worktrees/agent-*, every file under it carried ".claude\worktrees" in
# its own FullName, the walk excluded all 351 of them, and the gate exited 2
# having measured nothing - from the one place every agent in this repo works.
# A guard that scans an empty set is not passing or failing, it is blind.
$script:unstrippablePaths = @()

function Get-RelativePath {
    param([string]$FullName)
    if ($FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $FullName.Substring($rootPrefix.Length).TrimStart('\', '/')
    }
    # Unreachable while $rootPrefix is the RESOLVED provider path of the very
    # directory we walked - which is why the walk below uses $rootPrefix and not
    # the raw parameter. It is recorded rather than swallowed because the old
    # behaviour here was `return $FullName`, and returning an absolute path from
    # a function whose callers assume a relative one is precisely how #3894
    # produced a confident verdict over an empty set. If this ever fires, the
    # gate refuses to report at all.
    $script:unstrippablePaths += $FullName
    return $FullName
}

# A NESTED .claude/worktrees (one that lives below the root being walked) is
# still excluded, because Get-ChildItem -Recurse does NOT consult .gitignore:
# every agent worktree carries a full copy of the repo, so without this the walk
# found 50545 .bicep files against 351 tracked ones (~144x) and the gate became a
# multi-hour operation over abandoned branches. See #3811.
#
# temp/ is excluded for the mirror-image reason: it is gitignored scratch space
# that currently holds 353 stale .bicep copies against 351 tracked ones, so a
# broken template in an abandoned experiment would red `make validate` for an
# unrelated change. The gate judges the tree, not the scratchpad. `(^|[\\/])`
# rather than a bare leading separator: repo-root-relative it is `temp\...` with
# nothing in front of it.
$excludePattern = 'node_modules|\.venv|dbt-env|\.claude[\\/]worktrees|(^|[\\/])temp[\\/]'

# Walk $rootPrefix, NOT the raw -RepoRoot: Get-ChildItem echoes the spelling it
# was given into each FullName, so walking the resolved path is what guarantees
# the prefix compare in Get-RelativePath can succeed.
$allBicepFiles = @(Get-ChildItem -Path $rootPrefix -Filter "*.bicep" -Recurse -File)

# Relative path computed ONCE per file, and carried alongside it, so the filter
# and the per-file log line cannot disagree about what a file is called.
$candidates = @($allBicepFiles | ForEach-Object {
    [pscustomobject]@{ File = $_; Rel = (Get-RelativePath $_.FullName) }
})
$bicepFiles = @($candidates | Where-Object { $_.Rel -notmatch $excludePattern })
$excludedCount = $candidates.Count - $bicepFiles.Count

# The POPULATION, on every run, pass or fail. A verdict quoted without the size
# of the set it was computed over is not a measurement.
Write-Host "Population: $($bicepFiles.Count) Bicep file(s) to compile ($($allBicepFiles.Count) found, $excludedCount excluded)"

# If ANY path could not be made relative, the exclusion filter saw an absolute
# path for it and the population above is not trustworthy in either direction.
# Refuse to report rather than emit a verdict over a set that was filtered by
# the wrong string.
if ($script:unstrippablePaths.Count -gt 0) {
    Write-Host "PREFIX MISMATCH - the population above was filtered on ABSOLUTE paths and is not trustworthy." -ForegroundColor Yellow
    Write-Host "  Root prefix: $rootPrefix" -ForegroundColor Yellow
    Write-Host "  $($script:unstrippablePaths.Count) file(s) did not start with it, e.g.:" -ForegroundColor Yellow
    foreach ($p in ($script:unstrippablePaths | Select-Object -First 3)) {
        Write-Host "    $p" -ForegroundColor Yellow
    }
    Write-Host "  This is the #3894 shape. Reporting NOT VERIFIED, not a pass and not a failure." -ForegroundColor Yellow
    exit 2
}

# Zero files is COULD NOT RUN, not a pass - and it gets its OWN message, distinct
# from the missing-toolchain one, because the two are diagnosed differently.
#
# Under the old absolute-path matching this branch was reached constantly and
# for the wrong reason (see the note above), and its advice - "run with -RepoRoot
# pointing at the main checkout" - pushed agents into validating main's tree
# instead of their own branch. The counts printed here separate the two real
# cases: an empty tree, versus a filter that ate everything.
if ($bicepFiles.Count -eq 0) {
    Write-Host "ZERO POPULATION - this gate measured NOTHING. CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Walked:             $rootPrefix" -ForegroundColor Yellow
    Write-Host "  .bicep files found: $($allBicepFiles.Count)" -ForegroundColor Yellow
    Write-Host "  Excluded by filter: $excludedCount" -ForegroundColor Yellow
    Write-Host "  Left to compile:    0" -ForegroundColor Yellow
    if ($allBicepFiles.Count -gt 0) {
        Write-Host "  EVERY file found was excluded. The exclusion filter produced this, not the tree." -ForegroundColor Yellow
    } else {
        Write-Host "  No .bicep file exists anywhere under that root." -ForegroundColor Yellow
    }
    Write-Host "  Nothing was compiled. This is NOT a pass, and NOT a statement about your templates." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED. See #3894." -ForegroundColor Yellow
    exit 2
}

# Compile into a scratch directory OUTSIDE the repository.
#
# `bicep build <file>` writes its ARM output NEXT TO the source, and this gate
# used to delete that sibling .json afterwards to clean up. Exactly one tracked
# file collides with that assumption:
#     deploy/bicep/landing-zone-alz/modules/networking/subnet/subnet.json
# which is a COMMITTED ARM template, not a build artifact. Every local run
# overwrote it and then deleted it, leaving a deletion in the working tree that
# the operator did not make - and a `git add -A` after a gate run commits it.
#
# --outfile is the fix rather than a skip list or a tracked-ness probe: a gate
# that writes nothing into the tree it is judging cannot delete the wrong thing,
# and it stays correct for any file added later. See #3894.
$scratchDir = Join-Path ([System.IO.Path]::GetTempPath()) ("loom-validate-bicep-" + [Guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Path $scratchDir -Force | Out-Null
$scratchOut = Join-Path $scratchDir 'build.json'

try {
foreach ($entry in $bicepFiles) {
    $relativePath = $entry.Rel
    Write-Host "  Validating: $relativePath" -NoNewline

    try {
        $output = bicep build $entry.File.FullName --outfile $scratchOut 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host " [PASS]" -ForegroundColor Green
        } else {
            Write-Host " [FAIL]" -ForegroundColor Red
            $errors += @{ File = $relativePath; Error = ($output | Out-String) }
        }
    } catch {
        Write-Host " [ERROR]" -ForegroundColor Red
        $errors += @{ File = $relativePath; Error = $_.Exception.Message }
    }
}
} finally {
    # finally, not straight-line: a run interrupted mid-compile (Ctrl-C, or the
    # operator killing a 351-file sweep) otherwise leaks its scratch directory in
    # %TEMP% forever. Observed during review of #3901 as a stranded
    # loom-validate-bicep-315dc9142b. Our own directory, holding only files we
    # created - no verdict depends on this succeeding.
    Remove-Item $scratchDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
if ($errors.Count -gt 0) {
    Write-Host "=== VALIDATION FAILED ===" -ForegroundColor Red
    Write-Host "$($errors.Count) of $($bicepFiles.Count) file(s) failed validation:"
    foreach ($err in $errors) {
        Write-Host "  - $($err.File): $($err.Error)" -ForegroundColor Yellow
    }
    exit 1
} else {
    Write-Host "=== ALL BICEP FILES VALID ($($bicepFiles.Count) compiled) ===" -ForegroundColor Green
    exit 0
}

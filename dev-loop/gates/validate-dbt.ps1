<#
.SYNOPSIS
    Validates dbt models by running dbt compile.

.DESCRIPTION
    Exit codes:
      0 - dbt compile succeeded
      1 - dbt compile failed
      2 - COULD NOT RUN (unresolvable root, zero population, or dbt is not
          installed). Previously ALL of those returned 0, which
          validate-all.ps1 printed as "dbt: [PASS]" - so on any machine without
          dbt (which is the default clone: dbt is in neither `make setup` nor
          `make setup-all`) this gate reported a pass having compiled nothing.
          See #3811.
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
#   [validate-dbt -WhatIf] RC=1 :: A parameter cannot be found that matches
#                                  parameter name 'WhatIf'.
# The $PSScriptRoot fix above could not help that consumer: the script never
# reached its body. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0.
if ($WhatIfPreference) {
    Write-Host "=== dbt Validation Gate (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would locate a dbt_project.yml under: $RepoRoot"
    Write-Host "  (excluding node_modules, .venv, dbt-env, dbt_packages, temp and any"
    Write-Host "   NESTED .claude/worktrees) and run dbt compile against it."
    Write-Host "  Nothing was compiled and nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "=== dbt Validation Gate ===" -ForegroundColor Cyan

# RESOLVE the root to its canonical provider path before anything else uses it.
#
# The exclusions below are matched by stripping this prefix off each path, and a
# prefix that does not match the spelling the provider returns strips NOTHING -
# leaving an absolute path, which is #3903 exactly. There are at least three
# spellings of the same root in normal use:
#
#   E:\Repos\...\agent-x     exact case, backslash   - stripped
#   e:\repos\...\agent-x     lowercase               - stripped (OrdinalIgnoreCase)
#   E:/Repos/.../agent-x     FORWARD SLASH           - NOT stripped without this
#
# The third is not exotic, it is the NATURAL spelling here: an agent inside a
# worktree running `validate-all.ps1 -RepoRoot "$(pwd)"` from Git Bash produces
# forward slashes, while the filesystem provider returns backslashes whatever it
# was given. Same repair as validate-bicep.ps1 (#3894 / PR #3901).
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction SilentlyContinue)
if (-not $resolvedRoot) {
    Write-Host "Repo root: $RepoRoot"
    Write-Host "UNRESOLVABLE ROOT - this gate measured NOTHING. CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  -RepoRoot does not resolve to a path that exists." -ForegroundColor Yellow
    Write-Host "  Nothing was walked and nothing was compiled. This is NOT a pass." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED. See #3903." -ForegroundColor Yellow
    exit 2
}
$rootPrefix = $resolvedRoot.ProviderPath.TrimEnd('\', '/')

Write-Host "Repo root: $rootPrefix"

# Paths are matched RELATIVE TO the resolved root, never as absolute strings.
# That one detail is the whole of the #3903 fix: the exclusions describe where a
# project sits INSIDE the repo, so they must not be evaluated against the path
# the repo itself happens to live at.
#
# Matching the absolute path meant that when the root WAS
# .claude/worktrees/agent-*, every candidate under it carried ".claude\worktrees"
# in its own FullName, the walk excluded all of them, and the gate fell into its
# `-eq 0` arm and printed "No dbt_project.yml found - CANNOT VALIDATE" - from the
# one place every agent in this repo works. A guard that scans an empty set is
# not passing or failing, it is blind.
#
# temp/ is excluded for the mirror-image reason validate-bicep.ps1 excludes it:
# gitignored scratch space should not red `make validate` for an unrelated
# change. `(^|[\\/])` rather than a bare leading separator - repo-root-relative
# it is `temp\...` with nothing in front of it. `dbt_packages` is dbt's own
# vendored-dependency directory: those projects are not ours to validate.
$excludePattern = 'node_modules|\.venv|dbt-env|dbt_packages|\.claude[\\/]worktrees|(^|[\\/])temp[\\/]'

# THE WALK IS PRUNED, NOT FILTERED-AFTER-THE-FACT, and that is a measured
# decision rather than an optimisation reflex. `Get-ChildItem -Recurse` descends
# into every excluded directory before anything can filter the result:
#
#   Get-ChildItem E:\Repos\GitHub\csa-inabox -Filter dbt_project.yml -Recurse
#     -> found=3533  elapsed=334.0s
#
# 5.5 MINUTES, against 19 tracked projects, because it walks every agent worktree
# and every dbt_packages copy. This gate sits under `make validate`, so that cost
# is paid on every run. Pruning by the SAME `$excludePattern` at descent time
# gives the identical population in ~1s. The filter is still applied to the
# survivors afterwards, so the two mechanisms have to agree; if they ever do not,
# `$postFilterExcluded` below is non-zero and it is printed.
$script:unstrippablePaths = @()

function Get-RelativePath {
    param([string]$FullName)
    if ($FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $FullName.Substring($rootPrefix.Length).TrimStart('\', '/')
    }
    # Unreachable while $rootPrefix is the RESOLVED provider path of the very
    # directory being walked - which is why the walk below starts at $rootPrefix
    # and not at the raw parameter. It is RECORDED rather than swallowed, because
    # returning an absolute path from a function whose callers assume a relative
    # one is precisely how #3894/#3903 produced a confident verdict over an empty
    # set. If this ever fires, the gate refuses to report at all.
    $script:unstrippablePaths += $FullName
    return $FullName
}

$prunedDirs = 0
$candidates = @()
$stack = New-Object System.Collections.Stack
$stack.Push($rootPrefix)
while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    $projectFile = Join-Path $dir 'dbt_project.yml'
    if (Test-Path -LiteralPath $projectFile -PathType Leaf) {
        $candidates += [pscustomobject]@{ Path = $projectFile; Rel = (Get-RelativePath $projectFile) }
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
        $rel = Get-RelativePath $child.FullName
        if ($rel -match $excludePattern) { $prunedDirs += 1; continue }
        $stack.Push($child.FullName)
    }
}

# Belt AND braces: re-apply the filter to the survivors. The prune above decides
# where to DESCEND; this decides what to REPORT. They are the same pattern, so
# this should always be zero - and a non-zero value means the two disagree, which
# is worth seeing rather than silently reconciling.
$dbtProjects = @($candidates | Where-Object { $_.Rel -notmatch $excludePattern })
$postFilterExcluded = $candidates.Count - $dbtProjects.Count

# The POPULATION, on every run, pass or fail. A verdict quoted without the size
# of the set it was computed over is not a measurement.
Write-Host "Population: $($dbtProjects.Count) dbt project(s) to compile ($($candidates.Count) found, $postFilterExcluded excluded); $prunedDirs director(ies) pruned before descent"

# If ANY path could not be made relative, the exclusion filter saw an absolute
# path for it and the population above is not trustworthy in either direction.
# Refuse to report rather than emit a verdict over a set filtered by the wrong
# string.
if ($script:unstrippablePaths.Count -gt 0) {
    Write-Host "PREFIX MISMATCH - the population above was filtered on ABSOLUTE paths and is not trustworthy." -ForegroundColor Yellow
    Write-Host "  Root prefix: $rootPrefix" -ForegroundColor Yellow
    Write-Host "  $($script:unstrippablePaths.Count) path(s) did not start with it, e.g.:" -ForegroundColor Yellow
    foreach ($p in ($script:unstrippablePaths | Select-Object -First 3)) {
        Write-Host "    $p" -ForegroundColor Yellow
    }
    Write-Host "  This is the #3903 shape. Reporting NOT VERIFIED, not a pass and not a failure." -ForegroundColor Yellow
    exit 2
}

# Zero projects is COULD NOT RUN, not a pass - and it gets its OWN message,
# distinct from the missing-toolchain one below, because the two are diagnosed
# differently. The counts separate the two real cases: an empty tree, versus a
# filter/prune that ate everything.
if ($dbtProjects.Count -eq 0) {
    Write-Host "ZERO POPULATION - this gate measured NOTHING. CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  Walked:                  $rootPrefix" -ForegroundColor Yellow
    Write-Host "  dbt_project.yml found:   $($candidates.Count)" -ForegroundColor Yellow
    Write-Host "  Excluded by filter:      $postFilterExcluded" -ForegroundColor Yellow
    Write-Host "  Directories pruned:      $prunedDirs" -ForegroundColor Yellow
    Write-Host "  Left to compile:         0" -ForegroundColor Yellow
    if ($candidates.Count -gt 0) {
        Write-Host "  EVERY project found was excluded. The exclusion filter produced this, not the tree." -ForegroundColor Yellow
    } elseif ($prunedDirs -gt 0) {
        Write-Host "  No dbt_project.yml exists outside the pruned directories. If you expected one," -ForegroundColor Yellow
        Write-Host "  check whether it sits under an excluded path: $excludePattern" -ForegroundColor Yellow
    } else {
        Write-Host "  No dbt_project.yml exists anywhere under that root." -ForegroundColor Yellow
    }
    Write-Host "  Nothing was compiled. This is NOT a pass, and NOT a statement about your models." -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED. See #3903." -ForegroundColor Yellow
    exit 2
}

# TOOLCHAIN CHECKED AFTER THE POPULATION, DELIBERATELY, and this is the one place
# this gate diverges from validate-bicep.ps1. That gate checks the toolchain
# first because its walk was unbounded; this one's walk is pruned and costs ~1s,
# so the ordering can be chosen for what it TELLS the reader instead. The
# population is a fact about the TREE and holds whether or not dbt is installed;
# reporting "dbt not found" without saying how many projects therefore went
# unvalidated is strictly less information, and it is the number an operator
# needs to size what they are missing.
$dbtPath = Get-Command dbt -ErrorAction SilentlyContinue
if (-not $dbtPath) {
    Write-Host "dbt not found in PATH - CANNOT VALIDATE." -ForegroundColor Yellow
    Write-Host "  $($dbtProjects.Count) dbt project(s) were found and NONE of them were compiled." -ForegroundColor Yellow
    Write-Host "  Install dbt: pip install dbt-databricks" -ForegroundColor Yellow
    Write-Host "  Reporting NOT VERIFIED, not a pass." -ForegroundColor Yellow
    exit 2
}

$dbtProject = $dbtProjects[0]

# Honest about scope: this gate compiles ONE project. Which one depends on walk
# order, which is not stable across machines. Compiling all of them is a real
# change in what runs and is tracked separately on #3811.
if ($dbtProjects.Count -gt 1) {
    Write-Host "WARNING: $($dbtProjects.Count) dbt projects found; this gate validates only the first." -ForegroundColor Yellow
    Write-Host "  A pass here is a statement about 1 of $($dbtProjects.Count) projects. See #3811." -ForegroundColor Yellow
}

$dbtDir = Split-Path $dbtProject.Path -Parent
Write-Host "dbt project found at: $($dbtProject.Rel)"

Push-Location $dbtDir
try {
    Write-Host "Running dbt compile..."
    dbt compile --profiles-dir . 2>&1

    if ($LASTEXITCODE -eq 0) {
        Write-Host "=== DBT COMPILE PASSED (1 of $($dbtProjects.Count) project(s)) ===" -ForegroundColor Green
        exit 0
    } else {
        Write-Host "=== DBT COMPILE FAILED ===" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

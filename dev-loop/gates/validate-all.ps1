<#
.SYNOPSIS
    Orchestrates all validation gates.

.DESCRIPTION
    Runs all validation gate scripts and reports overall pass/fail.
    Detects which files changed and only runs relevant gates.

    Exit codes - this is a CONTRACT, callers read it:
      0 - everything REQUIRED that was selected got measured and nothing
          failed. Optional gates (required: false in dev-loop/config.yaml) may
          have been skipped; that is reported but does not fail the run.
      1 - a gate ran and found a problem.
      2 - -WhatIf. Nothing was invoked, so nothing was measured.
      3 - NOT VERIFIED. The run did not establish what it claims to: nothing was
          measured, OR a gate declared `required: true` could not run, OR the
          registry and this orchestrator disagree. Non-zero on purpose - a run
          that established nothing must not hand its caller a success.
      4 - this script's own in-process control failed; its answer is meaningless.

    Exit 3 is the fix for #3811, where an empty result set printed
    "All gates passed!" and returned 0.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot,
    [switch]$RunAll
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
$gatesDir = Join-Path $PSScriptRoot ""
$results = @()

# The gates this script has a call site for. Compared against config.yaml's
# validation_gates: block further down - see the drift check for why.
$invokedGates = @()

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  CSA-in-a-Box Validation Gates" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# -WhatIf is HONOURED, not merely tolerated. apps/copilot/tools/readonly.py:551-559
# builds `-File <gate>.ps1 -WhatIf` for every gate on its dry-run allowlist, and
# no gate declared SupportsShouldProcess - so parameter binding failed and the
# tool returned RC=1 with EMPTY stdout on every host, for all five gates.
# Measured before this change:
#   [validate-all -WhatIf] RC=1 :: A parameter cannot be found that matches
#                                  parameter name 'WhatIf'.
# The $PSScriptRoot fix above could not help that consumer: the script never
# reached its body. See #3811.
#
# A dry run measures NOTHING, so it exits 2 (COULD NOT RUN) rather than 0. It
# does not invoke any gate, so it cannot be quoted as a pass over an empty run.
if ($WhatIfPreference) {
    Write-Host "-WhatIf: would orchestrate the gates in dev-loop/gates/ against" -ForegroundColor White
    Write-Host "  repo root: $RepoRoot"
    Write-Host "  No gate was invoked. Nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

# ---------------------------------------------------------------------------
# Detect changed files.
#
# The base was `HEAD~1`, which sees exactly ONE commit. On a branch of N commits
# the gate selection was made from commit N alone - so a branch touching Python
# in commit 1 and TypeScript in commit 2 ran no Python gate. The base is now the
# merge-base with the default branch, i.e. the set of files the change actually
# changes. Uncommitted work is unioned in (staged, unstaged, and untracked),
# because `make validate` is run BEFORE committing far more often than after,
# and a brand-new file is untracked at that point.
#
# UNKNOWN IS NOT "NOTHING CHANGED". The old code ran git with `2>$null` and let
# an empty result stand for an empty diff, so a git failure and a clean tree
# were indistinguishable - and its try/catch could never fire, because a failing
# native command is non-terminating under $ErrorActionPreference = 'Continue'.
# Detection failure now escalates to RunAll: on doubt this measures MORE, never
# less. See #3811.
# ---------------------------------------------------------------------------
function Invoke-Git {
    param([string[]]$GitArgs)
    # $global: on BOTH the reset and the read. A bare `$LASTEXITCODE = $null`
    # here creates a FUNCTION-LOCAL variable that shadows the automatic one;
    # `& git` then writes the global while the read finds the local $null, so
    # every git call was classified as failed. Measured: change detection
    # reported "git did not answer" on a healthy repo and escalated every run to
    # RunAll. It failed in the safe direction, which is exactly why it would
    # have gone unnoticed - the suite still ran more, not less.
    #
    # `-C $RepoRoot` anchors git to the SAME root the gates are run against.
    # Without it change detection was CWD-anchored while gate execution was
    # -RepoRoot-anchored, and the two disagree from a subdirectory: `git diff
    # --name-only` returns repo-relative paths ("sub/deep/new.py") while
    # `ls-files --others` returns CWD-relative ones ("deep/new.py"), so the
    # prefix triggers silently missed brand-new files - the exact case the
    # merge-base rework was written to cover.
    $global:LASTEXITCODE = $null
    $out = & git -C $RepoRoot @GitArgs 2>&1
    return [pscustomobject]@{ ExitCode = $global:LASTEXITCODE; Output = @($out) }
}

$changedFiles = @()
$baseLabel = $null

$mergeBase = $null
foreach ($ref in @('origin/main', 'main', 'origin/HEAD')) {
    $mb = Invoke-Git @('merge-base', 'HEAD', $ref)
    if ($mb.ExitCode -eq 0 -and $mb.Output.Count -gt 0) {
        $candidate = "$($mb.Output[0])".Trim()
        if ($candidate -match '^[0-9a-f]{7,40}$') {
            $mergeBase = $candidate
            $shortBase = $mergeBase.Substring(0, [Math]::Min(8, $mergeBase.Length))
            $baseLabel = "merge-base with $ref ($shortBase)"
            break
        }
    }
}

$committedDiffRead = $false
if ($mergeBase) {
    $d = Invoke-Git @('diff', '--name-only', $mergeBase, 'HEAD')
    if ($d.ExitCode -eq 0) {
        $changedFiles += $d.Output
        $committedDiffRead = $true
    }
}

# Working-tree state, always unioned in.
$worktreeRead = $false
foreach ($argSet in @(
    @('diff', '--name-only', 'HEAD'),
    @('diff', '--name-only', '--cached'),
    @('ls-files', '--others', '--exclude-standard')
)) {
    $w = Invoke-Git $argSet
    if ($w.ExitCode -eq 0) {
        $changedFiles += $w.Output
        $worktreeRead = $true
    }
}

$changedFiles = @($changedFiles | ForEach-Object { "$_".Trim() } | Where-Object { $_ } | Sort-Object -Unique)

if (-not $committedDiffRead -and -not $worktreeRead) {
    Write-Host "Could not determine what changed - git did not answer." -ForegroundColor Yellow
    Write-Host "  The diff is UNKNOWN, which is NOT 'nothing changed'. Running ALL gates." -ForegroundColor Yellow
    $RunAll = $true
} elseif (-not $mergeBase) {
    Write-Host "No merge-base with origin/main, main, or origin/HEAD." -ForegroundColor Yellow
    Write-Host "  Comparison covers the working tree only, so committed history is UNSEEN. Running ALL gates." -ForegroundColor Yellow
    $RunAll = $true
}

if ($RunAll) {
    Write-Host "Change detection: -RunAll in effect; every gate will run regardless of the diff." -ForegroundColor White
} else {
    Write-Host "Change detection: $($changedFiles.Count) file(s) changed vs $baseLabel (plus working tree)." -ForegroundColor White
}
Write-Host ""

function ShouldRunGate {
    param(
        [string[]]$Patterns,
        [string[]]$ExcludePatterns = @()
    )
    if ($RunAll) { return $true }
    foreach ($file in $changedFiles) {
        # Excluded files cannot select the gate. This exists so a gate's TRIGGER
        # population can be made to match its CHECK population exactly - a gate
        # that fires for files it never examines will report a measured PASS
        # over an unexamined change, which is #3506's shape and was measured
        # here on the TypeScript leg.
        $excluded = $false
        foreach ($x in $ExcludePatterns) {
            if ($file -like $x) { $excluded = $true; break }
        }
        if ($excluded) { continue }
        foreach ($pattern in $Patterns) {
            if ($file -like $pattern) { return $true }
        }
    }
    return $false
}

# A gate has THREE possible outcomes, not two. Collapsing "could not run" into
# "passed" is the defect behind #3811 in its second form:
#
#   0     - the gate ran and found nothing wrong
#   2     - the gate COULD NOT RUN (its toolchain is absent, there was nothing
#           for it to check). By convention across dev-loop/gates.
#   $null - the gate SCRIPT could not be invoked at all. $LASTEXITCODE is not
#           written in that case, so this is only distinguishable because it is
#           reset to $null before each call below.
#   other - the gate ran and found a problem.
function GateStatus {
    param($Code)
    if ($null -eq $Code) { return 'NotRun' }
    if ($Code -eq 0)     { return 'Pass' }
    if ($Code -eq 2)     { return 'NotRun' }
    return 'Fail'
}

# ---------------------------------------------------------------------------
# THE SUITE VERDICT, as a pure function of what the gates reported.
#
# This is the defect #3811 was filed for, in its strongest form. The verdict
# used to be computed by flags that ONLY A GATE THAT ACTUALLY RAN could move -
# `$allPassed = $true` ahead of a foreach over `$results` - so an empty
# `$results` skipped the loop, kept the initial value, and printed
# "All gates passed!" with exit 0. "I measured nothing" and "everything passed"
# produced byte-identical output.
#
# The exit codes, and why each is what it is:
#
#   0  PASS         everything REQUIRED that was selected got measured, and
#                   nothing failed. Optional gates may be missing.
#   1  FAIL         a gate ran and found a problem. Outranks everything.
#   3  NOT VERIFIED the run did not establish what it claims to. Three ways in:
#                     - nothing was measured at all;
#                     - a REQUIRED gate could not run;
#                     - the registry and this orchestrator disagree, so what
#                       actually ran is not knowable.
#                   Non-zero, because a caller that reads the exit code - a
#                   Makefile, a hook, a CI step, an agent writing "ran make
#                   validate, gates passed" - must not be handed a success for a
#                   run that established nothing. It is deliberately NOT 1:
#                   "some gates failed" would be a second false statement.
#   4  BROKEN       the in-process control failed; this answer is meaningless.
#
# REQUIRED vs OPTIONAL is read from dev-loop/config.yaml's `required:` field,
# which the registry already carried and which nothing consulted. It is what
# lets a dev box without dbt stay green while a missing REQUIRED leg goes red.
# An earlier version returned 0 for every partial state, which meant a machine
# lacking the bicep CLI got a silent pass on a bicep-only diff; measured over
# 300 first-parent commits, that partial state fires on 8.7% of changes in a
# main checkout and 21% in an agent worktree. "Loud words, exit 0" is the same
# defect as #3811 wearing different clothes - it just takes a reader who parses
# English rather than a status code.
#
# NOT-VERIFIED KEYS ON "NOTHING WAS MEASURED", NOT ON "$results IS EMPTY".
# Those are different populations, and the narrower one is trivially bypassed:
# a suite of five gates that all exit 2 has a NON-empty $results while having
# measured exactly as much as the empty one - nothing. Keying on Count -eq 0
# would let any always-NotRun gate manufacture a green exit for a run that
# checked nothing. Only Pass and Fail count as measurements.
# ---------------------------------------------------------------------------
function Get-SuiteVerdict {
    param(
        [object[]]$Results,
        [bool]$DriftFound,
        [string[]]$RequiredGates = @()
    )

    $all      = @($Results)
    $failed   = @($all | Where-Object { $_.Status -eq 'Fail' })
    $measured = @($all | Where-Object { $_.Status -eq 'Fail' -or $_.Status -eq 'Pass' })
    $notRun   = @($all | Where-Object { $_.Status -ne 'Fail' -and $_.Status -ne 'Pass' })

    # Gate names are matched case-insensitively: $results carries display names
    # ("Bicep", "TypeScript") while config.yaml carries registry keys ("bicep",
    # "typescript").
    $requiredNotRun = @($notRun | Where-Object {
        $name = "$($_.Gate)"
        @($RequiredGates | Where-Object { $_ -and ($_ -ieq $name) }).Count -gt 0
    })

    if ($failed.Count -gt 0) {
        return [pscustomobject]@{ Code = 1; Verdict = 'Fail'; Measured = $measured.Count; NotRun = $notRun.Count; RequiredNotRun = @($requiredNotRun | ForEach-Object { $_.Gate }) }
    }
    if ($measured.Count -eq 0) {
        return [pscustomobject]@{ Code = 3; Verdict = 'NotVerified'; Measured = 0; NotRun = $notRun.Count; RequiredNotRun = @($requiredNotRun | ForEach-Object { $_.Gate }) }
    }
    if ($requiredNotRun.Count -gt 0 -or $DriftFound) {
        return [pscustomobject]@{ Code = 3; Verdict = 'RequiredMissing'; Measured = $measured.Count; NotRun = $notRun.Count; RequiredNotRun = @($requiredNotRun | ForEach-Object { $_.Gate }) }
    }
    if ($notRun.Count -gt 0) {
        return [pscustomobject]@{ Code = 0; Verdict = 'Partial'; Measured = $measured.Count; NotRun = $notRun.Count; RequiredNotRun = @() }
    }
    return [pscustomobject]@{ Code = 0; Verdict = 'Pass'; Measured = $measured.Count; NotRun = 0; RequiredNotRun = @() }
}

# ---------------------------------------------------------------------------
# IN-PROCESS CONTROL, run BEFORE the tree is judged.
#
# A verdict is only worth anything if its answer MOVES with its input. This
# asserts that it does, on synthetic inputs whose correct answer is known, every
# single run - so the empty-set regression cannot be silently reintroduced by a
# later edit. Five sibling guards under scripts/ci already run their control
# in-process rather than leaving it in a test file nobody runs on the path that
# matters; this follows them. See #3464 finding 4.
#
# THE POPULATION IS BOTH FUNCTIONS, NOT JUST THE VERDICT. An earlier version of
# this control drove Get-SuiteVerdict alone and was blind to the function that
# decides what its input MEANS. Measured by an independent reviewer: mutating
# GateStatus so 2 and $null map to 'Pass' - one word each, and the exact
# historical defect where "could not run" counted as a pass - produced
# `Bicep: [PASS]` / `All gates passed! (1 gate(s) measured.)` / RC=0 on a
# bicep-only diff with bicep absent, while all nine verdict cases still passed
# and gate-selftest.ps1 still reported 8/8 RC=0. A control that cannot see the
# mutation restoring the bug it was written for is decoration. Both functions
# are now in the population.
#
# If the control ever disagrees, the run aborts with exit 4 rather than
# reporting on the repo, because at that point this script's verdict means
# nothing regardless of what the gates said.
# ---------------------------------------------------------------------------
$controlFailures = @()

# --- GateStatus: exit code -> status. The mapping the verdict is computed FROM.
$statusCases = @(
    @{ Name = '$null (gate script not invocable) is NotRun'; Code = $null; Expect = 'NotRun' }
    @{ Name = 'exit 2 (COULD NOT RUN) is NotRun';            Code = 2;     Expect = 'NotRun' }
    @{ Name = 'exit 0 is Pass';                              Code = 0;     Expect = 'Pass'   }
    @{ Name = 'exit 1 is Fail';                              Code = 1;     Expect = 'Fail'   }
    @{ Name = 'exit 3 is Fail';                              Code = 3;     Expect = 'Fail'   }
    @{ Name = 'exit 127 (command not found) is Fail';        Code = 127;   Expect = 'Fail'   }
)

foreach ($case in $statusCases) {
    $got = GateStatus $case.Code
    if ($got -ne $case.Expect) {
        $controlFailures += "GateStatus / $($case.Name): expected '$($case.Expect)', got '$got'"
    }
}

# --- Get-SuiteVerdict: statuses -> exit code.
$controlCases = @(
    @{ Name = 'empty set is NOT VERIFIED';            Results = @();                                                          Req = @(); Drift = $false; Code = 3 }
    @{ Name = 'all-NotRun is NOT VERIFIED';           Results = @(@{Gate='a';Status='NotRun'}, @{Gate='b';Status='NotRun'});  Req = @(); Drift = $false; Code = 3 }
    @{ Name = 'single pass is PASS';                  Results = @(@{Gate='a';Status='Pass'});                                  Req = @(); Drift = $false; Code = 0 }
    @{ Name = 'single fail is FAIL';                  Results = @(@{Gate='a';Status='Fail'});                                  Req = @(); Drift = $false; Code = 1 }
    @{ Name = 'fail outranks pass';                   Results = @(@{Gate='a';Status='Pass'}, @{Gate='b';Status='Fail'});       Req = @(); Drift = $false; Code = 1 }
    @{ Name = 'fail outranks NotRun';                 Results = @(@{Gate='a';Status='NotRun'}, @{Gate='b';Status='Fail'});     Req = @(); Drift = $false; Code = 1 }
    @{ Name = 'OPTIONAL gate NotRun stays 0';         Results = @(@{Gate='a';Status='Pass'}, @{Gate='dbt';Status='NotRun'});   Req = @(); Drift = $false; Code = 0 }
    @{ Name = 'REQUIRED gate NotRun is NOT VERIFIED'; Results = @(@{Gate='a';Status='Pass'}, @{Gate='bic';Status='NotRun'});   Req = @('bic'); Drift = $false; Code = 3 }
    @{ Name = 'required gate that PASSED is fine';    Results = @(@{Gate='bic';Status='Pass'});                                Req = @('bic'); Drift = $false; Code = 0 }
    @{ Name = 'a real FAIL outranks a required NotRun'; Results = @(@{Gate='bic';Status='NotRun'}, @{Gate='b';Status='Fail'}); Req = @('bic'); Drift = $false; Code = 1 }
    @{ Name = 'drift is NOT VERIFIED, not a pass';    Results = @(@{Gate='a';Status='Pass'});                                  Req = @(); Drift = $true;  Code = 3 }
    @{ Name = 'drift cannot rescue an empty set';     Results = @();                                                          Req = @(); Drift = $true;  Code = 3 }
)

foreach ($case in $controlCases) {
    $got = Get-SuiteVerdict -Results $case.Results -DriftFound $case.Drift -RequiredGates $case.Req
    if ($got.Code -ne $case.Code) {
        $controlFailures += "Get-SuiteVerdict / $($case.Name): expected exit $($case.Code), got $($got.Code) ($($got.Verdict))"
    }
}

if ($controlFailures.Count -gt 0) {
    Write-Host ""
    Write-Host "CONTROL FAILED - this orchestrator's verdict logic is broken." -ForegroundColor Red
    foreach ($f in $controlFailures) { Write-Host "  $f" -ForegroundColor Red }
    Write-Host "  Refusing to report on the repository: the verdict would be meaningless." -ForegroundColor Red
    exit 4
}

# Gate 1: Bicep
#
# `*.bicepparam` is here because config.yaml DECLARES it as a bicep trigger and
# this script ignored it. Measured on a change touching only
# platform/fiab/bicep/prod.bicepparam:
#     Skipping: Bicep (no .bicep files changed)
# while the registry said triggers: ["*.bicep", "*.bicepparam"]. A param file is
# half of what a template compiles from; skipping it is a coverage hole, and the
# drift check below could not see it because it reconciles NAMES only. See #3811.
$invokedGates += 'bicep'
if (ShouldRunGate @("*.bicep", "*.bicepparam", "deploy/bicep/*")) {
    Write-Host "Running: Bicep validation..." -ForegroundColor White
    # Reset BEFORE the call. $ErrorActionPreference is 'Continue', which makes a
    # CommandNotFoundException non-terminating - so if the gate script is
    # missing or renamed, $LASTEXITCODE is never written and retains the
    # PREVIOUS gate's value. A missing gate script inherited a stale 0 and
    # printed [PASS]. Measured, not assumed. See #3811.
    $LASTEXITCODE = $null
    & (Join-Path $gatesDir "validate-bicep.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Bicep"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Bicep (no .bicep files changed)" -ForegroundColor DarkGray
}

# Gate 2: Python
$invokedGates += 'python'
if (ShouldRunGate @("*.py", "scripts/*", "domains/*")) {
    Write-Host "Running: Python validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-python.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Python"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Python (no .py files changed)" -ForegroundColor DarkGray
}

# Gate 3: dbt
$invokedGates += 'dbt'
if (ShouldRunGate @("*.sql", "domains/*/dbt/*", "dbt_project.yml")) {
    Write-Host "Running: dbt validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-dbt.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "dbt"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: dbt (no dbt files changed)" -ForegroundColor DarkGray
}

# Gate 4: Deployment
#
# This gate has existed since the dev loop shipped. It was declared in
# config.yaml, documented, and asserted-to-exist by
# dev-loop/tests/integration-test.ps1 - and invoked by NOTHING. This
# orchestrator ran three gates and never mentioned it, so `make validate`
# never what-if'd a template. Wired up here; the drift check below is what
# stops it happening again. See #3811.
#
# The trigger is `deploy/bicep/*` ONLY - matching what config.yaml declares
# ("deploy/bicep/**"). It previously also carried "*.bicep" and "*.bicepparam",
# which fired this gate for any Loom template change: measured on a
# platform/fiab/bicep/prod.bicepparam-only diff, this ran a subscription-level
# ESLZ what-if that has nothing to do with the Loom deploy path. deploy/bicep is
# an adjacent ESLZ pipeline (DLZ/DMLZ), not where Loom deploys from.
$invokedGates += 'deployment'
if (ShouldRunGate @("deploy/bicep/*")) {
    Write-Host "Running: Deployment validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-deployment.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "Deployment"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: Deployment (no deploy/bicep files changed)" -ForegroundColor DarkGray
}

# Gate 5: TypeScript
#
# There was no TypeScript leg at all. apps/fiab-console is the largest surface
# in the repo and the one every UI die-hard rule governs, and nothing in
# dev-loop/gates mentioned it - so a console-only change matched zero gates and
# `make validate` returned having measured nothing while CLAUDE.md calls it "ALL
# gates - this is the bar for done". See #3811.
#
# THE TRIGGER IS SCOPED TO WHAT THE GATE ACTUALLY COMPILES.
#
# validate-typescript.ps1 compiles tsconfig.build.json, which EXCLUDES every
# test file - `**/*.test.ts(x)`, `**/*.spec.ts(x)`, `**/__tests__/**`, `e2e/**`,
# `**/*.uat.ts(x)`, and the vitest/playwright configs. The first version of this
# gate triggered on `apps/fiab-console/*`, which is far wider. Measured by an
# independent reviewer: `tsc --showConfig -p tsconfig.build.json` resolves 4107
# files of which ZERO are tests, while 1559 `*.test.ts*` and 1563 `__tests__`
# files exist in that tree; over the last 141 console-touching changes, 78 (55%)
# changed only files this project does not compile. Every one of those would
# have compiled 4107 unrelated files, exited 0, and let the orchestrator print
# "All gates passed!" having typechecked none of the changed files. That is the
# same narrow-bypass shape #3506 records, and it is worse than a gap because it
# manufactures a positive.
#
# The excludes below MIRROR tsconfig.build.json. Widening one without the other
# reopens the defect, so they are commented on both sides.
#
# Console TESTS are therefore NOT covered by `make validate` - stated here, in
# the gate's own output, and in dev-loop/README.md rather than left implicit.
# Pointing this gate at tsconfig.json instead was measured and rejected for now:
# it yields 901 pre-existing type errors, ALL 901 in test files and none in
# production code, which would red every console change over debt this gate did
# not create. Tracked as a follow-up.
$invokedGates += 'typescript'
$tsExcludes = @(
    "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx",
    "*__tests__*",
    "apps/fiab-console/e2e/*",
    "*.uat.ts", "*.uat.tsx",
    "apps/fiab-console/vitest.config.ts",
    "apps/fiab-console/vitest.setup.ts",
    "apps/fiab-console/playwright.config.ts"
)
if (ShouldRunGate -Patterns @("apps/fiab-console/*.ts", "apps/fiab-console/*.tsx") -ExcludePatterns $tsExcludes) {
    Write-Host "Running: TypeScript validation..." -ForegroundColor White
    $LASTEXITCODE = $null   # see note on Gate 1
    & (Join-Path $gatesDir "validate-typescript.ps1") -RepoRoot $RepoRoot
    $results += @{ Gate = "TypeScript"; Status = (GateStatus $LASTEXITCODE) }
} else {
    Write-Host "Skipping: TypeScript (no compiled apps/fiab-console TypeScript changed)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Registry drift: does dev-loop/config.yaml agree with what this script runs?
#
# config.yaml is DECORATIVE - nothing reads it. This orchestrator carries its
# own copy of the gate list AND its own copy of the trigger globs, and the two
# representations drifted silently for the entire life of the dev loop: that is
# exactly how `deployment` came to be declared, documented, exposed to the
# in-product Copilot, and invoked by nobody.
#
# The check below does not remove the duplication - driving the loop from
# config.yaml would, and is a larger change tracked separately. What it does is
# make the duplication LOUD: add a gate to one side only and the next run says
# so. See #3811.
# ---------------------------------------------------------------------------
$driftFound = $false
$requiredGates = @()
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) "config.yaml"

Write-Host ""
Write-Host "Checking gate registry (dev-loop/config.yaml) against invoked gates..." -ForegroundColor White

if (-not (Test-Path $configPath)) {
    Write-Host "  config.yaml not found at $configPath - drift NOT CHECKED." -ForegroundColor Yellow
    $driftFound = $true
} else {
    # Windows PowerShell 5.1 has no ConvertFrom-Yaml, so parse the one block
    # that matters. Gate names are the 2-space-indented keys directly under
    # `validation_gates:`; the block ends at the first line starting in column
    # 0. Nested keys (script:, triggers:, ...) sit at 4 spaces and cannot match.
    #
    # `required:` is parsed here too. The registry has always carried it and
    # NOTHING read it - so a gate the registry called required could silently
    # not run and the suite still exited 0. It is what now separates "your dev
    # box has no dbt, fine" from "the bicep leg did not run, that is not a
    # pass". See #3811.
    $declared = @()
    $inBlock = $false
    $currentGate = $null
    foreach ($line in (Get-Content $configPath -Encoding UTF8)) {
        if ($line -match '^validation_gates:') { $inBlock = $true; continue }
        if (-not $inBlock) { continue }
        if ($line -match '^\S') { break }
        if ($line -match '^  ([A-Za-z0-9_-]+):') {
            $currentGate = $Matches[1]
            $declared += $currentGate
            continue
        }
        # `required: true` (YAML booleans are lowercase, but accept True/TRUE).
        if ($currentGate -and ($line -match '^\s+required:\s*(\S+)')) {
            if ($Matches[1] -match '^(true|True|TRUE|yes|Yes)$') { $requiredGates += $currentGate }
        }
    }

    # `all` IS this script. It is the orchestrator, not one of the gates it runs.
    $declared = @($declared | Where-Object { $_ -ne 'all' })
    $requiredGates = @($requiredGates | Where-Object { $_ -ne 'all' })

    if ($declared.Count -eq 0) {
        Write-Host "  No gates parsed out of config.yaml - drift NOT CHECKED." -ForegroundColor Yellow
        Write-Host "  Expected a 'validation_gates:' block with 2-space-indented gate names." -ForegroundColor Yellow
        $driftFound = $true
    } else {
        foreach ($g in @($declared | Where-Object { $invokedGates -notcontains $_ })) {
            Write-Host "  DRIFT: '$g' is declared in config.yaml but NEVER INVOKED by this script." -ForegroundColor Yellow
            $driftFound = $true
        }
        foreach ($g in @($invokedGates | Where-Object { $declared -notcontains $_ })) {
            Write-Host "  DRIFT: '$g' is invoked by this script but NOT DECLARED in config.yaml." -ForegroundColor Yellow
            $driftFound = $true
        }
        if (-not $driftFound) {
            # Deliberately narrow wording. This check reconciles gate NAMES and
            # nothing else - the TRIGGER globs live in two places too, and they
            # were measured disagreeing while this line still said "OK":
            #
            #   Skipping: Bicep (no .bicep files changed)   <- registry declares
            #                                                  *.bicepparam too
            #   Running: Deployment validation...           <- registry declares
            #                                                  deploy/bicep/**
            #   OK - 4 declared gate(s), all invoked.
            #
            # Both triggers are corrected above, but an unqualified "OK" would
            # still be quotable as "registry and orchestrator agree" on a future
            # divergence this check cannot see. So it says what it checked.
            Write-Host "  OK - $($declared.Count) declared gate name(s), all invoked (triggers NOT compared)." -ForegroundColor Green
        }
    }
}

# Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Validation Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

foreach ($r in $results) {
    $isRequired = @($requiredGates | Where-Object { $_ -and ($_ -ieq "$($r.Gate)") }).Count -gt 0
    $tag = if ($isRequired) { "required" } else { "optional" }
    switch ($r.Status) {
        'Pass'  { $label = "[PASS]";         $color = "Green" }
        'Fail'  { $label = "[FAIL]";         $color = "Red" }
        default { $label = "[NOT VERIFIED]"; $color = "Yellow" }
    }
    Write-Host "  $($r.Gate) ($tag): $label" -ForegroundColor $color
}
if ($results.Count -eq 0) {
    Write-Host "  (none)" -ForegroundColor DarkGray
}

$verdict = Get-SuiteVerdict -Results $results -DriftFound $driftFound -RequiredGates $requiredGates
Write-Host ""

switch ($verdict.Verdict) {
    'Fail' {
        Write-Host "Some gates failed. Fix issues and re-run." -ForegroundColor Red
    }
    'NotVerified' {
        # The condition is named precisely, because the two ways to reach it are
        # different problems with different fixes.
        if ($results.Count -eq 0) {
            Write-Host "NOT VERIFIED - 0 gates ran for this change. Exit 3." -ForegroundColor Yellow
            Write-Host "  This is NOT a pass, and it is NOT a failure: nothing was measured." -ForegroundColor Yellow
            Write-Host "  No file in this diff is covered by a gate in dev-loop/gates/." -ForegroundColor Yellow
            if (-not $RunAll) {
                Write-Host "  Changed files considered: $($changedFiles.Count) vs $baseLabel." -ForegroundColor Yellow
                Write-Host "  To validate the whole tree regardless of the diff, re-run with -RunAll." -ForegroundColor Yellow
            }
        } else {
            Write-Host "NOT VERIFIED - $($results.Count) gate(s) were selected and NONE of them could run. Exit 3." -ForegroundColor Yellow
            Write-Host "  This is NOT a pass. A suite of gates that all report COULD NOT RUN has" -ForegroundColor Yellow
            Write-Host "  measured exactly as much as a suite that ran nothing at all." -ForegroundColor Yellow
            Write-Host "  See each gate's output above for the toolchain it is missing." -ForegroundColor Yellow
        }
        Write-Host "  Console TypeScript beyond the typecheck (next build, eslint, vitest) is" -ForegroundColor Yellow
        Write-Host "  gated by fiab-console-ci, not by this script." -ForegroundColor Yellow
        if ($driftFound) {
            Write-Host "  The gate registry also disagrees with this orchestrator - see the drift report above." -ForegroundColor Yellow
        }
    }
    'RequiredMissing' {
        # Non-zero. A REQUIRED leg that could not run means the run did not
        # establish what `make validate` claims to establish, and an exit code
        # is what a Makefile, a hook, or an agent actually reads. Optional legs
        # (dbt, deployment) do NOT reach here - a dev box without dbt stays
        # green, which is the whole reason the registry carries `required:`.
        if ($verdict.RequiredNotRun.Count -gt 0) {
            Write-Host "NOT VERIFIED - a REQUIRED gate could not run. Exit 3." -ForegroundColor Yellow
            Write-Host "  Required and not run: $($verdict.RequiredNotRun -join ', ')" -ForegroundColor Yellow
            Write-Host "  $($verdict.Measured) gate(s) measured something and none failed, but the" -ForegroundColor Yellow
            Write-Host "  legs above are declared required: true in dev-loop/config.yaml and were" -ForegroundColor Yellow
            Write-Host "  NOT measured. See each gate's output for the toolchain it is missing." -ForegroundColor Yellow
            $optionalNotRun = $verdict.NotRun - $verdict.RequiredNotRun.Count
            if ($optionalNotRun -gt 0) {
                Write-Host "  ($optionalNotRun optional gate(s) also did not run; those alone would not fail this run.)" -ForegroundColor DarkGray
            }
        }
        if ($driftFound) {
            Write-Host "NOT VERIFIED - the gate registry and this orchestrator disagree. Exit 3." -ForegroundColor Yellow
            Write-Host "  See the drift report above. When the registry and the runner disagree," -ForegroundColor Yellow
            Write-Host "  what actually ran is not knowable, so this run cannot be quoted as a pass." -ForegroundColor Yellow
        }
    }
    'Partial' {
        # Every gate that did not run is OPTIONAL, so exit stays 0 - this is the
        # dev-box case the `required:` field exists to keep green. It is still
        # reported, because a partial run is not a full pass.
        Write-Host "PASS (partial) - $($verdict.Measured) gate(s) measured, none failed." -ForegroundColor Green
        Write-Host "  $($verdict.NotRun) OPTIONAL gate(s) could not run and were not counted." -ForegroundColor Yellow
        Write-Host "  No required gate is missing, so this run exits 0. See above for what was skipped." -ForegroundColor Yellow
    }
    'Pass' {
        Write-Host "All gates passed! ($($verdict.Measured) gate(s) measured.)" -ForegroundColor Green
    }
}

exit $verdict.Code

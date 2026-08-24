<#
.SYNOPSIS
    Self-test for the dev-loop gate machinery: proves the verdict MOVES.

.DESCRIPTION
    Exit codes:
      0 - every case behaved as expected
      1 - a case disagreed: the gate machinery is not measuring what it claims
      2 - COULD NOT RUN (git or a TypeScript compiler unavailable)

    WHY THIS EXISTS

    `make validate` is this repo's documented definition of done - CLAUDE.md
    calls it "ALL gates - this is the bar for done" - and it used to return
    "All gates passed!" with exit 0 on a change where ZERO gates ran. The verdict
    was seeded `$true` and only a gate that actually ran could move it, so an
    empty result set inherited success by default. Every "gates green" claim in
    the repo rested on that. See #3811.

    A fix to that shape is worth nothing unless something proves, repeatedly,
    that the verdict still changes when the input changes. That is what this
    script does. Each case below is a PAIR or a known-answer probe, and the
    interesting ones are the negatives: a run that measured nothing must NOT
    come back 0.

    The cases:

      A  validate-all, synthetic repo, nothing in the diff matches a gate
         -> exit 3, NOT VERIFIED.        (the #3811 defect, direct)
      B  validate-all, same repo, a .py change that a gate really checks
         -> exit 0.                      (the discriminating half of the pair:
                                          A and B differ only in the diff)
      C  validate-typescript, clean fixture       -> exit 0
      D  validate-typescript, SAME fixture with a deliberate type error
         -> exit 1.                      (mutation: the verdict must move)
      E  validate-typescript, project that does not exist -> exit 2, never 0
      F  validate-typescript, LOOM_TSC_BIN pointing at nothing -> exit 2, never
         a silent fallback to a different compiler
      G  validate-all, a change under apps/fiab-console
         -> the TypeScript gate is SELECTED. A gate nothing ever triggers
            measures nothing however correct its internals are.
      H  validate-all, a change to a console TEST file ONLY
         -> the TypeScript gate is NOT selected and the suite is NOT green.
            tsconfig.build.json does not compile tests, so firing for one would
            report a measured PASS over an unexamined change.
      I  validate-all -> validate-typescript, a BROKEN compiled console file
         -> the suite exits 1. This is the PRODUCTION invocation path (`&`, a
            child scope), which is not equivalent to C/D's separate process.
      J  the same path, clean -> exit 0. Without J, I would also pass if the
         gate failed unconditionally.
      K  validate-all invoked with `&` from a PARENT .ps1 -> still measures.
         Every other case uses `pwsh -File`; the child-scope shape is where a
         bare `$LASTEXITCODE = $null` shadows the automatic variable and
         launders every gate into NotRun. It fails SAFE, so only a case that
         expects a real FAIL can see it.
      L  validate-all, a change under csa_platform with unused imports
         -> exit 1. The Python gate's TRIGGER used to be `*.py` while its CHECK
            was five directories that did not include csa_platform, so this
            change selected the gate, was never read by it, and the suite
            printed "All gates passed!". The positive arm.
      M  validate-all, a change under portal ONLY
         -> exit 3, and specifically NOT 0. portal is outside what the gate
            lints, so it must select nothing. The population arm: it is what
            makes widening the CHECK without narrowing the TRIGGER insufficient.

    A and B together are the load-bearing pair. If both return the same code,
    this script fails - because a verdict that does not move between "measured
    nothing" and "measured something and it passed" is not a verdict.

    L and M are the second such pair, for the Python gate's scope. Reverting
    only validate-python.ps1's $pythonDirs line reds L and leaves M green;
    reverting only validate-all.ps1's Gate 2 trigger reds M and leaves L green.
    Neither is satisfiable by the other's fix, which is the only reason running
    both is worth anything.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot
)

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

$ErrorActionPreference = 'Continue'
$gatesDir = $PSScriptRoot

if ($WhatIfPreference) {
    Write-Host "=== Gate Self-Test (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would build a synthetic git repo and a TypeScript fixture, then assert"
    Write-Host "  that the gate verdicts move with their inputs."
    Write-Host "  Nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Dev Loop Gate Self-Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# The host we are already running under, so the child gates run on the same
# PowerShell major version rather than whichever one happens to be on PATH.
$psExe = (Get-Process -Id $PID).Path

$cases = @()

function Add-Case {
    param([string]$Name, [string]$Status, [string]$Detail)
    $script:cases += [pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail }
    switch ($Status) {
        'Pass'   { Write-Host "  [PASS]   $Name" -ForegroundColor Green }
        'Fail'   { Write-Host "  [FAIL]   $Name" -ForegroundColor Red }
        default  { Write-Host "  [NOTRUN] $Name" -ForegroundColor Yellow }
    }
    if ($Detail) { Write-Host "           $Detail" -ForegroundColor DarkGray }
}

function Quote-Arg {
    param([string]$Value)
    if ($Value -match '\s') { return '"' + $Value + '"' }
    return $Value
}

# Start-Process rather than the call operator: the child gates read `git` from
# the PROCESS working directory, and PowerShell's Set-Location does not move
# that for a child process. -WorkingDirectory does, unambiguously.
function Invoke-Child {
    param(
        [string]$ScriptPath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $argLine = @('-NoProfile', '-File', (Quote-Arg $ScriptPath))
    foreach ($a in $Arguments) { $argLine += (Quote-Arg $a) }

    $proc = Start-Process -FilePath $psExe -ArgumentList $argLine `
        -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    $text = ''
    $text += (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    $text += (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Output = "$text" }
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("loom-gate-selftest-" + [Guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    # =======================================================================
    # Cases A and B - validate-all's verdict, against a synthetic repository.
    #
    # A synthetic repo rather than this one: the whole point is to control the
    # diff exactly, and the diff of the real checkout is whatever the operator
    # happens to have in progress.
    # =======================================================================
    $synthRepo = Join-Path $tempRoot 'synthetic-repo'
    New-Item -ItemType Directory -Path $synthRepo -Force | Out-Null

    $gitOk = $true
    $gitLog = ''
    function Invoke-SynthGit {
        param([string[]]$GitArgs)
        # $global: on both sides - a bare assignment inside a function shadows
        # the automatic variable, so the read returns $null forever and every
        # git call looks like a failure. Same trap as validate-all's Invoke-Git.
        $global:LASTEXITCODE = $null
        $out = & git -C $synthRepo @GitArgs 2>&1
        if ($global:LASTEXITCODE -ne 0) {
            $script:gitOk = $false
            $script:gitLog += "git $($GitArgs -join ' ') -> $($global:LASTEXITCODE) :: $out; "
        }
    }

    Invoke-SynthGit @('init', '-b', 'main', '-q')
    Invoke-SynthGit @('config', 'user.email', 'gate-selftest@localhost')
    Invoke-SynthGit @('config', 'user.name', 'Gate Self Test')
    Invoke-SynthGit @('config', 'commit.gpgsign', 'false')
    Set-Content -Path (Join-Path $synthRepo 'NOTES.md') -Value 'seed file, matched by no gate trigger' -Encoding ASCII
    Invoke-SynthGit @('add', '-A')
    Invoke-SynthGit @('commit', '-q', '-m', 'seed')

    if (-not $gitOk) {
        Add-Case 'A/B validate-all verdict pair' 'NotRun' "could not build the synthetic repo: $gitLog"
    } else {
        $validateAll = Join-Path $gatesDir 'validate-all.ps1'

        # --- Case A: clean tree on main. Nothing changed, nothing matches. ---
        $a = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $synthRepo) -WorkingDirectory $synthRepo
        if ($a.ExitCode -eq 3 -and $a.Output -match 'NOT VERIFIED - 0 gates ran') {
            Add-Case 'A  empty selection exits 3 NOT VERIFIED' 'Pass' "exit $($a.ExitCode)"
        } else {
            Add-Case 'A  empty selection exits 3 NOT VERIFIED' 'Fail' "expected exit 3 with 'NOT VERIFIED - 0 gates ran', got exit $($a.ExitCode)"
        }

        # --- Case B: a real .py change that the Python gate actually checks. ---
        # dev-loop/ is one of the directories validate-python lints, so this
        # file is genuinely inside the gate's check population, not merely
        # inside its trigger population.
        Invoke-SynthGit @('checkout', '-q', '-b', 'feature')
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'dev-loop') -Force | Out-Null
        $pyLines = @(
            '"""Clean module: the self-test needs a gate that measures and passes."""',
            '',
            '',
            'def add(left: int, right: int) -> int:',
            '    return left + right'
        )
        Set-Content -Path (Join-Path $synthRepo 'dev-loop/ok.py') -Value $pyLines -Encoding ASCII
        Invoke-SynthGit @('add', '-A')
        Invoke-SynthGit @('commit', '-q', '-m', 'add a python file')

        $b = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $synthRepo) -WorkingDirectory $synthRepo

        if ($b.Output -notmatch 'Running: Python validation') {
            Add-Case 'B  a .py change selects the Python gate' 'Fail' "the Python gate was not selected; exit $($b.ExitCode)"
        } elseif ($b.ExitCode -eq 0 -and $b.Output -match 'All gates passed') {
            Add-Case 'B  a measured, passing gate exits 0' 'Pass' "exit $($b.ExitCode)"
        } elseif ($b.Output -match 'NONE of them could run') {
            # ruff absent on this host. Honest NOT RUN, never a silent pass.
            Add-Case 'B  a measured, passing gate exits 0' 'NotRun' 'the Python gate could not run here (ruff unavailable); pair not provable on this host'
        } else {
            Add-Case 'B  a measured, passing gate exits 0' 'Fail' "expected exit 0 with 'All gates passed', got exit $($b.ExitCode)"
        }

        # --- The pair itself. This is the assertion that matters. ---
        $bWasMeasured = ($b.Output -match 'All gates passed')
        if ($bWasMeasured) {
            if ($a.ExitCode -ne $b.ExitCode) {
                Add-Case 'A/B the verdict MOVES with the diff' 'Pass' "A=$($a.ExitCode) B=$($b.ExitCode)"
            } else {
                Add-Case 'A/B the verdict MOVES with the diff' 'Fail' "A and B both exited $($a.ExitCode) - the verdict is not driven by what was measured"
            }
        } else {
            Add-Case 'A/B the verdict MOVES with the diff' 'NotRun' 'case B could not measure on this host'
        }

        # --- Case G: the TypeScript leg is REACHABLE from the orchestrator. ---
        # A gate whose trigger never matches anything measures nothing, however
        # correct its internals are - the zero-population failure this repo has
        # hit repeatedly. This asserts a console change actually SELECTS the
        # TypeScript gate, so "make validate covers the console" stays a fact
        # rather than an intention. See #3811.
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'apps/fiab-console/lib') -Force | Out-Null
        Set-Content -Path (Join-Path $synthRepo 'apps/fiab-console/lib/thing.ts') -Value 'export const thing = 1;' -Encoding ASCII
        Invoke-SynthGit @('add', '-A')
        Invoke-SynthGit @('commit', '-q', '-m', 'touch the console')

        $g = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $synthRepo) -WorkingDirectory $synthRepo
        if ($g.Output -match 'Running: TypeScript validation') {
            Add-Case 'G  a console change SELECTS the TypeScript gate' 'Pass' 'trigger population is non-empty'
        } else {
            Add-Case 'G  a console change SELECTS the TypeScript gate' 'Fail' "the TypeScript gate was skipped for a change under apps/fiab-console; exit $($g.ExitCode)"
        }

        # --- Case H: the trigger must NOT exceed what the gate compiles. ---
        # tsconfig.build.json excludes every test file, so a test-only console
        # change must NOT select the gate. If it does, the gate compiles 4107
        # unrelated files, exits 0, and the suite reports a measured PASS over a
        # change it never examined - measured at 78 of the last 141 console
        # changes before the trigger was narrowed. The honest answer for a
        # test-only diff is NOT VERIFIED, never green. See #3811 / #3506.
        # Branch from MAIN, not from the previous branch: the diff is taken
        # against the merge-base, so branching off `feature` would carry
        # thing.ts along and the gate would fire for THAT, not for the test
        # file - the case would pass for the wrong reason.
        Invoke-SynthGit @('checkout', '-q', 'main')
        Invoke-SynthGit @('checkout', '-q', '-b', 'console-tests-only')
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'apps/fiab-console/lib') -Force | Out-Null
        Set-Content -Path (Join-Path $synthRepo 'apps/fiab-console/lib/thing.test.ts') -Value 'const x: number = "s"; export default x;' -Encoding ASCII
        Invoke-SynthGit @('add', '-A')
        Invoke-SynthGit @('commit', '-q', '-m', 'touch only a console TEST file')

        $h = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $synthRepo) -WorkingDirectory $synthRepo
        if ($h.Output -match 'Running: TypeScript validation') {
            Add-Case 'H  a TEST-only console change does NOT select the gate' 'Fail' 'the gate fired for a file tsconfig.build.json does not compile - trigger exceeds check population'
        } elseif ($h.ExitCode -eq 0) {
            Add-Case 'H  a TEST-only console change does NOT select the gate' 'Fail' "gate correctly skipped, but the suite still exited 0 - a test-only change must not be green"
        } else {
            Add-Case 'H  a TEST-only console change does NOT select the gate' 'Pass' "skipped, and the suite exited $($h.ExitCode) rather than green"
        }

        # --- Case L: a csa_platform .py must be LINTED, not merely fired at. ---
        #
        # The positive arm of the Python gate's trigger/check pair. bad.py
        # carries two unused imports - F401, inside the three rule families the
        # gate's old `--select E,F,W` already covered, so this arm proves the
        # SCOPE moved and is not smuggling in new rules to manufacture a red.
        #
        # The empty `scripts` directory beside it reproduces the real tree's
        # shape, and is the whole reason the pre-fix behaviour was a green
        # rather than an honest NOT VERIFIED: the gate's check population was
        # non-empty and CLEAN, so it exited 0 having read nothing of what
        # changed. It is created on disk and never committed - git tracks files,
        # not directories - so it cannot enter the diff or select the gate.
        #
        # Measured against the code before this fix: exit 0, "Python
        # (required): [PASS]", "All gates passed! (1 gate(s) measured.)" over a
        # file the gate never opened. After: exit 1, "=== PYTHON LINT FAILED
        # ===". Reverting only validate-python.ps1's $pythonDirs line reds this
        # case and leaves M green. See #3811.
        Invoke-SynthGit @('checkout', '-q', 'main')
        Invoke-SynthGit @('checkout', '-q', '-b', 'csa-platform-lint')
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'scripts') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'csa_platform/gov') -Force | Out-Null
        $badLines = @('import os', 'import sys', 'x = 1')
        Set-Content -Path (Join-Path $synthRepo 'csa_platform/gov/bad.py') -Value $badLines -Encoding ASCII
        Invoke-SynthGit @('add', '-A')
        Invoke-SynthGit @('commit', '-q', '-m', 'add a csa_platform file with unused imports')

        $l = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $synthRepo) -WorkingDirectory $synthRepo
        if ($l.Output -notmatch 'Running: Python validation') {
            Add-Case 'L  a csa_platform .py is LINTED, not just triggered on' 'Fail' "the Python gate was not selected for a csa_platform change; exit $($l.ExitCode)"
        } elseif ($l.ExitCode -eq 1 -and $l.Output -match 'Python \(required\): \[FAIL\]') {
            Add-Case 'L  a csa_platform .py is LINTED, not just triggered on' 'Pass' "exit $($l.ExitCode)"
        } elseif ($l.Output -match 'NONE of them could run' -or $l.Output -match 'CANNOT VALIDATE') {
            # ruff absent on this host. Honest NOT RUN, never a silent pass.
            Add-Case 'L  a csa_platform .py is LINTED, not just triggered on' 'NotRun' 'the Python gate could not run here (ruff unavailable); the check population is not provable on this host'
        } else {
            Add-Case 'L  a csa_platform .py is LINTED, not just triggered on' 'Fail' "expected exit 1 with Python [FAIL] over 2 unused imports, got exit $($l.ExitCode). The gate fired for csa_platform and did not examine it."
        }

        # --- Case M: the trigger must NOT exceed what the gate lints. ---
        #
        # The population arm. portal/ is not in validate-python.ps1's
        # $pythonDirs, so a portal-only .py change must select NO gate and the
        # suite must say NOT VERIFIED - never green. Before the trigger was
        # narrowed, `*.py` matched this file, the gate ran over the clean
        # `scripts` directory beside it, and the suite printed "All gates
        # passed!" having read nothing of what changed. 555 of the repo's 762
        # tracked .py files sat in that gap.
        #
        # This is what stops the lazy half-fix: widening $pythonDirs alone
        # leaves M red, narrowing the trigger alone leaves L red. It also blocks
        # the other shortcut - pointing the gate at portal/ and examples/ -
        # because that turns this exit 3 into an exit 1 over 758 pre-existing
        # findings the gate did not create. See #3811 / #3506.
        Invoke-SynthGit @('checkout', '-q', 'main')
        Invoke-SynthGit @('checkout', '-q', '-b', 'portal-only')
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'scripts') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $synthRepo 'portal/api') -Force | Out-Null
        Set-Content -Path (Join-Path $synthRepo 'portal/api/bad.py') -Value $badLines -Encoding ASCII
        Invoke-SynthGit @('add', '-A')
        Invoke-SynthGit @('commit', '-q', '-m', 'add a portal file with unused imports')

        $m = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $synthRepo) -WorkingDirectory $synthRepo
        if ($m.Output -match 'Running: Python validation') {
            Add-Case 'M  a portal-only .py change does NOT select the gate' 'Fail' "the gate fired for a directory validate-python.ps1 does not lint - trigger exceeds check population; exit $($m.ExitCode)"
        } elseif ($m.ExitCode -eq 0) {
            Add-Case 'M  a portal-only .py change does NOT select the gate' 'Fail' 'gate correctly skipped, but the suite still exited 0 - an unexamined .py change must not be green'
        } elseif ($m.ExitCode -eq 3) {
            Add-Case 'M  a portal-only .py change does NOT select the gate' 'Pass' 'skipped, and the suite exited 3 NOT VERIFIED rather than green'
        } else {
            Add-Case 'M  a portal-only .py change does NOT select the gate' 'Fail' "expected exit 3 NOT VERIFIED, got exit $($m.ExitCode)"
        }
    }

    # =======================================================================
    # Cases C-F - validate-typescript.
    # =======================================================================
    $validateTs = Join-Path $gatesDir 'validate-typescript.ps1'
    $fixture = Join-Path $gatesDir '__fixtures__/typescript'

    # Resolve a compiler the same way the gate does, so a NotRun here means the
    # gate would also have reported NotRun, rather than the two disagreeing.
    $compiler = $null
    if ($env:LOOM_TSC_BIN -and (Test-Path $env:LOOM_TSC_BIN)) {
        $compiler = (Resolve-Path $env:LOOM_TSC_BIN).Path
    } else {
        $probe = Join-Path $RepoRoot 'apps/fiab-console/node_modules/typescript/bin/tsc'
        if (Test-Path $probe) { $compiler = (Resolve-Path $probe).Path }
    }

    if (-not $compiler) {
        Add-Case 'C/D validate-typescript verdict pair' 'NotRun' 'no TypeScript compiler resolvable; set LOOM_TSC_BIN or install the console deps in the MAIN checkout'
    } else {
        $env:LOOM_TSC_BIN = $compiler

        # --- Cases I and J: the PRODUCTION invocation path, end to end. ---
        #
        # C-F invoke validate-typescript.ps1 as a separate PROCESS. validate-all
        # invokes it with `&`, in a CHILD SCOPE of the same process, and those
        # are not equivalent: a bare `$LASTEXITCODE = $null` shadows the
        # automatic variable in a child scope but not at process top level. That
        # difference made the gate report "tsc could not be invoked" on every
        # real run while C and D passed - a green self-test over a gate that did
        # not work through the only path anyone uses. These two cases run the
        # gate the way the orchestrator does, against a synthetic console with a
        # real tsconfig and a real compiler.
        $consoleRepo = Join-Path $tempRoot 'synthetic-console'
        New-Item -ItemType Directory -Path (Join-Path $consoleRepo 'apps/fiab-console/lib') -Force | Out-Null
        # Written, not copied from the fixture: the fixture's include is
        # ["*.ts"] (top-level only), which under lib/ resolves to NO inputs and
        # makes tsc exit non-zero with TS18003. Case I would then have "passed"
        # on an empty-project error rather than on the type error it claims to
        # detect - which is what case J exists to catch, and did.
        $consoleTsconfig = @(
            '{',
            '  "compilerOptions": {',
            '    "target": "ES2022",',
            '    "lib": ["ES2022"],',
            '    "module": "esnext",',
            '    "moduleResolution": "bundler",',
            '    "strict": true,',
            '    "noEmit": true,',
            '    "incremental": false,',
            '    "skipLibCheck": true,',
            '    "types": []',
            '  },',
            '  "include": ["**/*.ts"],',
            '  "exclude": ["node_modules", "**/*.test.ts", "**/__tests__/**"]',
            '}'
        )
        Set-Content -Path (Join-Path $consoleRepo 'apps/fiab-console/tsconfig.build.json') -Value $consoleTsconfig -Encoding ASCII
        Set-Content -Path (Join-Path $consoleRepo 'apps/fiab-console/lib/ok.ts') -Value 'export const ok: number = 1;' -Encoding ASCII

        $consoleGitOk = $true
        function Invoke-ConsoleGit {
            param([string[]]$GitArgs)
            $global:LASTEXITCODE = $null
            & git -C $consoleRepo @GitArgs 2>&1 | Out-Null
            if ($global:LASTEXITCODE -ne 0) { $script:consoleGitOk = $false }
        }

        Invoke-ConsoleGit @('init', '-b', 'main', '-q')
        Invoke-ConsoleGit @('config', 'user.email', 'gate-selftest@localhost')
        Invoke-ConsoleGit @('config', 'user.name', 'Gate Self Test')
        Invoke-ConsoleGit @('config', 'commit.gpgsign', 'false')
        Invoke-ConsoleGit @('add', '-A')
        Invoke-ConsoleGit @('commit', '-q', '-m', 'seed console')

        if (-not $consoleGitOk) {
            Add-Case 'I/J validate-all -> TypeScript, production path' 'NotRun' 'could not build the synthetic console repo'
        } else {
            # I: a COMPILED console file with a type error must fail the suite.
            Invoke-ConsoleGit @('checkout', '-q', '-b', 'break-compiled')
            Set-Content -Path (Join-Path $consoleRepo 'apps/fiab-console/lib/broken.ts') -Value 'export const broken: number = "not a number";' -Encoding ASCII
            Invoke-ConsoleGit @('add', '-A')
            Invoke-ConsoleGit @('commit', '-q', '-m', 'break a compiled console file')

            $i = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $consoleRepo) -WorkingDirectory $consoleRepo
            if ($i.ExitCode -eq 1 -and $i.Output -match 'TypeScript \(required\): \[FAIL\]') {
                Add-Case 'I  broken compiled console file FAILS the suite (exit 1)' 'Pass' "exit $($i.ExitCode)"
            } elseif ($i.Output -match 'could not be invoked') {
                Add-Case 'I  broken compiled console file FAILS the suite (exit 1)' 'Fail' "the gate could not read tsc's exit code through the orchestrator's `& invocation - scope-shadowing regression. exit $($i.ExitCode)"
            } else {
                Add-Case 'I  broken compiled console file FAILS the suite (exit 1)' 'Fail' "expected exit 1 with TypeScript [FAIL], got exit $($i.ExitCode)"
            }

            # J: the same path, clean, must exit 0. Without this, case I would
            # also pass if the gate failed unconditionally.
            Invoke-ConsoleGit @('checkout', '-q', 'main')
            Invoke-ConsoleGit @('checkout', '-q', '-b', 'add-clean')
            Set-Content -Path (Join-Path $consoleRepo 'apps/fiab-console/lib/more.ts') -Value 'export const more: string = "fine";' -Encoding ASCII
            Invoke-ConsoleGit @('add', '-A')
            Invoke-ConsoleGit @('commit', '-q', '-m', 'add a clean compiled console file')

            $j = Invoke-Child -ScriptPath $validateAll -Arguments @('-RepoRoot', $consoleRepo) -WorkingDirectory $consoleRepo
            if ($j.ExitCode -eq 0 -and $j.Output -match 'TypeScript \(required\): \[PASS\]') {
                Add-Case 'J  clean compiled console file PASSES the suite (exit 0)' 'Pass' "exit $($j.ExitCode)"
            } else {
                Add-Case 'J  clean compiled console file PASSES the suite (exit 0)' 'Fail' "expected exit 0 with TypeScript [PASS], got exit $($j.ExitCode)"
            }

            # --- Case K: validate-all invoked with `&` from a PARENT .ps1. ---
            #
            # Every other case launches validate-all as `pwsh -File`, which is
            # the shape Makefile, task-templates.json and readonly.py use - and
            # under that shape a bare `$LASTEXITCODE = $null` reads back
            # correctly. Under `& validate-all.ps1` from a parent script it does
            # NOT: the assignment creates a scope-local that shadows the
            # automatic variable, every gate reads $null, and the whole suite
            # collapses to NotRun -> required-NotRun -> exit 3. That failure is
            # SAFE, which is precisely why it hides.
            #
            # The bug shape has now appeared three times in this change's
            # history (Invoke-Git, validate-typescript's tsc read, and the five
            # gate call sites). This case exists so there is no fourth: it drives
            # the child-scope shape against a repo whose correct answer is a real
            # FAIL, so laundering measurements into NotRun cannot pass it.
            Invoke-ConsoleGit @('checkout', '-q', 'break-compiled')

            $parentPs1 = Join-Path $tempRoot 'parent-invoker.ps1'
            $parentLines = @(
                '# Invokes a gate with the CALL OPERATOR, creating a child scope.',
                'param([string]$GatePath, [string]$Repo)',
                '& $GatePath -RepoRoot $Repo',
                '$code = $LASTEXITCODE',
                'if ($null -eq $code) { Write-Host "PARENT: child exit code was NULL"; exit 99 }',
                'Write-Host "PARENT: child exit code $code"',
                'exit $code'
            )
            Set-Content -Path $parentPs1 -Value $parentLines -Encoding ASCII

            $k = Invoke-Child -ScriptPath $parentPs1 `
                -Arguments @('-GatePath', $validateAll, '-Repo', $consoleRepo) `
                -WorkingDirectory $consoleRepo

            if ($k.ExitCode -eq 1 -and $k.Output -match 'TypeScript \(required\): \[FAIL\]') {
                Add-Case 'K  child-scope (& parent.ps1) invocation still measures' 'Pass' "exit $($k.ExitCode)"
            } elseif ($k.Output -match 'TypeScript \(required\): \[NOT VERIFIED\]') {
                Add-Case 'K  child-scope (& parent.ps1) invocation still measures' 'Fail' "gates collapsed to NOT VERIFIED under `& invocation - a bare `$LASTEXITCODE assignment is shadowing the automatic variable. exit $($k.ExitCode)"
            } else {
                Add-Case 'K  child-scope (& parent.ps1) invocation still measures' 'Fail' "expected exit 1 with TypeScript [FAIL], got exit $($k.ExitCode)"
            }
        }

        # --- Case C: the committed fixture must compile clean. ---
        $c = Invoke-Child -ScriptPath $validateTs -Arguments @('-RepoRoot', $RepoRoot, '-ProjectDir', $fixture) -WorkingDirectory $RepoRoot
        if ($c.ExitCode -eq 0) {
            Add-Case 'C  clean TypeScript fixture exits 0' 'Pass' "exit $($c.ExitCode)"
        } else {
            Add-Case 'C  clean TypeScript fixture exits 0' 'Fail' "expected exit 0, got $($c.ExitCode). Output: $($c.Output)"
        }

        # --- Case D: the SAME fixture, mutated. The verdict must move. ---
        # Generated here rather than committed, so no deliberately-broken
        # TypeScript sits in the tree for someone to helpfully repair.
        $brokenDir = Join-Path $tempRoot 'typescript-broken'
        New-Item -ItemType Directory -Path $brokenDir -Force | Out-Null
        Copy-Item -Path (Join-Path $fixture '*') -Destination $brokenDir -Recurse -Force
        Add-Content -Path (Join-Path $brokenDir 'sample.ts') -Value 'export const mutated: number = "not a number";' -Encoding ASCII

        $d = Invoke-Child -ScriptPath $validateTs -Arguments @('-RepoRoot', $RepoRoot, '-ProjectDir', $brokenDir) -WorkingDirectory $RepoRoot
        if ($d.ExitCode -eq 1 -and $d.Output -match 'TYPESCRIPT TYPECHECK FAILED') {
            Add-Case 'D  mutated fixture exits 1 (verdict moves)' 'Pass' "exit $($d.ExitCode)"
        } else {
            Add-Case 'D  mutated fixture exits 1 (verdict moves)' 'Fail' "expected exit 1, got $($d.ExitCode). A gate that passes a deliberate type error is not compiling anything. Output: $($d.Output)"
        }

        # --- Case E: a project that does not exist is NOT RUN, never a pass. ---
        $missing = Join-Path $tempRoot 'no-such-project'
        $e = Invoke-Child -ScriptPath $validateTs -Arguments @('-RepoRoot', $RepoRoot, '-ProjectDir', $missing) -WorkingDirectory $RepoRoot
        if ($e.ExitCode -eq 2) {
            Add-Case 'E  missing project exits 2 NOT RUN' 'Pass' "exit $($e.ExitCode)"
        } else {
            Add-Case 'E  missing project exits 2 NOT RUN' 'Fail' "expected exit 2, got $($e.ExitCode)"
        }

        # --- Case F: a dangling override must not silently fall back. ---
        $env:LOOM_TSC_BIN = Join-Path $tempRoot 'no-such-compiler/bin/tsc'
        $f = Invoke-Child -ScriptPath $validateTs -Arguments @('-RepoRoot', $RepoRoot, '-ProjectDir', $fixture) -WorkingDirectory $RepoRoot
        if ($f.ExitCode -eq 2 -and $f.Output -match 'Refusing to fall back') {
            Add-Case 'F  dangling LOOM_TSC_BIN exits 2, no silent fallback' 'Pass' "exit $($f.ExitCode)"
        } else {
            Add-Case 'F  dangling LOOM_TSC_BIN exits 2, no silent fallback' 'Fail' "expected exit 2 and a refusal, got $($f.ExitCode)"
        }
        $env:LOOM_TSC_BIN = $compiler
    }
} finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
$failed = @($cases | Where-Object { $_.Status -eq 'Fail' })
$notRun = @($cases | Where-Object { $_.Status -eq 'NotRun' })
$passed = @($cases | Where-Object { $_.Status -eq 'Pass' })

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Self-Test Results" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Passed:    $($passed.Count)"
Write-Host "  Failed:    $($failed.Count)"
Write-Host "  Not run:   $($notRun.Count)"
Write-Host ""

if ($failed.Count -gt 0) {
    Write-Host "SELF-TEST FAILED - the gate machinery is not measuring what it reports." -ForegroundColor Red
    foreach ($c in $failed) { Write-Host "  $($c.Name): $($c.Detail)" -ForegroundColor Red }
    exit 1
}

# Zero cases is the same defect this whole script exists to catch, so it is
# spelled out rather than falling through to the success branch.
if ($passed.Count -eq 0) {
    Write-Host "NOT VERIFIED - no self-test case could run. This is NOT a pass." -ForegroundColor Yellow
    foreach ($c in $notRun) { Write-Host "  $($c.Name): $($c.Detail)" -ForegroundColor Yellow }
    exit 2
}

if ($notRun.Count -gt 0) {
    Write-Host "PARTIAL - $($passed.Count) case(s) passed, $($notRun.Count) could not run here." -ForegroundColor Yellow
    foreach ($c in $notRun) { Write-Host "  $($c.Name): $($c.Detail)" -ForegroundColor Yellow }
    exit 2
}

Write-Host "All self-test cases passed. The gate verdicts move with their inputs." -ForegroundColor Green
exit 0

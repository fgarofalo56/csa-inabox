<#
.SYNOPSIS
    Self-test for validate-bicep.ps1: proves it measures a real population and
    never writes into the tree it is judging.

.DESCRIPTION
    Exit codes:
      0 - every case behaved as expected
      1 - a case disagreed: the gate is not behaving as it reports
      2 - COULD NOT RUN (bicep unavailable, or no case could execute)

    WHY THIS EXISTS

    Two defects in validate-bicep.ps1, both found while running it for PR #3892
    and filed as #3894:

      1. It compiled each .bicep IN PLACE and then deleted the sibling .json.
         Exactly one tracked file collides with that assumption -
         deploy/bicep/landing-zone-alz/modules/networking/subnet/subnet.json,
         a COMMITTED ARM template rather than a build artifact - so every local
         run destroyed it, and a `git add -A` afterwards committed the deletion.

      2. It matched its exclusion list against ABSOLUTE paths. Since every agent
         in this repo works in .claude/worktrees/agent-*, $RepoRoot itself was an
         excluded path there: the walk returned 0 files and the gate exited 2
         having measured NOTHING. A non-zero exit that means "I am blind" reads
         as a validation failure, and this repo has been burned by that shape
         repeatedly - a guard that scans an empty set is neither passing nor
         failing.

    The cases below are PAIRS wherever a single arm could pass for the wrong
    reason. The load-bearing pair is N3a/N3b: the SAME file set walked from two
    different roots, where each root must see its own files and only its own.
    A gate that excluded everything, or excluded nothing, fails one half.

      N1  a hand-written sibling .json SURVIVES a passing compile, and the run
          genuinely measured (population 1). Without the population half, a gate
          that compiled nothing would also leave the file alone.
      N2  the gate writes NOTHING into the tree: the file inventory after the
          run is byte-for-byte the inventory before it - asserted only once the
          population is confirmed non-zero, for the same reason.
      N3a from the PRIMARY root, a nested .claude/worktrees copy is EXCLUDED.
      N3b from INSIDE that same worktree, its files are INCLUDED. (0 before the
          fix - the defect, direct.)
      N3c the SAME root spelled with FORWARD SLASHES. Join-Path always emits
          backslashes, so this input has to be built by string surgery - which
          is why the first fix for #3894 closed only the casing variant of the
          prefix-strip and this suite could not see the separator variant.
      N3d a RELATIVE root ('.'), the same failure reached another way.
      N3e a root that does not EXIST is diagnosed as unresolvable, not silently
          reported as an empty tree.
      N4  a root with no .bicep at all: exit 2, and the output says ZERO
          POPULATION rather than anything that reads as a pass.
      N5  a broken .bicep: exit 1. Redirecting compiler output to a scratch file
          must not swallow diagnostics - without this, N1 would still pass on a
          gate that had stopped detecting failures at all.
      N6  a root whose only .bicep files are all excluded: exit 2, and the
          message distinguishes "the filter ate everything" from "the tree is
          empty". Those have different fixes, so they get different words.
#>

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepoRoot
)

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

$ErrorActionPreference = 'Continue'
$gateScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'validate-bicep.ps1'

if ($WhatIfPreference) {
    Write-Host "=== validate-bicep Self-Test (-WhatIf) ===" -ForegroundColor Cyan
    Write-Host "  Would build synthetic trees and assert that validate-bicep.ps1"
    Write-Host "  reports a real population and leaves the tree untouched."
    Write-Host "  Nothing was measured. This is NOT a pass." -ForegroundColor Yellow
    exit 2
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  validate-bicep Self-Test (#3894)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# The host we are already running under, so the child gate runs on the same
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

function Invoke-Gate {
    param([string]$Root, [string]$WorkingDirectory)
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $argLine = @('-NoProfile', '-File', (Quote-Arg $gateScript), '-RepoRoot', (Quote-Arg $Root))

    $proc = Start-Process -FilePath $psExe -ArgumentList $argLine `
        -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    $text = ''
    $text += (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    $text += (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Output = "$text" }
}

# An inventory of every file under a root, with its exact bytes hashed. This is
# how N2 proves the gate wrote nothing: comparing a directory listing alone
# would miss an in-place overwrite, which is what actually happened to
# subnet.json before it was deleted.
function Get-Inventory {
    param([string]$Root)
    return (Get-ChildItem -Path $Root -Recurse -File |
        Sort-Object FullName |
        ForEach-Object { "$($_.FullName.Substring($Root.Length))|$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }) -join "`n"
}

$validBicep = @(
    "param location string = 'eastus'",
    "output loc string = location"
)
$brokenBicep = @(
    "param location string = 'eastus'",
    "output loc string = thisSymbolDoesNotExist"
)
# Deliberately NOT valid ARM: if the gate ever regenerates over this file, the
# content check fails even when the path still exists.
$committedArm = '{ "__sentinel__": "committed ARM template, not a build artifact" }'

if (-not (Get-Command bicep -ErrorAction SilentlyContinue)) {
    Add-Case 'all cases' 'NotRun' 'bicep is not on PATH, so the gate would exit 2 for the toolchain reason and every assertion below would pass or fail for the wrong reason. `az bicep install` puts bicep in ~/.azure/bin, which is NOT on PATH by default - add that directory.'
} else {

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("loom-bicep-selftest-" + [Guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    # =======================================================================
    # N1 / N2 - the gate does not write into the tree it is judging.
    # =======================================================================
    $treeA = Join-Path $tempRoot 'tree-a'
    New-Item -ItemType Directory -Path $treeA -Force | Out-Null
    Set-Content -Path (Join-Path $treeA 'a.bicep') -Value $validBicep -Encoding ASCII
    Set-Content -Path (Join-Path $treeA 'a.json')  -Value $committedArm -Encoding ASCII

    $before = Get-Inventory $treeA
    $n1 = Invoke-Gate -Root $treeA -WorkingDirectory $treeA
    $after = Get-Inventory $treeA

    $armPath = Join-Path $treeA 'a.json'
    $armSurvived = Test-Path $armPath
    $armIntact = $armSurvived -and ((Get-Content $armPath -Raw).Trim() -eq $committedArm)
    $measured = ($n1.Output -match 'Population: 1 ')

    if (-not $measured) {
        Add-Case 'N1 a committed sibling .json survives a MEASURED compile' 'Fail' "the gate did not report a population of 1, so the file surviving proves nothing. exit $($n1.ExitCode). Output: $($n1.Output)"
    } elseif ($n1.ExitCode -ne 0) {
        Add-Case 'N1 a committed sibling .json survives a MEASURED compile' 'Fail' "expected exit 0 from a valid template, got $($n1.ExitCode). Output: $($n1.Output)"
    } elseif (-not $armSurvived) {
        Add-Case 'N1 a committed sibling .json survives a MEASURED compile' 'Fail' 'the gate DELETED a .json it did not create - #3894 defect 1 has regressed'
    } elseif (-not $armIntact) {
        Add-Case 'N1 a committed sibling .json survives a MEASURED compile' 'Fail' 'the gate OVERWROTE a .json it did not create - the file is still there but its contents are not the operator''s'
    } else {
        Add-Case 'N1 a committed sibling .json survives a MEASURED compile' 'Pass' "population 1, exit 0, sentinel intact"
    }

    # The population precondition is N2's whole claim to being a control. Without
    # it, "the tree did not change" is trivially true of a gate that compiled
    # NOTHING - which is exactly the vacuous-pass shape this suite exists to
    # catch, and exactly what happened when these cases were first run against
    # the pre-fix gate: every synthetic tree sits under %TEMP%, whose \Temp\
    # segment that gate's absolute-path filter excluded, so N2 passed over a
    # population of zero while N1 correctly failed. A control that cannot fail at
    # zero population is not a control.
    if (-not $measured) {
        Add-Case 'N2 the gate writes NOTHING into the tree it judges' 'Fail' "population was not 1, so an unchanged tree proves nothing - the gate may simply have compiled nothing. exit $($n1.ExitCode). Output: $($n1.Output)"
    } elseif ($before -eq $after) {
        Add-Case 'N2 the gate writes NOTHING into the tree it judges' 'Pass' 'file inventory + SHA256 identical before and after, over a population of 1'
    } else {
        Add-Case 'N2 the gate writes NOTHING into the tree it judges' 'Fail' "the tree changed across the run.`nBEFORE:`n$before`nAFTER:`n$after"
    }

    # =======================================================================
    # N3a / N3b - the exclusion is RELATIVE to the root being walked.
    #
    # One tree, two roots. This pair is the whole of defect 2: a gate that
    # matched absolute paths gets N3a right and N3b catastrophically wrong,
    # and a gate that simply dropped the exclusion gets N3b right and N3a
    # wrong. Only relative matching satisfies both.
    # =======================================================================
    $treeB = Join-Path $tempRoot 'tree-b'
    $nested = Join-Path $treeB '.claude/worktrees/agent-x'
    New-Item -ItemType Directory -Path $nested -Force | Out-Null
    Set-Content -Path (Join-Path $treeB 'top.bicep') -Value $validBicep -Encoding ASCII
    Set-Content -Path (Join-Path $nested 'nested.bicep') -Value $validBicep -Encoding ASCII

    $n3a = Invoke-Gate -Root $treeB -WorkingDirectory $treeB
    if ($n3a.ExitCode -eq 0 -and $n3a.Output -match 'Population: 1 Bicep file\(s\) to compile \(2 found, 1 excluded\)') {
        Add-Case 'N3a from the primary root, a NESTED worktree copy is excluded' 'Pass' 'population 1 of 2 found, 1 excluded'
    } else {
        Add-Case 'N3a from the primary root, a NESTED worktree copy is excluded' 'Fail' "expected exit 0 and 'Population: 1 ... (2 found, 1 excluded)', got exit $($n3a.ExitCode). Output: $($n3a.Output)"
    }

    $n3b = Invoke-Gate -Root $nested -WorkingDirectory $nested
    if ($n3b.ExitCode -eq 0 -and $n3b.Output -match 'Population: 1 Bicep file\(s\) to compile \(1 found, 0 excluded\)') {
        Add-Case 'N3b from INSIDE a worktree, its own files ARE measured' 'Pass' 'population 1, exit 0'
    } elseif ($n3b.Output -match 'ZERO POPULATION') {
        Add-Case 'N3b from INSIDE a worktree, its own files ARE measured' 'Fail' '#3894 defect 2 has regressed: the gate is blind in the one place every agent in this repo works. It exited 2 having measured nothing.'
    } else {
        Add-Case 'N3b from INSIDE a worktree, its own files ARE measured' 'Fail' "expected exit 0 and 'Population: 1 ... (1 found, 0 excluded)', got exit $($n3b.ExitCode). Output: $($n3b.Output)"
    }

    if ($n3a.Output -match 'Population: 1 ' -and $n3b.Output -match 'Population: 1 ') {
        Add-Case 'N3a/N3b each root sees its OWN files and only its own' 'Pass' 'the same file set, walked from two roots, yields the correct population from each'
    } else {
        Add-Case 'N3a/N3b each root sees its OWN files and only its own' 'Fail' 'one half of the pair did not report a population of 1; the exclusion is not being evaluated relative to the root'
    }

    # =======================================================================
    # N3c - the SAME root, spelled with FORWARD SLASHES.
    #
    # This case exists because the first fix for #3894 closed the casing variant
    # of the prefix-strip and left the separator variant wide open, and this
    # suite could not see it: Join-Path ALWAYS emits backslashes, so the harness
    # was structurally incapable of constructing the failing input. The bad root
    # has to be built by string surgery, which is why this case looks different
    # from its neighbours - that difference is the point, not an inconsistency.
    #
    # Forward slashes are the NATURAL spelling here, not an exotic one: an agent
    # inside a worktree running `validate-all.ps1 -RepoRoot "$(pwd)"` from Git
    # Bash produces exactly this, and against the real worktree it measured
    # Population: 0 (351 found, 351 excluded), RC=2 - #3894 in full.
    #
    # A relative root is the same failure mode reached a different way, so both
    # spellings are asserted.
    # =======================================================================
    $nestedFwd = $nested.Replace('\', '/')
    $n3c = Invoke-Gate -Root $nestedFwd -WorkingDirectory $nested
    if ($n3c.ExitCode -eq 0 -and $n3c.Output -match 'Population: 1 Bicep file\(s\) to compile \(1 found, 0 excluded\)') {
        Add-Case 'N3c the same root spelled with FORWARD SLASHES still measures' 'Pass' 'population 1, exit 0'
    } elseif ($n3c.Output -match 'ZERO POPULATION') {
        Add-Case 'N3c the same root spelled with FORWARD SLASHES still measures' 'Fail' 'the root prefix failed to strip on the separator, so every file was filtered as an ABSOLUTE path and excluded. #3894 has regressed through a different spelling of the root.'
    } else {
        Add-Case 'N3c the same root spelled with FORWARD SLASHES still measures' 'Fail' "expected exit 0 and 'Population: 1 ... (1 found, 0 excluded)', got exit $($n3c.ExitCode). Output: $($n3c.Output)"
    }

    # N3d - a RELATIVE root, resolved against the child's working directory.
    $n3d = Invoke-Gate -Root '.' -WorkingDirectory $nested
    if ($n3d.ExitCode -eq 0 -and $n3d.Output -match 'Population: 1 Bicep file\(s\) to compile \(1 found, 0 excluded\)') {
        Add-Case 'N3d a RELATIVE root still measures' 'Pass' 'population 1, exit 0'
    } else {
        Add-Case 'N3d a RELATIVE root still measures' 'Fail' "expected exit 0 and 'Population: 1 ... (1 found, 0 excluded)', got exit $($n3d.ExitCode). Output: $($n3d.Output)"
    }

    # N3e - a root that does not exist is NOT a population verdict.
    # Without this, the Resolve-Path added for N3c/N3d could throw or silently
    # produce a null prefix, and the gate would fall through to a ZERO POPULATION
    # message that misdiagnoses a typo'd root as an empty tree.
    $missingRoot = Join-Path $tempRoot 'no-such-root-here'
    $n3e = Invoke-Gate -Root $missingRoot -WorkingDirectory $tempRoot
    if ($n3e.ExitCode -eq 2 -and $n3e.Output -match 'UNRESOLVABLE ROOT') {
        Add-Case 'N3e a nonexistent root is diagnosed as UNRESOLVABLE, not as empty' 'Pass' 'exit 2, named distinctly from ZERO POPULATION'
    } else {
        Add-Case 'N3e a nonexistent root is diagnosed as UNRESOLVABLE, not as empty' 'Fail' "expected exit 2 and 'UNRESOLVABLE ROOT', got exit $($n3e.ExitCode). Output: $($n3e.Output)"
    }

    # =======================================================================
    # N4 - zero population is NOT a pass, and says so in its own words.
    # =======================================================================
    $treeC = Join-Path $tempRoot 'tree-c'
    New-Item -ItemType Directory -Path $treeC -Force | Out-Null
    Set-Content -Path (Join-Path $treeC 'readme.md') -Value 'no templates here' -Encoding ASCII

    $n4 = Invoke-Gate -Root $treeC -WorkingDirectory $treeC
    if ($n4.Output -match 'ALL BICEP FILES VALID') {
        Add-Case 'N4 an empty population is NOT reported as a pass' 'Fail' 'the gate declared every file valid over a population of zero'
    } elseif ($n4.ExitCode -eq 2 -and $n4.Output -match 'ZERO POPULATION' -and $n4.Output -match 'No \.bicep file exists anywhere under that root') {
        Add-Case 'N4 an empty population is NOT reported as a pass' 'Pass' "exit 2, named as ZERO POPULATION (empty tree)"
    } else {
        Add-Case 'N4 an empty population is NOT reported as a pass' 'Fail' "expected exit 2 with an explicit ZERO POPULATION message, got exit $($n4.ExitCode). Output: $($n4.Output)"
    }

    # =======================================================================
    # N5 - the verdict still MOVES. Sending compiler output to a scratch file
    # must not cost the gate its ability to see a failure.
    # =======================================================================
    $treeD = Join-Path $tempRoot 'tree-d'
    New-Item -ItemType Directory -Path $treeD -Force | Out-Null
    Set-Content -Path (Join-Path $treeD 'broken.bicep') -Value $brokenBicep -Encoding ASCII

    $n5 = Invoke-Gate -Root $treeD -WorkingDirectory $treeD
    if ($n5.ExitCode -eq 1 -and $n5.Output -match 'VALIDATION FAILED' -and $n5.Output -match 'Population: 1 ') {
        Add-Case 'N5 a broken template still FAILS (exit 1)' 'Pass' "exit 1 over a population of 1"
    } else {
        Add-Case 'N5 a broken template still FAILS (exit 1)' 'Fail' "expected exit 1 with VALIDATION FAILED over population 1, got exit $($n5.ExitCode). Output: $($n5.Output)"
    }

    # =======================================================================
    # N6 - "the filter ate everything" is a DIFFERENT diagnosis from "the tree
    # is empty", and gets different words. Same exit code, different fix.
    # =======================================================================
    $treeE = Join-Path $tempRoot 'tree-e'
    $treeEnested = Join-Path $treeE '.claude/worktrees/agent-y'
    New-Item -ItemType Directory -Path $treeEnested -Force | Out-Null
    Set-Content -Path (Join-Path $treeEnested 'only.bicep') -Value $validBicep -Encoding ASCII

    $n6 = Invoke-Gate -Root $treeE -WorkingDirectory $treeE
    if ($n6.ExitCode -eq 2 -and $n6.Output -match 'EVERY file found was excluded') {
        Add-Case 'N6 an all-excluded population is diagnosed distinctly' 'Pass' 'exit 2, and the message names the filter rather than the tree'
    } else {
        Add-Case 'N6 an all-excluded population is diagnosed distinctly' 'Fail' "expected exit 2 and 'EVERY file found was excluded', got exit $($n6.ExitCode). Output: $($n6.Output)"
    }
} finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

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
    Write-Host "SELF-TEST FAILED - validate-bicep.ps1 is not behaving as it reports." -ForegroundColor Red
    foreach ($c in $failed) { Write-Host "  $($c.Name): $($c.Detail)" -ForegroundColor Red }
    exit 1
}

# Zero cases is the same class of defect this script exists to catch, so it is
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

Write-Host "All self-test cases passed. validate-bicep measures a real population and leaves the tree alone." -ForegroundColor Green
exit 0

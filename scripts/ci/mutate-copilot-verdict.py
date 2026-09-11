"""Mutation harness for the Copilot UAT scoring decision.

Run:  python scripts/ci/mutate-copilot-verdict.py

WHY THIS IS COMMITTED. Two rounds of review found this decision under-covered,
and both times the evidence offered was a mutation harness that lived only in
`temp/` -- so the reviewer could not re-run it and had to rebuild one. A
mutation proof that cannot be reproduced is a claim, not a receipt.

WHY IT ASSERTS THE RUNNER RAN. An earlier version of this harness reported
"mutant killed" on a run that never started: `subprocess.run(list, shell=True)`
on Windows hands only argv[0] to cmd.exe, the process died with
"'node_modules' is not recognized", and a launch failure's non-zero exit is
indistinguishable from a failing assertion. Every result below is INCONCLUSIVE
unless the runner emitted a summary line.

WHY THE ANCHORS ARE ASSERTED UNIQUE. A needle that matches zero applies no
mutation, and the unmutated suite then passes and reads as a survivor -- or as
a kill, depending on which way you were hoping. Each anchor must match exactly
once or the harness stops.

The mutations are chosen to be the ones REVIEWERS actually raised, plus the
places a decision could migrate back into unreachable glue.
"""
import os
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def read_text(path):
    """Read preserving line endings verbatim.

    `newline=""` is load-bearing, not style: the working tree is CRLF and a
    round-trip through universal newlines would rewrite every line of the file
    being mutated, so the restore at the end would not be byte-identical and the
    harness would silently leave the tree dirty.
    """
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONSOLE = os.path.join(ROOT, "apps", "fiab-console")
MODULE = os.path.join(CONSOLE, "e2e", "_lib", "copilot-verdict.ts")
CALLER = os.path.join(CONSOLE, "e2e", "copilot.uat.ts")
CS_CLIENT = os.path.join(CONSOLE, "lib", "azure", "copilot-studio-client.ts")
# The error CONTRACT moved out of the client so the client stays under its
# check-file-size ratchet ceiling. M15/M16 mutate the envelope and therefore
# follow it; M14 stays on the client, where the enablement throw lives.
CS_ERROR = os.path.join(CONSOLE, "lib", "azure", "copilot-studio-error.ts")
SUITES = [
    "__tests__/copilot-uat-verdict.test.ts",
    "app/api/copilot/__tests__/orchestrate-error-envelope-4432.test.ts",
    # Load-bearing: `check-route-toolkit.mjs`'s TOUCH_EXEMPT entry for
    # help-copilot/chat cites THIS harness as the thing that proves its
    # compensating control. That sentence was false when written -- this suite
    # was absent here and no mutation targeted that route, so the claim
    # justifying a step around a required guard was not exercised by anything.
    "app/api/help-copilot/__tests__/chat-gate-codes.test.ts",
    # The Copilot Studio half. GATE_CODES named `copilot_studio_not_enabled`
    # while NOTHING under app/api/** emitted it, so the honest gate arrived
    # CODELESS and the codeless-5xx rule scored it a fault. M14-M17 mutate that
    # fix; without this suite in the list they have nothing that can kill them.
    "__tests__/copilot-studio-gate-code.test.ts",
]
VITEST = os.path.join(CONSOLE, "node_modules", ".bin", "vitest.cmd")
if not os.path.exists(VITEST):  # non-Windows
    VITEST = os.path.join(CONSOLE, "node_modules", ".bin", "vitest")

# (label, file, from, to)
MUTATIONS = [
    ("M1  drop the must-answer arm from the combination", MODULE,
     "  const bad = verdict === 'fail' || mustAnswer;",
     "  const bad = verdict === 'fail';"),
    ("M2  re-widen the codeless-5xx tolerance (the pre-fix state)", MODULE,
     "    if ([401, 403, 424].includes(p.status)) {",
     "    if ([401, 403, 424, 500, 502, 503].includes(p.status)) {"),
    ("M3  treat every deliberate gate code as non-deliberate", MODULE,
     "  return !DELIBERATE_GATE_CODES.includes(gateCodeOf(p));",
     "  return true;"),
    ("M4  invert the opt-out (review 2's MUT-D, now inside the module)", MODULE,
     "  return env.LOOM_UAT_ALLOW_AOAI_GATE === 'true';",
     "  return env.LOOM_UAT_ALLOW_AOAI_GATE !== 'true';"),
    ("M5  stop `actual` tracking `bad` (review 3's G1)", MODULE,
     "    actual: bad ? 'fail' : verdict,",
     "    actual: verdict,"),
    ("M6  stop `grade` tracking `bad` (review 3's G2)", MODULE,
     "    grade: bad ? 'F' : 'A',",
     "    grade: 'A',"),
    ("M7  stop `status` tracking `bad` (review 3's G3)", MODULE,
     "    status: bad ? 'fail' : 'pass',",
     "    status: 'pass',"),
    ("M8  drop a persona from the AOAI set (review 3's G5)", MODULE,
     "  'persona:help-copilot',",
     ""),
    ("M9  delete the documented gate code from the orchestrate route",
     os.path.join(CONSOLE, "app", "api", "copilot", "orchestrate", "route.ts"),
     "{ ok: false, code: 'no_aoai', error: e.message }",
     "{ ok: false, error: e.message }"),
    ("M10 collapse the 502 into the gate code (outage reads as 'not configured')",
     os.path.join(CONSOLE, "app", "api", "copilot", "orchestrate", "route.ts"),
     "{ ok: false, code: 'aoai_unreachable', error: e?.message || String(e) }",
     "{ ok: false, code: 'no_aoai', error: e?.message || String(e) }"),
    # M11-M13 are the COMPENSATING CONTROL for the help-copilot/chat
    # TOUCH_EXEMPT entry. That exemption steps around a required guard, and its
    # justification names this harness -- so the harness has to actually kill a
    # deletion in that route, or the justification is prose.
    ("M11 delete the gate code from the help-copilot chat route",
     os.path.join(CONSOLE, "app", "api", "help-copilot", "chat", "route.ts"),
     "{ ok: false, code: 'no_aoai', error: e.message, gate: 'aoai' }",
     "{ ok: false, error: e.message, gate: 'aoai' }"),
    ("M12 collapse help-copilot's 502 into the gate code",
     os.path.join(CONSOLE, "app", "api", "help-copilot", "chat", "route.ts"),
     "{ ok: false, code: 'aoai_unreachable', error: e?.message || String(e) }",
     "{ ok: false, code: 'no_aoai', error: e?.message || String(e) }"),
    ("M13 remove help-copilot's 401 prologue (the exemption's other claim)",
     os.path.join(CONSOLE, "app", "api", "help-copilot", "chat", "route.ts"),
     "    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });",
     "    return NextResponse.json({ ok: false, error: 'anonymous-ok' }, { status: 200 });"),
    # M14-M17: the Copilot Studio half. GATE_CODES listed a code nothing
    # emitted, so every one of these would have SURVIVED before this change --
    # there was no code to delete and no envelope to break.
    ("M14 stop the Copilot Studio enablement throw carrying its code", CS_CLIENT,
     "        503, json || text, url, COPILOT_STUDIO_NOT_ENABLED,",
     "        503, json || text, url,"),
    ("M15 give an UNEXPLAINED error the gate code (a fault reads as a gate)", CS_ERROR,
     "  const code = isCs ? (e.code || COPILOT_STUDIO_ERROR) : COPILOT_STUDIO_UNREACHABLE;",
     "  const code = isCs ? (e.code || COPILOT_STUDIO_NOT_ENABLED) : COPILOT_STUDIO_UNREACHABLE;"),
    ("M16 call an UNREACHABLE backend 'not configured'", CS_ERROR,
     "  const code = isCs ? (e.code || COPILOT_STUDIO_ERROR) : COPILOT_STUDIO_UNREACHABLE;",
     "  const code = isCs ? (e.code || COPILOT_STUDIO_ERROR) : COPILOT_STUDIO_NOT_ENABLED;"),
    # M19: the re-export the fourteen existing importers rely on. Extracting the
    # contract is only safe while `CopilotStudioError` is still reachable from
    # the client module; deleting the re-export must not be silent.
    # A multi-line anchor would match ZERO here -- the worktree is CRLF and the
    # harness reads with newline="" -- and a zero-match anchor is a dead
    # mutation, so this is deliberately ONE line.
    ("M19 drop the client's re-export of the envelope (breaks the 14 importers)",
     CS_CLIENT,
     "  copilotStudioErrorEnvelope,\n} from '@/lib/azure/copilot-studio-error';",
     "} from '@/lib/azure/copilot-studio-error';"),
    ("M17 drop governance-copilot from the AOAI set (review 5's B2)", MODULE,
     "  'persona:governance-copilot',         // app/api/governance/govern/copilot",
     ""),
    ("M18 leave a driven persona unclassified (review 5's B3, the missing arm)",
     MODULE,
     "  'persona:copilot-template-library',   // Cosmos-backed gallery; no model call",
     ""),
]


def run_suites():
    p = subprocess.run(
        [VITEST, "run", *SUITES, "--reporter=basic"],
        cwd=CONSOLE, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=1800,
    )
    out = (p.stdout or "") + (p.stderr or "")
    ran = ("Test Files" in out) or ("Tests " in out)
    summary = ""
    for line in out.splitlines():
        if "Tests " in line and ("passed" in line or "failed" in line):
            summary = " ".join(line.split())
    return p.returncode, ran, summary, out


def to_file_eol(text, src):
    """Rewrite a needle's newlines to match the FILE's own line ending.

    The worktree is CRLF and `read_text` preserves that verbatim, so a
    multi-line anchor written with bare \\n matches ZERO -- and a zero-match
    anchor applies no mutation, which reads as a dead mutation rather than a
    kill. The harness already refuses on anchor != 1, so this never produced a
    false green; it produced a false STOP, which is its own kind of noise. This
    removes the trap instead of asking every future mutation to remember it.
    """
    eol = "\r\n" if "\r\n" in src else "\n"
    return text.replace("\r\n", "\n").replace("\n", eol)


def main():
    originals = {}
    for _, path, _, _ in MUTATIONS:
        if path not in originals:
            originals[path] = read_text(path)

    rc, ran, summary, out = run_suites()
    print(f"BASELINE rc={rc} ran={ran}  {summary}")
    if not ran:
        print("INCONCLUSIVE: the runner produced no summary; nothing below is evidence.")
        print(out[-800:])
        return 2
    if rc != 0:
        print("BASELINE IS RED -- fix that before reading any mutation result.")
        return 2

    survivors = []
    try:
        for label, path, frm, to in MUTATIONS:
            src = originals[path]
            frm = to_file_eol(frm, src)
            to = to_file_eol(to, src)
            n = src.count(frm)
            if n != 1:
                print(f"{label:<62} ANCHOR MATCHED {n} -- HARNESS STOPS")
                survivors.append(label + " (anchor)")
                continue
            write_text(path, src.replace(frm, to, 1))
            rc, ran, summary, _ = run_suites()
            write_text(path, src)
            if not ran:
                verdict = "INCONCLUSIVE (runner never ran)"
                survivors.append(label)
            elif rc != 0:
                verdict = "KILLED"
            else:
                verdict = "SURVIVED"
                survivors.append(label)
            print(f"{label:<62} {verdict:<32} {summary}")
    finally:
        for path, src in originals.items():
            write_text(path, src)
        ok = all(read_text(p) == s
                 for p, s in originals.items())
        print("all files restored byte-identical:", ok)

    print()
    if survivors:
        print(f"SURVIVORS ({len(survivors)}):")
        for s in survivors:
            print("  -", s)
        return 1
    print("No survivors: every mutation is covered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

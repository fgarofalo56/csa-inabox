"""Generate PRPs/active/drain-2026-08-31/LEDGER.md.

Reads the full open-issue inventory and emits a per-issue register covering
EVERY open issue. Triaged issues carry their measured verdict; everything else
is carried explicitly as PENDING-TRIAGE so the gap is visible rather than
implied.

Run (from the repo root):  python PRPs/active/drain-2026-08-31/gen-ledger.py

The issue snapshot lives NEXT TO this script, tracked in git — never in temp/
(temp/ is gitignored, and a generator whose input only exists in a working tree
cannot be re-run by the next session; see the extractor-walks-the-filesystem
failure class).
"""

import json
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")

SRC = "PRPs/active/drain-2026-08-31/open-issues-2026-08-31.json"
OUT = "PRPs/active/drain-2026-08-31/LEDGER.md"

# ---------------------------------------------------------------- verdict map
# (verdict, size, wave, lane, note)
V = {
    # --- triage batch a180c4bb41d203c86 (measured 2026-08-31) -------------
    3637: ("REAL", "M", "W5", "scripts", "No --rotate flag exists; flag-parse block lines 126-130"),
    3633: ("NEEDS-ESTATE", "M", "W4", "estate", "Metric-kind hardening ALREADY at eval-regression-lib.mjs:100-227; blocker is the live judge job"),
    3573: ("REAL", "M", "W2", "console-provisioners", "provisioners/ holds only eventstream.ts; route.ts:29-32 generic 502 reuses the 501 HINT"),
    3515: ("REAL", "S", "W2", "console-ui", "event-grid-topic-editor.tsx:474-475,532 raw <Input>; zero AzureResourcePicker"),
    3458: ("REAL", "L", "W5", "workflows", "Population DISPUTED (C1): 41 executed / 109 raw / 33 the guard can see. Direction not disputed."),
    3344: ("REAL", "M", "W5", "ci-guards", "Criterion 1 met; criterion 2 unmet - 23 `env[?name==` hits remain. Collides with #3956."),
    3327: ("NEEDS-ESTATE", "S", "W4", "estate", "All three code fixes on main; only the /admin/readiness receipt is owed"),
    # --- triage batch a253835b74fc3440c (measured 2026-08-31) -------------
    3915: ("REAL+NEEDS-DECISION", "L", "W2", "console-ui", "Runner image copies no raw lib/; repo-kind root unreachable. See OWED Q1."),
    3847: ("REAL", "L", "W2", "console-ui", "tsconfig confirmed missing the flag. BOUNDING PASS gates all of W2 (PRP §7)."),
    3748: ("REAL", "L", "W2", "console-ui", "Root-cause file NOT pinned; landing-zones-canvas.tsx read in full and CLEARED"),
    3736: ("NEEDS-ESTATE", "M", "W4", "estate", "Issue self-declares it cannot assert root cause without ContainerAppConsoleLogs_CL"),
    3727: ("REAL (RE-SCOPED)", "S", "W2", "console-ui", "NOT an 8x duplicate-query bug. Only site is all-items-explorer.tsx:133 and it pages correctly. Real gap: no cache/dedup across mounts."),
    3684: ("REAL", "M", "W2", "vscode", "LANE CORRECTED 2026-08-31: file is apps/loom-vscode/src/auth/device-code.ts, NOT the console. Disjoint tree (97 files vs 6283) - own lane, UNGATED by the #3847 bounding pass. device-code.ts read in full; the flow is real and complete."),
    # --- carried from earlier windows ------------------------------------
    3519: ("STALE", "-", "-", "-", "Already fixed at head - comes off the work list"),
    4101: ("STALE", "-", "-", "-", "Already fixed at head - comes off the work list"),
    4030: ("STALE-CODE / OWED-ROTATION", "S", "W4", "estate", "Code fixed (SHA256 fingerprint only). The PUBLISHED value must still be rotated. INHERITED - not re-verified at head 2026-08-31."),
    3941: ("REAL (RE-SCOPED)", "M", "W5", "ci-guards", "NOT an authz bypass. TOUCH_EXEMPT documents a disclosed deferral that FAILS CLOSED. Guard-strength gap."),
    4035: ("REAL+NEEDS-DECISION", "S", "W5", "ci-guards", "RE-MEASURED AT HEAD 2026-08-31 - PENDING-REVERIFY resolved. Path is scripts/github/configure-branch-protection.sh (NOT scripts/csa-loom/). THREE regressions, not one: contexts 15->3, strict back to true (the quadratic setting that starved runners into 12/12 false reds), enforce_admins true (revokes the standing --admin authorization). See FILES.md §5 + OWED Q2."),
    4064: ("PENDING-REVERIFY", "?", "W0", "deploy-C", "Rests on MEMORY, not a fresh grep - re-measure before the lane opens"),
    4038: ("REAL", "S", "W5", "ci-guards", "Mirror stuck at 14 while live protection carries 15. Issue's claimed unconditional exit 1 at :736 is CONDITIONAL. INHERITED - not re-verified at head 2026-08-31."),
    4036: ("REAL", "XS", "W3", "bicep", "RE-MEASURED: bicep chain is correctly wired (synapse.bicep:43 -> :415; admin-plane 5773/6038). Defect is that NO .bicepparam/.yml/.mjs/.sh ever sets loomOnelakeSecurityEnabled - defaults false at main.bicep:1446 + synapse.bicep:43, so OneLake Security ACL SHIPS DARK in every boundary. default-ON/opt-out violation."),
    3513: ("REAL", "L", "W3", "console-provisioners", "~5x its own text: 119 status:'remediation' sites across 26 files, zero Fix-it. Takes provisioners/** EXCLUSIVELY."),
    3525: ("NEEDS-ESTATE", "S", "W4", "estate", "5 sites at provisioners/kql-db.ts:81,105,131,147,173 - overlaps #3513's tree"),
    4136: ("REAL", "S", "W2", "console-ui", "COMBINE with #3543 - same file, KNOWN_CONTAINERS dup at 2897/3048"),
    3543: ("REAL", "S", "W2", "console-ui", "COMBINE with #4136 - same file, raw input at ~744-745"),
    3846: ("REAL", "M", "W5", "ci-guards", "Sequence before #3633 (eval-floors.json + check-eval-regression.mjs)"),
    3956: ("REAL", "M", "W5", "ci-guards", "Three defect classes all in check-env-sync.mjs. CROSS-AGENT COLLISION with #3344 - combine."),
    4046: ("REAL", "M", "W5", "ci-guards", "Sequence with #3941 in one loom-guardrails.yml lane"),
    3979: ("REAL", "L", "W5", "workflows", "Claims ~84 of 123 workflow files - MUST NARROW before scheduling (OWNERSHIP §2)"),
    3882: ("REAL", "M", "W0", "deploy-C", "CONFLICT C2 resolved by fresh measurement: 6 consecutive failures 2026-08-10 -> 2026-08-31"),
    # --- filed 2026-08-31 from OWED §1 (U3/U4/U5) + measured in that sweep --
    4233: ("REAL", "S", "W0", "deploy-B", "U4 filed. gcch scheduled runs park at the gcc-high-deploy approval gate since 08-27 (5 stacked, zero steps) — the declared symptom is unobservable and the #4117 stand-down machinery is unreachable. Supersedes the #4072 streak framing."),
    4234: ("REAL", "S", "W5", "ci-guards", "U3 filed (jest half; graph half was already #4029). jest (node 20.x) exists on main, absent from the 15 required contexts. Sequence with #4029 + #4038 mirror + Q2 script regen; tighten-last per the merge-gates decision."),
    4235: ("REAL", "M", "W1", "estate-power", "U5 filed. Gov resume path missing — estate-resume.mjs is all-Commercial by its own header; #4149's guard refuses correctly, the capability is absent. Lane opens with #3922."),
    4029: ("REAL", "S", "W5", "ci-guards", "Measured 2026-08-31: the graph drift check runs on main tip yet is absent from the 15 required contexts. Pair with #4234 in one protection change; #4038's mirror must take both."),
    # --- W0 broken deploy paths ------------------------------------------
    4231: ("REAL", "M", "W0", "deploy-A", "Three latent roll defects measured from run 33429557771: D1 health poll dies under -e on throttle (R6), D2 ~100s budget, D3 rollback asserts a FALSE 'does not exist' (R7). Stable tracker for auto-closed #4230; the throttle was a one-off (ten prior greens), so latent, not an outage."),
    3676: ("REAL", "M", "W0", "deploy-A", "Broken deploy path - P0 under deploy-integrity R1"),
    3683: ("REAL", "M", "W0", "deploy-B", "GCC-High + IL5 carry both halves of #3676 - same fix"),
    3754: ("REAL", "M", "W0", "deploy-A", "Broken deploy path - P0"),
    4190: ("REAL", "M", "W0", "deploy-A", "Broken deploy path - P0 (pairs with #4196)"),
    4196: ("REAL", "M", "W0", "deploy-A", "Broken deploy path - P0 (pairs with #4190)"),
    3968: ("REAL", "M", "W0", "deploy-A", "console-bluegreen-roll: 3 consecutive FAILURE, ~3 weeks stale (overlaps U2)"),
    3429: ("REAL", "M", "W0", "deploy-A", "Broken deploy path - P0"),
    4072: ("REAL", "L", "W0", "deploy-B", "deploy-fiab-gcch: 16 consecutive failures. PARKED to the W4 window - needs in-boundary diagnosis."),
    3449: ("REAL", "L", "W0", "deploy-B", "Same population as #4072"),
    4071: ("REAL", "S", "W0", "deploy-B", "deploy-fiab-gcc disabled_manually - FREE: re-enable, then measure"),
    4073: ("REAL", "S", "W0", "deploy-B", "deploy-fiab-il5 dispatch-only, never dispatched - FREE: add schedule: to on: (see U1). INHERITED - not re-verified at head 2026-08-31."),
    3346: ("REAL", "M", "W0", "deploy-C", "Dataplane roll / ACR"),
    4144: ("REAL", "M", "W0", "deploy-C", "Dataplane roll / ACR"),
    # --- W1 live operator bug reports ------------------------------------
    3339: ("REAL", "L", "W1", "iceberg", "LIVE OPERATOR BUG: Iceberg REST catalog dead in MAC and MAG"),
    3110: ("REAL", "L", "W1", "iceberg", "External-engine federation - chase the audience/credential-vending hypothesis in code"),
    3841: ("REAL", "M", "W1", "iceberg", "Iceberg lane"),
    3746: ("REAL", "M", "W1", "iceberg", "Iceberg lane"),
    3922: ("REAL", "M", "W1", "estate-power", "LIVE OPERATOR BUG: power button not enabled. Gov resume path missing (U5)."),
    4222: ("REAL", "S", "W1", "brain", "LIVE OPERATOR BUG: Brain has ZERO inbound links - linked from nowhere"),
    3933: ("REAL", "M", "W1", "brain", "Brain surface"),
    3934: ("REAL", "M", "W1", "brain", "Brain surface"),
    3937: ("REAL", "M", "W1", "brain", "Brain surface"),
    # --- console-api -----------------------------------------------------
    4016: ("PENDING-TRIAGE", "?", "W2", "console-api", ""),
    4183: ("PENDING-TRIAGE", "?", "W2", "console-api", ""),
}

# Explicit park list - operator decision: "Defects only, ignore features for now"
PARKED = {
    3777, 3776, 3775, 3774, 3773, 3772, 3771, 3770, 3769, 3768,
    3767, 3766, 3765, 3764, 3763, 3762, 3721, 3719, 3699, 3615,
    3589, 3538, 3536, 3535, 3527, 3361, 3355, 3354, 3352, 3351,
    3350, 3343, 1483,
}

FEATURE_LABELS = {"csa-feature-request", "enhancement", "epic"}


def esc(s: str) -> str:
    return s.replace("|", "\\|").replace("\r", "").strip()


def main() -> None:
    with open(SRC, encoding="utf-8") as fh:
        issues = json.load(fh)

    issues.sort(key=lambda i: -i["number"])

    rows = []
    counts = Counter()
    for it in issues:
        num = it["number"]
        title = esc(it["title"])
        if len(title) > 95:
            title = title[:92] + "..."
        labels = {lb["name"] for lb in it.get("labels", [])}

        if num in V:
            verdict, size, wave, lane, note = V[num]
        elif num in PARKED:
            verdict, size, wave, lane, note = ("PARKED-FEATURE", "-", "W6", "-", "")
        elif labels & FEATURE_LABELS:
            verdict, size, wave, lane, note = (
                "PENDING-TRIAGE", "?", "?", "?", "feature-labelled - confirm park or defect",
            )
        else:
            verdict, size, wave, lane, note = ("PENDING-TRIAGE", "?", "?", "?", "")

        counts[verdict.split(" ")[0].split("+")[0]] += 1
        rows.append((num, title, verdict, size, wave, lane, note))

    lines = []
    a = lines.append
    a("# LEDGER — per-issue register of record")
    a("")
    a("Companion to `PRP.md`. **Every open issue appears here exactly once.** An issue")
    a("absent from this table is a gap in the program, not an issue that does not matter.")
    a("")
    a(f"Measured {len(issues)} open issues on 2026-08-31. Generated by")
    a("`PRPs/active/drain-2026-08-31/gen-ledger.py` from a live `gh issue list`")
    a("snapshot (`open-issues-2026-08-31.json`, same directory) — re-run it rather")
    a("than hand-editing rows.")
    a("")
    a("**Per-issue file lists live in `FILES.md`**, not here. A row in this table names a")
    a("lane; the register in `FILES.md` names the files that lane may touch, with the")
    a("provenance of each list. `OWNERSHIP.md` §8 requires the file list before a lane opens.")
    a("")
    a("## Verdict vocabulary")
    a("")
    a("| Verdict | Meaning |")
    a("|---|---|")
    a("| `REAL` | Measured at head, still present, in scope |")
    a("| `REAL (RE-SCOPED)` | Real, but the issue title materially misdescribes it — the note governs, not the title |")
    a("| `STALE` | Already fixed at head. Comes off the work list; close with evidence |")
    a("| `NEEDS-ESTATE` | Code is done or not the blocker; needs a live estate receipt → W4 window |")
    a("| `NEEDS-DECISION` | Blocked on an operator choice → `OWED.md` §2 |")
    a("| `PENDING-REVERIFY` | Verdict rests on memory, not a fresh measurement. Re-measure before the lane opens |")
    a("| `PARKED-FEATURE` | Feature-class. Parked by operator decision, unparked in W6 |")
    a("| `PENDING-TRIAGE` | **Not yet triaged.** Carried explicitly — this is the honest gap |")
    a("")
    a("## Coverage")
    a("")
    a("| Verdict class | Count |")
    a("|---|---|")
    for verdict, n in counts.most_common():
        a(f"| `{verdict}` | {n} |")
    a(f"| **Total** | **{len(issues)}** |")
    a("")
    a("`PENDING-TRIAGE` is the number that matters. It is carried in the open rather than")
    a("rounded away: an untriaged issue has no verdict, no size, no lane, and cannot be")
    a("scheduled. W0 runs a read-only triage sweep to drive it toward zero.")
    a("")
    a("**This count supersedes the estimate in `PRP.md` §3.** That document was drafted")
    a("against a working estimate of ~153 untriaged; the measured number is the one above.")
    a("Where the two disagree, this table governs — it is derived from a live `gh issue")
    a("list`, and `PRP.md`'s figure was a projection.")
    a("")
    a("## Verification freshness")
    a("")
    a("A verdict is only as good as the measurement behind it, and the measurements here")
    a("were taken across several windows. Rows whose note ends **`INHERITED - not")
    a("re-verified at head`** carry a verdict measured in an earlier window and relayed —")
    a("not re-measured against the current tree. They are recorded as findings because the")
    a("original measurement was real, and flagged because a carried finding is a")
    a("**hypothesis** until re-measured.")
    a("")
    a("The re-verification lane for #4073 / #4064 / #4038 / #4036 / #4035 / #4030 disclosed")
    a("this itself: of the 23 rows it reported, **exactly one — #4036 — was measured in that")
    a("run.** The remaining 22 survived a plausibility check and nothing stronger. That is")
    a("why #4036 carries a file-and-line note and the others carry a provenance flag.")
    a("")
    a("**#4035 has since been closed out.** It was re-read at head 2026-08-31 and is `REAL`,")
    a("and larger than the row it replaced: three regressions rather than one, on a path that")
    a("is not where the earlier note said it was. That is one carried hypothesis converted to")
    a("a measurement — and the one conversion changed both the severity and the file. **#4064")
    a("remains `PENDING-REVERIFY`** and must be re-measured before its lane opens.")
    a("")
    a("**Consequence for scheduling:** a lane re-measures its own issues at head before")
    a("writing code (`DEV-LOOP.md` §10, box 1). An `INHERITED` row is schedulable; it is not")
    a("actionable until that box is checked.")
    a("")
    a("---")
    a("")
    a("## Register")
    a("")
    a("| # | Title | Verdict | Size | Wave | Lane | Note |")
    a("|---|---|---|---|---|---|---|")
    for num, title, verdict, size, wave, lane, note in rows:
        a(f"| #{num} | {title} | `{verdict}` | {size} | {wave} | {lane} | {note} |")
    a("")

    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))

    print(f"wrote {OUT}: {len(rows)} rows")
    for verdict, n in counts.most_common():
        print(f"  {verdict:24s} {n}")


if __name__ == "__main__":
    main()

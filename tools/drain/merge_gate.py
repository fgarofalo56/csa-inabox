"""GO / NO-GO for one pull request. PRP §6's gates, composed, plus 3b.

    python tools/drain/merge_gate.py 4483
    python tools/drain/merge_gate.py 4483 --json
    python tools/drain/merge_gate.py --audit-close 4483 --before 297

WHY THIS FILE EXISTS. `gates.py` was promoted out of gitignored `temp/` so the
program deciding every merge could be read. Promoting it was necessary and not
sufficient: for its first review the module had NO production caller -- every
decision function was referenced only by its own tests, four of the gates
the spec named were implemented nowhere, and five `policy.json` keys were read
by nothing. The briefs restated the gates as INSTRUCTIONS TO AN AGENT, so at run
time GO/NO-GO was still a judgement. An unconsulted policy key is prose, not a
control.

This is the caller. It reads live GitHub, runs every gate, and prints a verdict
with the evidence under it. It NEVER merges: a human or a lane does that, on
this output.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ledger import Ledger

import gates

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
POLICY_PATH = os.path.join(HERE, "policy.json")


def sh(args: list[str]) -> tuple[int, str, str]:
    """Run in the repo root, never discarding stderr (deploy-integrity R7)."""
    run = subprocess.run(
        args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=REPO_ROOT
    )
    return run.returncode, run.stdout, run.stderr


def gh_json(args: list[str], what: str) -> object:
    rc, out, err = sh(args)
    if rc != 0:
        raise SystemExit(f"cannot read {what} (rc={rc}): {err[:400]}")
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"unparseable {what}: {exc}") from exc


def gh_paginated(args: list[str], what: str) -> list:
    """Read a paginated API list into ONE flat list.

    `gh api --paginate --jq` emits one JSON document PER PAGE, concatenated, so
    `json.loads` dies with "Extra data" the moment the result crosses a page.
    The default page size is 30 comments: this gate worked on every PR that had
    not been reviewed twice, and took itself down on exactly the PRs that had.

    `--slurp` collects the pages into a single array -- but `gh` REFUSES
    `--slurp` together with `--jq` ("the `--slurp` option is not supported with
    `--jq` or `--template`", measured). So the field selection moves to Python
    and this passes no `--jq` at all.
    """
    raw = gh_json([*args, "--paginate", "--slurp"], what)
    if not isinstance(raw, list):
        raise SystemExit(f"unexpected shape for {what}: {type(raw).__name__}")
    flat: list = []
    for page in raw:
        if isinstance(page, list):
            flat.extend(page)
        else:
            flat.append(page)
    return flat


def ledger_receipt_ready(number: int, policy: dict, state_path: str | None = None
                         ) -> tuple[bool, str]:
    """Does the ledger hold a receipt of the right KIND for this issue?

    The gate on `--allow-close`. Fails CLOSED on a missing ledger: if you cannot
    show the receipt, you cannot declare the auto-close, because the whole point
    of gate 6 is that an auto-close skips `ledger.transition()`'s refusal.

    `state_path` is injectable so this is testable without a live ledger -- all
    three of its branches shipped uncovered, and three reviewer mutations
    (passing on a missing ledger, skipping the KIND check, unwiring the caller)
    survived the whole suite.
    """
    path = state_path or os.path.join(HERE, "state.json")
    if not os.path.exists(path):
        return False, (
            f"no ledger at {path}, so the receipt for #{number} cannot be shown. "
            "Seed it with `python tools/drain/tick.py --bootstrap`."
        )
    led = Ledger(path, receipts=policy["receipts"]).load()
    item = led.items.get(number)
    if item is None:
        return False, f"#{number} is not in the ledger at all"
    return led.receipt_ok(item)


def required_contexts(repo: str) -> list[str]:
    """The contexts branch protection will actually BLOCK on.

    Measured: only 15 of ~35 published contexts are required. Treating all of
    them as blocking stalls on checks that cannot block; treating none as
    blocking merges over a red required one.
    """
    rc, out, err = sh(
        ["gh", "api", f"repos/{repo}/branches/main/protection",
         "--jq", ".required_status_checks.contexts[]"]
    )
    if rc != 0:
        raise SystemExit(
            f"cannot read branch protection for {repo} (rc={rc}): {err[:300]}\n"
            "Without the required-context list this gate cannot say what must be green, "
            "and an unmeasurable gate is NO-GO, not a pass."
        )
    return [line.strip() for line in out.splitlines() if line.strip()]


def collect(repo: str, number: int) -> dict:
    """Everything the gates need, read once."""
    pr = gh_json(
        ["gh", "pr", "view", str(number), "--repo", repo, "--json",
         ("number,title,baseRefName,headRefOid,mergeable,mergeStateStatus,state,body,"
          "commits,statusCheckRollup,closingIssuesReferences")],
        f"PR #{number}",
    )
    assert isinstance(pr, dict)

    head = pr["headRefOid"]
    rc, out, err = sh(
        ["gh", "api", f"repos/{repo}/commits/{head}", "--jq", ".commit.committer.date"]
    )
    head_date = out.strip() if rc == 0 else ""
    if not head_date:
        print(f"WARNING: could not resolve head commit date: {err[:200]}", file=sys.stderr)

    comments = [
        {"id": c.get("id", 0), "body": c.get("body") or "",
         "created_at": c.get("created_at", "")}
        for c in gh_paginated(
            ["gh", "api", f"repos/{repo}/issues/{number}/comments"],
            f"comments on #{number}",
        )
    ]

    # The base sha comes from the API, not from a local ref. `git rev-parse
    # origin/main` and `git merge-base origin/main <head>` read the SAME local
    # remote-tracking ref, so on a stale clone they agree with each other and
    # the gate answers "is this based on the last main I fetched" while
    # printing "base == origin/main". Branch protection here is strict=false,
    # so GitHub does not catch it either -- this gate is the only defence.
    base_ref = pr["baseRefName"]
    # `--jq .sha` prints a BARE string, not JSON, so it must not go through
    # `gh_json` -- which would report the remote tip as unparseable and take the
    # whole gate down on a value it read perfectly well.
    rc, out, err = sh(["gh", "api", f"repos/{repo}/commits/{base_ref}", "--jq", ".sha"])
    if rc != 0 or not out.strip():
        raise SystemExit(f"cannot read the remote tip of {base_ref} (rc={rc}): {err[:300]}")
    origin_main_sha = out.strip()
    rc, out, err = sh(["git", "fetch", "--quiet", "origin", base_ref])
    if rc != 0:
        print(f"WARNING: git fetch origin {base_ref} failed: {err[:200]}", file=sys.stderr)
    rc, out, err = sh(["git", "merge-base", origin_main_sha, head])
    base_sha = out.strip() if rc == 0 else ""
    if rc != 0:
        print(f"WARNING: merge-base failed: {err[:200]}", file=sys.stderr)

    open_issues = gh_json(
        ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000",
         "--json", "number", "--jq", "[.[].number]"],
        "open issue numbers",
    )

    # The REAL changed files. At brief time the harness only has a lane to guess
    # from; here the diff exists, so the reviewer-count decision is made on fact
    # rather than on a lane-to-path map that cannot know where a fix will land.
    rc, out, err = sh(["gh", "pr", "diff", str(number), "--repo", repo, "--name-only"])
    if rc != 0:
        raise SystemExit(f"cannot read the changed files of #{number} (rc={rc}): {err[:300]}")
    changed_files = [line.strip() for line in out.splitlines() if line.strip()]

    head_runs = gh_json(
        ["gh", "api", f"repos/{repo}/commits/{head}/check-runs",
         "--jq", ("{n: .total_count, waiting: ([.check_runs[] | "
                  'select(.status == "waiting" or .conclusion == "action_required")] '
                  "| length)}")],
        f"check-runs on {head[:12]}",
    )

    return {
        "pr": pr,
        "head": head,
        "head_date": head_date,
        "comments": comments,
        "base_sha": base_sha,
        "origin_main_sha": origin_main_sha,
        "open_issues": open_issues,
        "head_runs": head_runs,
        "changed_files": changed_files,
        "required": required_contexts(repo),
    }


def run_gates(data: dict, policy: dict, allow_close: list[int] | None = None) -> dict:
    """Run every gate over an already-collected `data` dict.

    PURE over its inputs, and it computes the verdict itself. `main()` used to
    reduce the findings -- so `blocking = []` there was a one-token edit that
    turned the program deciding every merge into a rubber stamp, invisible to
    106 tests and a 26-arm mutation matrix that never touched this file. The
    reduction lives here, where `test_merge_gate.py` drives it over fixtures.
    """
    pr = data["pr"]
    allow_close = allow_close or []
    findings: list[dict] = []

    def record(name: str, ok: bool, detail: str) -> None:
        findings.append({"gate": name, "ok": ok, "detail": detail})

    # 0 -- the PR must be known-MERGEABLE. An ALLOW-list, not a deny-list: a
    # deny-list on "CONFLICTING" passes GitHub's async `UNKNOWN`, which is the
    # state a PR sits in for a few seconds after every push -- and UNKNOWN is
    # precisely what precedes the hazard this gate names. Pushing into a
    # conflicting window gets ZERO check-runs, permanently, and nothing later
    # creates them. "I do not know yet" is not a pass; re-run in a moment.
    mergeable = pr.get("mergeable") or "UNKNOWN"
    record(
        "0 mergeable",
        mergeable == "MERGEABLE",
        f"mergeable={mergeable} mergeStateStatus={pr.get('mergeStateStatus')}"
        + (" - clear the conflict BEFORE pushing; a commit pushed while the PR reads "
           "CONFLICTING never gets check-runs" if mergeable == "CONFLICTING"
           else " - GitHub has not computed mergeability yet; re-run rather than assume"
           if mergeable != "MERGEABLE" else ""),
    )

    # 1 -- base == origin/main, exactly.
    ok, why = gates.base_is_current(
        pr["baseRefName"], data["base_sha"], data["origin_main_sha"]
    )
    record("1 base == origin/main", ok, why)

    # 2+3 -- verdicts, reduced by conjunction, pinned to the head they measured.
    live, near = gates.parse_verdicts(
        data["comments"], data["head_date"], policy["verdict_parsing"]["token_window_chars"]
    )
    ok, why = gates.reduce_verdicts(live, near)
    detail = why + (
        f" | live={[(v.token, v.comment_id) for v in live]}"
        f" near={[(n.comment_id, n.kind, n.blocks) for n in near]}"
    )
    record("2+3 verdicts (conjunction, pinned to head)", ok, detail)

    # 3b -- HOW MANY independent reviewers, enforced here rather than described
    # in a brief. `review_requirement` is computed from the PR's REAL changed
    # files, not from a lane guess, because here the diff exists. Stated in a
    # brief and enforced nowhere, the count was the shape this module was
    # written to end: "the briefs restated the gates as instructions to an
    # agent, so at run time GO/NO-GO was still a judgement".
    approvals = [v for v in live if v.token == "APPROVE"]
    # `footprint_known` is derived, not asserted. A failing `gh pr diff` raises
    # in `collect`, but an EMPTY list would otherwise be indistinguishable from
    # "an ordinary diff touching nothing that escalates" -- same boundary, other
    # side, which is the shape this repo names most often.
    changed = data.get("changed_files") or []
    needed, why_needed = gates.review_requirement(
        policy, changed_paths=changed, footprint_known=bool(changed)
    )
    # NAMED "approval count", not "independent reviewers". The gate counts
    # APPROVE comments; it cannot tell two reviewers from one reviewer posting
    # twice -- `collect` projects comments to {id, body, created_at} and drops
    # `user.login` before `parse_verdicts` sees it, and on this repo every agent
    # verdict posts under the operator's login anyway, which is the recorded
    # reason the parser keys on position rather than identity. Independence is
    # enforced by TOOL ACCESS (the reviewer agent is read-only), not measured
    # here. A gate named for a property it does not establish is an R7 error in
    # the gate's own label.
    record(
        "3b approval count",
        len(approvals) >= needed,
        f"{len(approvals)} live APPROVE of {needed} required - {why_needed}"
         " (COUNT only: independence is enforced by tool access, not measured here)"
        + ("" if len(approvals) >= needed else
           ". A second reviewer must be independently briefed and their verdict POSTED "
           "to the PR - a verdict returned to the coordinator is not a verdict."),
    )

    # 4 -- required contexts present, none RED, none INCOMPLETE.
    rollup = pr.get("statusCheckRollup") or []
    ok, reasons = gates.classify_checks(rollup, data["required"])
    record(
        "4 required contexts green",
        ok,
        "; ".join(reasons) if reasons else f"all {len(data['required'])} required contexts green",
    )

    # 4b -- the two states that BOTH present as a missing required check. The
    # discriminator is the count of check-runs ON THE COMMIT and whether any run
    # is genuinely waiting for approval -- not the rollup length and not
    # `mergeStateStatus == BLOCKED`, which is true for essentially every PR with
    # an unsatisfied required check and so answered "parked" every time. The two
    # remedies are opposite, which is the whole reason this gate exists.
    missing = [r.split(":")[0] for r in reasons if "MISSING" in r]
    if missing:
        runs = data.get("head_runs") or {}
        shape = gates.classify_missing(int(runs.get("n", 0)), bool(runs.get("waiting")))
        record(
            "4b missing-check shape",
            False,
            f"{len(missing)} required context(s) absent; the commit carries "
            f"{runs.get('n', '?')} check-run(s), {runs.get('waiting', '?')} waiting -> "
            f"{shape}. never-created means the push landed in a CONFLICTING window and no "
            "re-run creates them; parked means approve the run. Opposite remedies.",
        )

    # 5 -- did a required context measure anything? See the docstring on
    # `required_measured_nothing`: statusCheckRollup publishes NO population, so
    # this detects a required context that concluded SKIPPED and says so, rather
    # than claiming a measurement it cannot make.
    ok, hollow = gates.required_measured_nothing(rollup, data["required"])
    record(
        "5 required contexts that measured nothing",
        ok,
        "; ".join(hollow) if hollow
        else ("no required context concluded SKIPPED (note: the rollup API exposes no "
              "per-check population, so a green-over-zero-items check is NOT visible here)"),
    )

    # 6 -- closing keywords in BOTH the body and the commit trail. This BLOCKS.
    # It used to record `True` unconditionally with a comment calling itself
    # informational, which made it a gate that could not fail sitting inside the
    # composed caller. An auto-close bypasses the ledger entirely -- the item
    # never gets a receipt of its class -- so an unintended one is a NO-GO, and
    # an intended one is declared with --allow-close.
    messages = [
        f"{c.get('messageHeadline', '')}\n{c.get('messageBody', '')}"
        for c in (pr.get("commits") or [])
    ]
    scan = gates.merge_is_close_safe(pr.get("body") or "", messages)
    # `closingIssuesReferences` is reported BESIDE the scan and never subtracted
    # from it. Trusting the API field to narrow the population re-introduces the
    # exact defect this gate exists for: it read EMPTY while a squash commit
    # closed an issue. The UNION is the answer, never the intersection.
    api_says = [i["number"] for i in (pr.get("closingIssuesReferences") or [])]
    will_close = sorted(set(scan.hard) | set(api_says))
    undeclared = sorted(set(will_close) - set(allow_close))
    record(
        "6 closing-keyword scan (body + commit trail)",
        not undeclared,
        (f"UNDECLARED auto-close of {undeclared} - an auto-close bypasses the ledger, so the "
         f"item never gets the receipt its class requires. Remove the keyword, or declare it "
         f"with --allow-close {','.join(str(n) for n in undeclared)}. "
         if undeclared else "nothing in this merge closes an issue. ")
        + f"will close {will_close} | near-miss {sorted(set(scan.near))} | "
        f"closingIssuesReferences says {api_says} "
        "(that field is NOT a complete oracle - it read empty while a squash commit "
        "closed an issue)",
    )

    blocking = [f for f in findings if not f["ok"]]
    return {
        "findings": findings,
        "blocking": blocking,
        "verdict": "NO-GO" if blocking else "GO",
        "will_close": will_close,
        "open_issues_before": data["open_issues"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="GO/NO-GO for one PR")
    parser.add_argument("pr", type=int, nargs="?", help="PR number")
    parser.add_argument("--json", action="store_true", help="machine-readable")
    parser.add_argument("--audit-close", type=int, metavar="PR",
                        help="gate 7: post-merge open-issue audit for this PR")
    parser.add_argument("--before-file",
                        help="the temp/before-<PR>.json this tool wrote before the merge")
    parser.add_argument("--intended", default="",
                        help="comma-separated issue numbers the merge was meant to close")
    parser.add_argument("--allow-close", default="",
                        help="issue numbers this merge is ALLOWED to auto-close; anything "
                             "else the keyword scan finds is a NO-GO")
    args = parser.parse_args()

    policy = gates.load_policy(POLICY_PATH)
    repo = policy["repo"]

    # Gate 7 -- the before/after audit. Run AFTER merging, with the issue-number
    # list this tool wrote before it. The scan is PREVENTION and this is
    # DETECTION, and detection has caught what the strongest API oracle did not.
    # It compares SETS: a count delta of 1 reads clean when the intended issue
    # closed, a second closed silently, and release-please opened a third.
    if args.audit_close is not None:
        if not args.before_file or not os.path.exists(args.before_file):
            print("--audit-close needs --before-file <the before-*.json this tool wrote>",
                  file=sys.stderr)
            return 2
        with open(args.before_file, encoding="utf-8") as handle:
            before = json.load(handle)
        # The baseline must belong to THIS pr. Auditing #4483 against #4400's
        # before-set prints AUDIT OK or AUDIT FAILED with equal confidence, and
        # neither answer is about anything.
        if before.get("pr") != args.audit_close:
            print(
                f"refusing: {args.before_file} was taken for PR #{before.get('pr')}, "
                f"not #{args.audit_close}. An audit against another PR's baseline "
                "is not a measurement.",
                file=sys.stderr,
            )
            return 2
        after = gh_json(
            ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000",
             "--json", "number", "--jq", "[.[].number]"],
            "open issue numbers",
        )
        intended = [int(x) for x in args.intended.split(",") if x.strip()]
        ok, why = gates.issue_set_audit(before["open_issues"], after, intended)
        print(("AUDIT OK: " if ok else "AUDIT FAILED: ") + why)
        return 0 if ok else 1

    if args.pr is None:
        parser.error("a PR number is required unless --audit-close is given")

    allow_close = [int(x) for x in args.allow_close.split(",") if x.strip()]
    # Declaring an auto-close does not GIVE the item a receipt. Gate 6 exists
    # because an auto-close bypasses the ledger, so `--allow-close` has to be
    # checked against the ledger rather than taken on a lane's word -- otherwise
    # the flag is simply a way to turn the gate off.
    for number in allow_close:
        ok, why = ledger_receipt_ready(number, policy)
        if not ok:
            print(f"refusing --allow-close {number}: {why}", file=sys.stderr)
            return 2

    data = collect(repo, args.pr)
    result = run_gates(data, policy, allow_close)

    before_path = os.path.join(REPO_ROOT, "temp", f"before-{args.pr}.json")
    os.makedirs(os.path.dirname(before_path), exist_ok=True)
    with open(before_path, "w", encoding="utf-8") as handle:
        json.dump({"pr": args.pr, "head": data["head"],
                   "open_issues": data["open_issues"]}, handle)

    if args.json:
        print(json.dumps(result, indent=1))
        return 0 if result["verdict"] == "GO" else 1

    pr = data["pr"]
    print(f"# merge gate - {repo}#{args.pr} @ {data['head'][:12]}")
    print(f"  {pr['title'][:100]}")
    print()
    for finding in result["findings"]:
        print(f"  [{'GO  ' if finding['ok'] else 'STOP'}] {finding['gate']}")
        print(f"         {finding['detail']}")
    print()
    print(f"VERDICT: {result['verdict']}")
    print(f"open issues BEFORE merge: {len(result['open_issues_before'])} "
          f"(numbers saved to {before_path})")
    print("after merging, run:")
    intended = ",".join(str(n) for n in result["will_close"])
    print(f"  python tools/drain/merge_gate.py --audit-close {args.pr} "
          f"--before-file {before_path} --intended {intended}")
    return 0 if result["verdict"] == "GO" else 1


if __name__ == "__main__":
    raise SystemExit(main())

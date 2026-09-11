"""GO / NO-GO for one pull request. The seven gates of PRP §6, composed.

    python tools/drain/merge_gate.py 4483
    python tools/drain/merge_gate.py 4483 --json
    python tools/drain/merge_gate.py --audit-close 4483 --before 297

WHY THIS FILE EXISTS. `gates.py` was promoted out of gitignored `temp/` so the
program deciding every merge could be read. Promoting it was necessary and not
sufficient: for its first review the module had NO production caller -- every
decision function was referenced only by its own tests, four of the seven gates
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

    comments = gh_json(
        ["gh", "api", f"repos/{repo}/issues/{number}/comments", "--paginate",
         "--jq", "[.[] | {id, body, created_at}]"],
        f"comments on #{number}",
    )

    base_sha = ""
    rc, out, _ = sh(["git", "rev-parse", f"origin/{pr['baseRefName']}"])
    if rc == 0:
        origin_main_sha = out.strip()
    else:
        origin_main_sha = ""
    rc, out, _ = sh(["git", "merge-base", f"origin/{pr['baseRefName']}", head])
    if rc == 0:
        base_sha = out.strip()

    open_issues = gh_json(
        ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000",
         "--json", "number", "--jq", "length"],
        "open issue count",
    )

    return {
        "pr": pr,
        "head": head,
        "head_date": head_date,
        "comments": comments,
        "base_sha": base_sha,
        "origin_main_sha": origin_main_sha,
        "open_issues": open_issues,
        "required": required_contexts(repo),
    }


def run_gates(data: dict, policy: dict) -> dict:
    pr = data["pr"]
    findings: list[dict] = []

    def record(name: str, ok: bool, detail: str) -> None:
        findings.append({"gate": name, "ok": ok, "detail": detail})

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

    # 4 -- required contexts present, none RED, none INCOMPLETE.
    rollup = pr.get("statusCheckRollup") or []
    ok, reasons = gates.classify_checks(rollup, data["required"])
    record(
        "4 required contexts green",
        ok,
        "; ".join(reasons) if reasons else f"all {len(data['required'])} required contexts green",
    )

    # 4b -- the two states that BOTH present as a missing required check.
    missing = [r.split(":")[0] for r in reasons if "MISSING" in r]
    if missing:
        shape = gates.classify_missing(len(rollup), pr["mergeStateStatus"] == "BLOCKED")
        record(
            "4b missing-check shape",
            False,
            f"{len(missing)} required context(s) absent; rollup carries {len(rollup)} runs -> "
            f"{shape}. never-created means the push landed in a CONFLICTING window and no "
            "re-run creates them; parked means approve the run. Opposite remedies.",
        )

    # 5 -- hollow check: did each green context MEASURE anything?
    hollow: list[str] = []
    for check in rollup:
        name = check.get("name") or check.get("context") or ""
        if name not in data["required"]:
            continue
        conclusion = (check.get("conclusion") or check.get("state") or "")
        is_hollow, note = gates.check_is_hollow(name, conclusion, check.get("measured"))
        if is_hollow and conclusion.upper() == "SKIPPED":
            hollow.append(note)
    record(
        "5 hollow-check",
        not hollow,
        "; ".join(hollow) if hollow else "no required context concluded SKIPPED",
    )

    # 6 -- closing keywords in BOTH the body and the commit trail.
    messages = [
        f"{c.get('messageHeadline', '')}\n{c.get('messageBody', '')}"
        for c in (pr.get("commits") or [])
    ]
    scan = gates.merge_is_close_safe(pr.get("body") or "", messages)
    api_says = [i["number"] for i in (pr.get("closingIssuesReferences") or [])]
    record(
        "6 closing-keyword scan (body + commit trail)",
        True,  # informational: what WILL close is not a block, being wrong about it is
        f"will close {sorted(set(scan.hard))} | near-miss {sorted(set(scan.near))} | "
        f"closingIssuesReferences says {api_says} "
        "(that field is NOT a complete oracle - it read empty while a squash commit closed an issue)",
    )

    return {
        "findings": findings,
        "will_close": sorted(set(scan.hard)),
        "open_issues_before": data["open_issues"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="GO/NO-GO for one PR")
    parser.add_argument("pr", type=int, nargs="?", help="PR number")
    parser.add_argument("--json", action="store_true", help="machine-readable")
    parser.add_argument("--audit-close", type=int, metavar="PR",
                        help="gate 7: post-merge open-issue audit for this PR")
    parser.add_argument("--before", type=int, help="open-issue count taken BEFORE the merge")
    parser.add_argument("--intended", default="",
                        help="comma-separated issue numbers the merge was meant to close")
    args = parser.parse_args()

    policy = gates.load_policy(POLICY_PATH)
    repo = policy["repo"]

    # Gate 7 -- the before/after audit. Run AFTER merging, with the count this
    # tool printed before it. The count is DETECTION and the scan is PREVENTION,
    # and the count has caught what the strongest API oracle did not.
    if args.audit_close is not None:
        if args.before is None:
            print("--audit-close needs --before <count taken before the merge>", file=sys.stderr)
            return 2
        after = gh_json(
            ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "1000",
             "--json", "number", "--jq", "length"],
            "open issue count",
        )
        intended = [int(x) for x in args.intended.split(",") if x.strip()]
        ok, why = gates.issue_count_audit(args.before, int(after), intended)
        print(("AUDIT OK: " if ok else "AUDIT FAILED: ") + why)
        return 0 if ok else 1

    if args.pr is None:
        parser.error("a PR number is required unless --audit-close is given")

    data = collect(repo, args.pr)
    result = run_gates(data, policy)
    blocking = [f for f in result["findings"] if not f["ok"]]
    result["verdict"] = "NO-GO" if blocking else "GO"

    if args.json:
        print(json.dumps(result, indent=1))
        return 0 if not blocking else 1

    pr = data["pr"]
    print(f"# merge gate - {repo}#{args.pr} @ {data['head'][:12]}")
    print(f"  {pr['title'][:100]}")
    print(f"  mergeable={pr['mergeable']} mergeStateStatus={pr['mergeStateStatus']}")
    print()
    for finding in result["findings"]:
        print(f"  [{'GO  ' if finding['ok'] else 'STOP'}] {finding['gate']}")
        print(f"         {finding['detail']}")
    print()
    print(f"VERDICT: {result['verdict']}")
    print(f"open issues BEFORE merge: {result['open_issues_before']}  "
          f"(intended to close: {result['will_close'] or 'none'})")
    print("after merging, run:")
    intended = ",".join(str(n) for n in result["will_close"])
    print(f"  python tools/drain/merge_gate.py --audit-close {args.pr} "
          f"--before {result['open_issues_before']} --intended {intended}")
    return 0 if not blocking else 1


if __name__ == "__main__":
    raise SystemExit(main())

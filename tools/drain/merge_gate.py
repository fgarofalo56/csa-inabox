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

from ledger import AWAITING_RECEIPT, IN_FLIGHT, IN_REVIEW, Ledger

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
    led, why = load_ledger(policy, state_path)
    if led is None:
        return False, (
            f"{why}, so the receipt for #{number} cannot be shown. "
            "Seed it with `python tools/drain/tick.py --bootstrap`."
        )
    item = led.items.get(number)
    if item is None:
        return False, f"#{number} is not in the ledger at all"
    return led.receipt_ok(item)


def ledger_candidates(state_path: str | None = None,
                      policy_repo: str | None = None) -> list[str]:
    """Where `state.json` might be, in order, from wherever we were invoked.

    `state.json` is gitignored, so it exists in the PRIMARY checkout and in no
    worktree. Measured 2026-09-12: **371** worktrees on this machine, **1**
    carrying a ledger. A lane runs `merge_gate.py` from its own worktree --
    that is what the brief instructs and what file-partitioned parallelism
    requires -- so resolving only against `HERE` meant the stream never resolved
    and, since that fails closed, EVERY PR asked for two reviewers. The control
    that exists because "a control that fires on everything teaches the reader
    to skim it" would have fired on everything.

    So a worktree falls back to the primary checkout via git's COMMON DIR:
    `.git` in a worktree is a file pointing at `<primary>/.git/worktrees/<name>`,
    and `--git-common-dir` resolves to `<primary>/.git`. Its parent is the
    primary working tree.

    PURELY A READ; NOTHING IS WRITTEN OUTSIDE `HERE` -- and that sentence was
    FALSE for one round. `bind_pr` loaded through this resolver and saved, so
    from a worktree it rewrote the PRIMARY checkout's ledger, unlocked, while
    up to four lanes were doing the same. Both reviewers reproduced the lost
    update independently. The write is deleted, so the sentence is true again;
    it is spelled out here because a resolver that hands out paths in other
    people's checkouts has to be read-only by construction, not by habit.
    """
    if state_path:
        return [state_path]
    found = [os.path.join(HERE, "state.json")]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, cwd=REPO_ROOT, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"WARNING: cannot ask git for the primary checkout ({exc}) - "
              "no worktree fallback, so an unresolvable stream will escalate",
              file=sys.stderr)
        return found
    if common.returncode != 0 or not common.stdout.strip():
        # NEVER SILENT. `--path-format` needs git >= 2.31, so on an older host
        # the fallback simply vanishes and every PR escalates with nothing
        # saying why -- MG21's symptom, undiagnosable. `sh()` three functions up
        # states this file's standard: never discard stderr (R7).
        print(f"WARNING: git could not resolve the common dir (rc="
              f"{common.returncode}): {(common.stderr or '').strip()[:200]} - "
              "no worktree fallback", file=sys.stderr)
        return found
    primary = os.path.dirname(common.stdout.strip().rstrip("/"))
    candidate = os.path.join(primary, "tools", "drain", "state.json")
    # IDENTITY, NOT PRESENCE. The first version of this required only that
    # `policy.json` EXIST there -- which a vendored copy carries by definition,
    # so it did not discriminate the case its own comment named. A reviewer
    # pointed `GIT_COMMON_DIR` at a repo whose `policy.json` said
    # `someone-else/other-repo` and resolved THIS repo's #1483 out of the
    # foreign ledger: the wrong-population defect `guard_refresh` spends a
    # hundred lines on, through the back door. The `repo` key must MATCH.
    if os.path.abspath(candidate) != os.path.abspath(found[0]) and _same_repo(
        os.path.join(primary, "tools", "drain", "policy.json"), policy_repo
    ):
        found.append(candidate)
    return found


def _same_repo(candidate_policy_path: str, repo: str | None) -> bool:
    """Does that checkout's policy name the same repo as ours? Never raises."""
    if not repo:
        return False
    try:
        with open(candidate_policy_path, encoding="utf-8") as handle:
            return json.load(handle).get("repo") == repo
    except Exception:
        return False


def load_ledger(policy: dict, state_path: str | None = None
                ) -> tuple[Ledger | None, str]:
    """Load the ledger, or say why not. NEVER raises.

    `run_gates` reads this on every call, which is new I/O on the merge path
    over an untracked, per-machine scratch file. A reviewer measured both ways
    it used to end the program: a corrupt `state.json` raised `JSONDecodeError`
    and a schema mismatch raised `SystemExit`, neither caught, so the program
    that decides every merge exited on a raw traceback -- deploy-integrity R6,
    "a failure whose only output is a stack trace".

    Every caller here already has a fail-closed shape to route a `None` into.
    """
    tried = ledger_candidates(state_path, policy.get("repo"))
    for path in tried:
        if not os.path.exists(path):
            continue
        try:
            return Ledger(path, receipts=policy["receipts"]).load(), path
        except SystemExit as exc:          # schema mismatch: deliberate refusal
            return None, f"ledger at {path} refused to load: {exc}"
        except Exception as exc:
            # ENUMERATING THE TYPES WAS THE NARROWER-ENUMERATION SHAPE AGAIN.
            # `OSError, ValueError` covered `JSONDecodeError` and missed four
            # ordinary hand-edit shapes a reviewer measured: a top-level array
            # or string (`AttributeError` from `raw.get`), an item missing
            # `number` (`TypeError` from `Item(**...)`), and `items` as a dict
            # (`AttributeError`). `state.json` is hand-edited today -- the
            # README says so in this same round -- so a dropped key is the
            # ordinary case, and it ended the program that decides every merge
            # on a traceback (R6). A function whose contract is "never raises"
            # cannot have an exception allow-list.
            return None, f"ledger at {path} is unreadable: {type(exc).__name__}: {exc}"
    return None, f"no ledger at any of {tried}"


#: States `select_cycle` puts an item into and that nothing has closed out.
#: Membership here is HARNESS-generated evidence that an item is live work --
#: the only kind of corroboration a merge gate can trust, since everything else
#: on a PR is typed by its author.
SCHEDULED_STATES = (IN_FLIGHT, IN_REVIEW, AWAITING_RECEIPT)


def poached_closes(closing: list[int], policy: dict, state_path: str | None = None,
                   pr: int | None = None) -> list[str]:
    """Declared closes the ledger has bound to a DIFFERENT PR.

    Read-only, and SILENT when it cannot tell: no ledger, or no binding, is not
    evidence of a conflict. It reports only the case where the harness's own
    record disagrees with the declaration -- which is the one thing on a PR that
    was not typed by its author.

    **INERT TODAY, AND SAID SO RATHER THAN IMPLIED.** `Item.pr` has no writer:
    0 of 299 live items carry one, so this returns `[]` for every real input.
    It is kept, not deleted, because the check is right and the missing half is
    a writer in `tick.py` -- which owns the ledger and is its single writer by
    design. The previous round wrote the binding from HERE instead, and both
    reviewers reproduced a lost update on the drain's only durable record. A
    merge gate does not get to mutate the thing it measures. Tracked in #4489;
    until then this is a declared-inert control, not a working one.
    """
    if not closing or pr is None:
        return []
    led, _why = load_ledger(policy, state_path)
    if led is None:
        return []
    return [
        f"#{n} is bound to PR {led.items[n].pr}"
        for n in closing
        if n in led.items and led.items[n].pr not in (None, pr)
    ]


# `bind_pr` WAS HERE, AND IS DELETED. Both reviewers blocked on it
# independently, and they were right.
#
# It wrote `Item.pr` from `main()` so `poached_closes` would have something to
# read. That made this module a WRITER of the ledger -- and via the worktree
# fallback, a writer of a ledger in a checkout this process does not own, which
# the resolver's own docstring said could not happen. Worse, it was an unlocked
# read-modify-write on the drain's only durable record, in a harness whose
# premise is up to four parallel lanes. Both reviewers reproduced the lost
# update: `Ledger.save()` serialises the whole document from memory, so the
# loser's cycle, state transitions and history do not merge -- they vanish.
#
# It was latent (no item holds a receipt, so `--allow-close` never reached it)
# and it armed on the first receipt, which the docs say to expect.
#
# Locking a merge gate was the wrong answer to the wrong question. `tick.py`
# owns the ledger and is the single writer by design; the binding belongs there,
# written when a lane opens a PR for an item, not inferred by the gate from what
# the PR says about itself. `poached_closes` stays as a READ and is DECLARED
# INERT until that writer exists -- see its docstring. Tracked in #4489.


def ledger_stream(closing: list[int], mentioned: list[int], policy: dict,
                  state_path: str | None = None,
                  pr: int | None = None) -> tuple[str | None, str]:
    """Which STREAM this PR's work belongs to, for the escalation decision.

    Returns `(stream, why)`, and `stream is None` means UNKNOWN -- which the
    caller treats as a reason to escalate, never as "no stream applies". A
    missing ledger, an unreferenced PR and an issue the ledger has never seen
    are all unknown: in each case the harness cannot place the work, and every
    sibling control in this package fails closed.

    A MENTION MAY ONLY ESCALATE. A CLOSING REFERENCE MAY ALSO EXPLAIN.

    Both reviewers converged on the inversion this split repairs, and it was in
    the feature this very round added. Measured at ba62873:

        body "Related to #10 in passing."  (#10 is W9-rest)  -> 1 reviewer
        the SAME diff with NO reference at all               -> 2 reviewers

    Referencing an issue bought a WEAKER gate than referencing nothing, which
    inverts the fail-closed design the round claimed to deliver. The trigger is
    not malice: an agent-written PR body copy-pasting a stale issue number is
    the ordinary case, and `KICKOFF.md` reuses `#4468` as an example number
    throughout its own text.

    `Refs #N` is an ASIDE. An aside is good enough to RAISE the requirement --
    it can only cost a second reviewer -- and not good enough to LOWER it.

    A DECLARED CLOSE IS NOT CORROBORATION EITHER, and round 6 said it was.

    That round's fix leant on `Closes #N` + `--allow-close` being deliberate,
    and reviewer B reproduced the same inversion straight through it: a PR
    citing an unrelated, already-receipted `W9-rest` item got ONE reviewer where
    no reference at all forced two. `--allow-close` is an author DECLARATION.
    It establishes that the author said so. It does not establish that the
    issue is what the diff is about, and asserting it did was an R7 error in
    prose -- in a round whose whole subject was an R7 error in prose.

    So the corroboration has to be evidence the HARNESS produced, not evidence
    the author typed. Two kinds exist:

    - `item.pr == pr` -- the ledger already binds that item to THIS PR.
    - the item is MID-FLIGHT (`in-flight` / `in-review` / `awaiting-receipt`) --
      `select_cycle` put it in a lane and nothing has closed it out. A `ready`
      item was never scheduled; a TERMINAL one is finished. Neither is evidence
      that a PR opened now is work on it, and reviewer B's exploit used exactly
      that shape: an item whose work was already done.

    Without one of those, a declared close is treated like a mention: it may
    escalate, it may not explain.

    `Item.pr` HAS NO WRITER, so the mid-flight test carries all of the weight
    today and the binding arm is unreachable. A previous round wrote the binding
    from `main()` and this docstring said so; that write is DELETED, because
    from a worktree it rewrote the primary checkout's ledger unlocked and both
    reviewers reproduced a lost update. Nothing accrues. The writer belongs in
    `tick.py`, which owns the ledger -- #4489. Said here because a reader
    auditing whether this corroboration is safe was previously told it rests on
    an accrual that does not exist.

    When several items resolve, the STRONGEST wins -- the same conjunction
    `reduce_verdicts` uses. That is the `hit` branch's job: a PR touching a
    W9-rest item and a W1-deploy item is a W1-deploy change, and it never
    reaches the corroborated branch below, because every escalating stream is
    taken above. The example used to sit here, attached to a branch it cannot
    occur in. What the corroborated branch actually sees is W4/W8/W9 only, and
    `sorted()[0]` there is alphabetical -- it picks the lower W-number by
    coincidence of naming, not by a declared priority, and a stream named
    `Wx-audit` would reorder it silently. Cosmetic while none of the three
    changes the count; recorded so it is not mistaken for a rule.
    """
    every = sorted(set(closing) | set(mentioned))
    if not every:
        return None, "the PR references no issue, so its stream is unknown"
    led, why = load_ledger(policy, state_path)
    if led is None:
        return None, f"{why}, so the stream cannot be resolved"
    escalating = gates.escalation_streams(policy)
    # NAME THE LEDGER. With the worktree fallback live, a lane can now be
    # deciding on a ledger from a checkout it does not control, at a freshness
    # it cannot see -- and this module's own R2 machinery names stale-ledger
    # reads as a live hazard. `why` carries the resolved path on success.
    source = f" [ledger: {why}]"

    hit = next((led.items[n].stream for n in every
                if n in led.items and led.items[n].stream in escalating), None)
    if hit:
        # NAME THE ONES THAT PRODUCED THE HIT, not the whole reference set. The
        # first version said "#[1483, 999999] sits in W5-console" when #999999
        # was not in the ledger at all -- established one thing, asserted
        # another (R7). Fixed two branches down and left here: the same
        # one-side-of-a-boundary shape this package names as its dominant
        # failure mode.
        because = [n for n in every
                   if n in led.items and led.items[n].stream == hit]
        rest = [n for n in every if n not in because]
        return hit, (
            f"#{because} sits in {hit}"
            + (f" (also referenced: {rest})" if rest else "")
            + source
        )

    # The BINDING dominates the state test. An item already bound to another PR
    # is that PR's work, and being mid-flight is evidence FOR THAT PR, not for
    # this one -- which is precisely the case gate 6 refuses two lines later.
    corroborated = [
        n for n in closing
        if n in led.items and (
            led.items[n].pr == pr if led.items[n].pr is not None
            else led.items[n].state in SCHEDULED_STATES
        )
    ]
    # WORD IT FROM THE ARM THAT MATCHED. "is work the harness has in flight" is
    # false of an item corroborated by its BINDING, which bypasses the state
    # test -- a `closed` item bound to this PR corroborates, and the docstring
    # above says a terminal item is finished. Unreachable while `Item.pr` has no
    # writer; it arms the moment #4489 lands one, which is when a latent wrong
    # sentence becomes a live one.
    bound_here = [n for n in corroborated if led.items[n].pr == pr]
    if corroborated:
        # The STRONGEST, not the lowest-numbered. `corroborated[0]` reported
        # whichever issue number sorted first, which is the answer-depends-on-
        # ordering shape MG13 exists to forbid -- cosmetic while every
        # escalating stream is already taken by `hit` above, and cosmetic is
        # still a message that can be wrong.
        streams = sorted({led.items[n].stream for n in corroborated})
        because = (
            f"the ledger binds {bound_here} to this PR" if bound_here
            else "it is work the harness has in flight"
        )
        return streams[0], (
            f"#{corroborated} is declared closed, {because}, and sits in "
            f"{'/'.join(streams)}{source}"
        )

    stale = [n for n in closing if n in led.items]
    if stale:
        # The binding clause ONLY when there is a binding. `Item.pr` has no
        # writer, so "bound to PR None" was what this said about all 299 items
        # -- a fact asserted about a system that has no bindings, the same shape
        # as the "was taken under None" message repaired in `ledger.py`.
        item = led.items[stale[0]]
        return None, (
            f"#{stale} is declared closed but the ledger has it in "
            f"{item.state!r}"
            + (f", bound to PR {item.pr}" if item.pr is not None else "")
            + " - the harness never scheduled this as work in flight, so the "
            f"declaration is the author's word alone and the stream is unknown{source}"
        )
    # NUMBERS DECLARED CLOSED BUT ABSENT FROM THE LEDGER GET THEIR OWN SENTENCE.
    # Folding them into "only MENTIONED" asserted something the code did not
    # establish -- it established that they are not in the ledger (R7). Same
    # class as the "was taken under None" message this round repairs in
    # `ledger.py`, and the remedy is different: re-seed, or the number is stale.
    unknown_closes = sorted(set(closing) - set(led.items))
    if unknown_closes:
        return None, (
            f"#{unknown_closes} is declared closed but is not in the ledger at "
            "all - either the ledger needs re-seeding (tick.py --bootstrap) or "
            f"the number is stale, so the stream is unknown{source}"
        )
    if any(n in led.items for n in every):
        return None, (
            f"#{sorted(set(mentioned) & set(led.items))} is only MENTIONED, not "
            "declared closed, and sits in no escalating stream - a mention is "
            f"not evidence of what this PR is, so the stream is unknown{source}"
        )
    return None, f"none of {every} is in the ledger, so the stream is unknown{source}"


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


def _flat_check_runs(repo: str, sha: str) -> tuple[list[dict], int]:
    """Every check-run published at `sha`, plus the API's own `total_count`.

    `total_count` is read from the API rather than derived from `len(runs)`,
    because it is what `gates.classify_missing` needs to tell "nothing was ever
    created here" from "the page I read happened to be empty".
    """
    pages = gh_json(
        ["gh", "api", f"repos/{repo}/commits/{sha}/check-runs?per_page=100",
         "--paginate", "--slurp"],
        f"check-runs at {sha[:12]}",
    )
    assert isinstance(pages, list)
    runs: list[dict] = []
    total = 0
    for page in pages:
        if not isinstance(page, dict):
            continue
        total = max(total, int(page.get("total_count") or 0))
        runs.extend(page.get("check_runs") or [])
    return runs, max(total, len(runs))


def _workflow_runs(repo: str, sha: str) -> list[dict]:
    pages = gh_json(
        ["gh", "api", f"repos/{repo}/actions/runs?head_sha={sha}&per_page=100",
         "--paginate", "--slurp"],
        f"workflow runs at {sha[:12]}",
    )
    assert isinstance(pages, list)
    runs: list[dict] = []
    for page in pages:
        if isinstance(page, dict):
            runs.extend(page.get("workflow_runs") or [])
    return runs


def collect_ci_green_evidence(repo: str, number: int) -> dict:
    """Measure everything `gates.ci_green_receipt` decides on, for a MERGED PR.

    #4487. Nothing here maps a context to a producer by SPELLING. The producer
    is traced at the PR HEAD -- the event where the context demonstrably ran --
    through `check_suite_id`, which is 1:1 with an Actions workflow run, and the
    rename case is then resolved by that same workflow identity at the merged
    sha. An alias table would be one conditional `name:` expression away from
    being wrong, silently.
    """
    pr = gh_json(
        ["gh", "pr", "view", str(number), "--repo", repo, "--json",
         "number,title,state,baseRefName,headRefOid,mergeCommit"],
        f"PR #{number}",
    )
    assert isinstance(pr, dict)
    if pr.get("state") != "MERGED" or not (pr.get("mergeCommit") or {}).get("oid"):
        raise SystemExit(
            f"#{number} is {pr.get('state')}, not MERGED - `ci-green` is a receipt about a "
            "MERGED sha, and there is no merged sha to measure."
        )
    merged = pr["mergeCommit"]["oid"]
    head = pr["headRefOid"]
    branch = pr["baseRefName"]

    for sha in (merged, head):
        rc, _, err = sh(["git", "fetch", "--quiet", "origin", sha])
        if rc != 0:
            print(f"WARNING: git fetch {sha[:12]} failed: {err[:200]}", file=sys.stderr)

    merged_checks, merged_total = _flat_check_runs(repo, merged)
    head_checks, _ = _flat_check_runs(repo, head)
    merged_by_name = gates.worst_by_name(merged_checks)
    head_by_name = gates.worst_by_name(head_checks)

    # check_suite_id -> workflow path, on BOTH shas.
    head_path_by_suite = {
        r.get("check_suite_id"): r.get("path") for r in _workflow_runs(repo, head)
    }
    merged_runs = _workflow_runs(repo, merged)
    merged_run_by_path: dict[str, dict] = {}
    for run in merged_runs:
        path = run.get("path")
        if not path:
            continue
        prior = merged_run_by_path.get(path)
        # Newest run for that workflow decides -- a re-run supersedes.
        if prior is None or str(run.get("run_started_at") or "") >= str(prior.get("run_started_at") or ""):
            merged_run_by_path[path] = run

    # The producer of each context, traced at the head.
    suite_of_head_check = {
        (c.get("name") or ""): (c.get("check_suite") or {}).get("id") for c in head_checks
    }

    rc, out, err = sh(["git", "show", "--name-only", "--pretty=format:", merged])
    if rc != 0:
        raise SystemExit(
            f"cannot read the changed files of {merged[:12]} (rc={rc}): {err[:300]}\n"
            "Without them a path filter cannot be shown to exclude anything, and an "
            "unmeasurable receipt is NOT a receipt."
        )
    changed_files = [line.strip() for line in out.splitlines() if line.strip()]

    trees = []
    for sha in (merged, head):
        rc, out, _ = sh(["git", "rev-parse", f"{sha}^{{tree}}"])
        trees.append(out.strip() if rc == 0 else "")
    trees_identical = bool(trees[0]) and trees[0] == trees[1]

    required = required_contexts(repo)
    evidence = []
    jobs_cache: dict[int, tuple[str, ...]] = {}
    trigger_cache: dict[str, gates.PushTrigger | None] = {}
    for name in required:
        merged_check = merged_by_name.get(name)
        workflow_path = head_path_by_suite.get(suite_of_head_check.get(name))
        merged_run = None
        merged_jobs: tuple[str, ...] = ()
        trigger = None
        if merged_check is None and workflow_path:
            merged_run = merged_run_by_path.get(workflow_path)
            if merged_run is not None:
                run_id = merged_run.get("id")
                if run_id not in jobs_cache:
                    jobs = gh_paginated(
                        ["gh", "api", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"],
                        f"jobs of run {run_id}",
                    )
                    names: list[str] = []
                    for page in jobs:
                        if isinstance(page, dict):
                            names.extend(j.get("name", "") for j in (page.get("jobs") or []))
                    jobs_cache[run_id] = tuple(n for n in names if n)
                merged_jobs = jobs_cache[run_id]
            else:
                if workflow_path not in trigger_cache:
                    rc, out, _ = sh(["git", "show", f"{merged}:{workflow_path}"])
                    trigger_cache[workflow_path] = (
                        gates.parse_push_trigger(out) if rc == 0 else None
                    )
                trigger = trigger_cache[workflow_path]
        evidence.append(
            gates.ContextEvidence(
                name=name,
                workflow_path=workflow_path,
                merged_check=merged_check,
                head_check=head_by_name.get(name),
                merged_workflow_run=merged_run,
                merged_workflow_jobs=merged_jobs,
                push_trigger=trigger,
            )
        )

    return {
        "pr": pr, "merged": merged, "head": head, "branch": branch,
        "evidence": evidence, "merged_total_count": merged_total,
        "changed_files": changed_files, "trees_identical": trees_identical,
    }


def print_ci_green_receipt(repo: str, number: int, as_json: bool) -> int:
    data = collect_ci_green_evidence(repo, number)
    receipt = gates.ci_green_receipt(
        data["evidence"],
        merged_total_count=data["merged_total_count"],
        merged_changed_files=data["changed_files"],
        merged_branch=data["branch"],
        trees_identical=data["trees_identical"],
    )
    if as_json:
        print(json.dumps({
            "pr": number,
            "merged_sha": data["merged"],
            "head_sha": data["head"],
            "ok": receipt.ok,
            "summary": receipt.summary,
            "trees_identical": data["trees_identical"],
            "contexts": [
                {"name": c.name, "state": c.state, "detail": c.detail}
                for c in receipt.contexts
            ],
            "reasons": list(receipt.reasons),
        }, indent=1))
        return 0 if receipt.ok else 1

    print(f"# ci-green receipt - {repo}#{number}")
    print(f"  merged sha : {data['merged']}")
    print(f"  PR head    : {data['head']}  (tree "
          f"{'IDENTICAL' if data['trees_identical'] else 'DIFFERS'})")
    print(f"  changed    : {len(data['changed_files'])} file(s) at the merged sha")
    print()
    for context in receipt.contexts:
        mark = "ok  " if context.ok else "FAIL"
        print(f"  [{mark}] {context.name}")
        print(f"         {context.state}: {context.detail}")
    print()
    print(f"RECEIPT: {receipt.summary}")
    for reason in receipt.reasons:
        print(f"  - {reason}")
    if receipt.ok:
        print()
        print("Record it against the item with receipt_kind='ci-green', "
              f"receipt_ref='{data['merged']}', and set receipt_taken_under to the item's "
              "effective_receipt_class - see README 'If you hand-edit a receipt'.")
    return 0 if receipt.ok else 1


def run_gates(data: dict, policy: dict, allow_close: list[int] | None = None,
              state_path: str | None = None) -> dict:
    """Run every gate over an already-collected `data` dict.

    No NETWORK reads -- `data` is already collected -- and it computes the
    verdict itself. `main()` used to reduce the findings, so `blocking = []`
    there was a one-token edit that turned the program deciding every merge into
    a rubber stamp, invisible to 106 tests and a 26-arm mutation matrix that
    never touched this file. The reduction lives here, where
    `test_merge_gate.py` drives it over fixtures.

    NOT PURE, and the docstring used to say it was. Gate 3b reads the LEDGER to
    resolve the item's stream, so there is one filesystem read on this path.
    `state_path` injects it; every test must pass it, or a tracked test's
    outcome depends on an untracked per-machine file. `load_ledger` never
    raises, so a corrupt or schema-mismatched ledger fails CLOSED with a
    sentence rather than ending the program on a traceback (R6).
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

    # The closing scan is computed HERE, above 3b, because 3b needs the issue
    # numbers to resolve the item's STREAM -- and it is RECORDED as gate 6 below,
    # in its own place, so the output still reads in gate order.
    messages = [
        f"{c.get('messageHeadline', '')}\n{c.get('messageBody', '')}"
        for c in (pr.get("commits") or [])
    ]
    scan = gates.merge_is_close_safe(pr.get("body") or "", messages)
    api_says = [i["number"] for i in (pr.get("closingIssuesReferences") or [])]
    will_close = sorted(set(scan.hard) | set(api_says))
    # For the STREAM lookup the population is wider than "what will close". The
    # closing scan is VERB-ANCHORED -- `hard` needs a closing verb adjacent to
    # the reference, `near` needs one within 80 chars -- so `Refs #4487` is in
    # neither, and `Refs #N` is how nearly every PR here names its item. Reusing
    # the closing scan would have read "references no issue" on most PRs and,
    # since an unresolvable stream fails closed, escalated all of them for the
    # wrong reason: a control that fires on everything teaches the reader to
    # skim it.
    #
    # Kept SEPARATE from `will_close`, not unioned into it. `ledger_stream` uses
    # the two differently: a mention may only ESCALATE, while a declared close
    # may also explain a non-escalating stream. Merging them here is what let a
    # stale copy-pasted `#N` buy a weaker gate than no reference at all.
    mentioned = gates.referenced_issues(pr.get("body") or "", messages,
                                        repo=policy.get("repo"))

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
    # TWO OF THE FOUR TRIGGERS USED TO BE INERT HERE.
    #
    # `review_requirement` implements all four, and this caller passed only the
    # path set -- so `escalate_on_blocking_first_verdict` and the STREAM list
    # were live in `gates.py`, described in the brief, and enforced by nothing.
    # An unconsulted ARGUMENT is the same defect as an unconsulted policy key,
    # which is the one this module already found twice. Measured by a reviewer:
    # a `csa_platform/security/auth.py` diff on a W2-security item, and an
    # `azure-functions/` diff on a W1-deploy item -- the stream R1 says preempts
    # everything -- both merged GO on ONE approval. And the block-push-reapprove
    # rhythm of this very PR: after a push the earlier block is correctly no
    # longer live, so nothing raised the count.
    #
    # R6/R9 kill their mutations through `test_policy.py` calling
    # `review_requirement` DIRECTLY, so the matrix proved the function honours
    # the triggers and proved nothing about the caller feeding them. Same
    # boundary, other side. MG14/MG15/MG10/MG11/MG12/MG13/MGE are pointed at
    # this call. (An earlier draft of this line said MG8/MG9 -- those are gate
    # 6's union and gate 0's allow-list, which touch nothing here. A reviewer
    # auditing the matrix follows these labels to decide whether an arm is
    # covered, so a wrong one is a claim about a control, not a typo.)
    prior_verdict = gates.worst_verdict_in_history(
        data["comments"], policy["verdict_parsing"]["token_window_chars"]
    )
    stream, why_stream = ledger_stream(will_close, mentioned, policy, state_path,
                                       pr=pr.get("number"))
    needed, why_needed = gates.review_requirement(
        policy,
        changed_paths=changed,
        prior_verdict=prior_verdict,
        stream=stream,
        footprint_known=bool(changed),
        stream_known=stream is not None,
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
        f" [worst verdict posted: {prior_verdict or 'none'} | {why_stream}]"
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
    # `scan`, `api_says` and `will_close` are computed above 3b, which needs the
    # numbers. `closingIssuesReferences` is reported BESIDE the scan and never
    # subtracted from it. Trusting the API field to narrow the population
    # re-introduces the exact defect this gate exists for: it read EMPTY while a
    # squash commit closed an issue. The UNION is the answer, never the
    # intersection.
    undeclared = sorted(set(will_close) - set(allow_close))
    # AN ITEM ALREADY BOUND TO A DIFFERENT PR IS NOT THIS PR'S TO CLOSE.
    #
    # `--allow-close N` is an author DECLARATION, not corroboration -- round 6
    # claimed otherwise and a reviewer walked straight through it. The ledger's
    # own binding is the one piece of evidence the harness produced itself, so
    # a second PR citing a number the first already claimed is refused rather
    # than silently believed. That is precisely the copy-paste-across-
    # invocations case the reviewer named: the drain runs this command hundreds
    # of times across one backlog.
    poached = poached_closes(will_close, policy, state_path, pr=pr.get("number"))
    record(
        "6 closing-keyword scan (body + commit trail)",
        not undeclared and not poached,
        (f"UNDECLARED auto-close of {undeclared} - an auto-close bypasses the ledger, so the "
         f"item never gets the receipt its class requires. Remove the keyword, or declare it "
         f"with --allow-close {','.join(str(n) for n in undeclared)}. "
         if undeclared else "nothing in this merge closes an issue. ")
        + (f"POACHED: {poached} - the ledger binds those to another PR. " if poached else "")
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
    parser.add_argument("--ci-green-receipt", type=int, metavar="PR",
                        help="#4487: take the `ci-green` receipt for a MERGED PR - every "
                             "required context that CAN run at the merged sha is green, and "
                             "every one that cannot is named with its reason and its "
                             "PR-head result over an identical tree")
    args = parser.parse_args()

    policy = gates.load_policy(POLICY_PATH)
    repo = policy["repo"]

    # #4487. The receipt is a PROGRAM, for the same reason the merge gates are:
    # a definition with no caller is prose, and the old one named a measurement
    # the CI topology cannot produce.
    if args.ci_green_receipt is not None:
        return print_ci_green_receipt(repo, args.ci_green_receipt, args.json)

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
    # ...and REFUSE one the ledger binds to another PR. A receipt of the right
    # kind says the WORK is done; it says nothing about whether THIS PR is the
    # work. INERT until something writes `Item.pr` -- which is `tick.py`'s job,
    # not this module's; writing it from here made a merge gate a writer of a
    # ledger it does not own and lost updates. #4489.
    poached = poached_closes(allow_close, policy, pr=args.pr)
    if poached:
        print(f"refusing --allow-close: {'; '.join(poached)}", file=sys.stderr)
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

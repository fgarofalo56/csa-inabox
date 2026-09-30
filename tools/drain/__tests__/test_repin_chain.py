"""#4811: a verdict re-pins across a CHAIN of content-free base updates.

Before this, `collect()` followed ONE hop: when the head was a clean merge of
main, verdicts were pinned to its FIRST PARENT's date, whether or not that
parent was itself a base update. Two `update-branch` merges in a row therefore
retired every APPROVE posted before the second one -- measured on #4791, and
again on #4801 and #4829 on 2026-09-30, each costing a review round that
measured nothing new.

EVERY FIXTURE HERE IS A REAL GIT REPOSITORY, not a list of fake shas. The
property under test is what `git merge-tree --write-tree` and
`git merge-base --is-ancestor` SAY about real commits, and a stub would only
restate the author's belief about git.

THE DATES ARE THE MECHANISM. Verdict liveness is a timestamp proxy
(`parse_verdicts`: `created_at >= pin date`), so every fixture places the
approval BETWEEN two commits of the chain. A fixture whose approval postdated
every commit would pass whether or not the walk ran at all, which is the
could-not-fail shape `assertion-design.md` exists to prevent. The timeline,
shared by every test:

    08:00  V    the PR commit a reviewer measured
    09:00       APPROVE posted            <- APPROVED_AT
    10:00  H1   update-branch #1 (or an evil merge, or a side-branch merge)
    10:30  C    an ordinary commit (only in the plain-commit fixture)
    11:00       a LATER approval          <- LATE_APPROVAL_AT
    12:00  H2   update-branch #2
    14:00  H3   update-branch #3

Mutation arms CH1-CH10 in `mutate_gates.py` point at the code these witness
(CH5-CH10 from round 2 of #4843's review).
"""
from __future__ import annotations

import datetime as _dt
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import merge_gate
import test_merge_gate as tmg

import gates

T_M0 = "2026-09-01T00:00:00Z"
T_MAIN = ("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", "2026-09-04T00:00:00Z")
T_V = "2026-09-10T08:00:00Z"
APPROVED_AT = "2026-09-10T09:00:00Z"
T_H1 = "2026-09-10T10:00:00Z"
T_C = "2026-09-10T10:30:00Z"
LATE_APPROVAL_AT = "2026-09-10T11:00:00Z"
T_H2 = "2026-09-10T12:00:00Z"
T_H3 = "2026-09-10T14:00:00Z"
T_SIDE = "2026-09-05T00:00:00Z"


def _git_date(iso: str) -> str:
    """Git's internal `<epoch> +0000` form -- unambiguous on every git version."""
    when = _dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=_dt.timezone.utc)
    return f"{int(when.timestamp())} +0000"


class ChainRepo:
    """A throwaway repo: main = m0..m3, a PR branch from m0, a side branch.

    Built with the global and system git config SHUT OUT. The builder commits
    and merges, so an ambient `commit.gpgsign`, `core.hooksPath` or
    `merge.ff=only` would change what it builds -- the fixture inheriting the
    setting it depends on, which `_repo_with` in `test_merge_gate.py` records
    as the way a rename arm SURVIVED.
    """

    def __init__(self, root):
        self.repo = root / "repin-repo"
        self.repo.mkdir()
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_CONFIG_NOSYSTEM": "1"}
        self.git("init", "--quiet")
        self.git("symbolic-ref", "HEAD", "refs/heads/main")
        self.git("config", "user.email", "t@example.invalid")
        self.git("config", "user.name", "t")
        self.m0 = self.commit("base.txt", "base\n", T_M0)
        self.main = [self.commit(f"main{i}.txt", f"main {i}\n", when)
                     for i, when in enumerate(T_MAIN, 1)]
        self.base_tip = self.main[-1]
        self.git("checkout", "--quiet", "-b", "side", self.m0)
        self.side = self.commit("side.txt", "unreviewed side content\n", T_SIDE)
        self.git("checkout", "--quiet", "-b", "pr", self.m0)
        self.v = self.commit("pr.txt", "the reviewed change\n", T_V)

    def git(self, *args, when: str | None = None) -> str:
        env = dict(self.env)
        if when:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = _git_date(when)
        done = subprocess.run(["git", *args], cwd=self.repo, env=env,
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        assert done.returncode == 0, (args, done.stderr)
        return done.stdout.strip()

    def commit(self, path: str, text: str, when: str) -> str:
        (self.repo / path).write_text(text, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "--quiet", "-m", f"touch {path}", when=when)
        return self.git("rev-parse", "HEAD")

    def merge(self, ref: str, when: str, evil: tuple[str, str] | None = None) -> str:
        """Merge `ref` into the PR branch, as `update-branch` does (PR side first).

        `evil=(path, text)` amends content INTO the merge commit -- a merge
        whose tree is NOT what `merge-tree` computes, i.e. content authored
        inside a commit that looks like a base update.
        """
        if evil is None:
            self.git("merge", "--quiet", "--no-ff", "--no-edit", ref, when=when)
        else:
            self.git("merge", "--quiet", "--no-ff", "--no-commit", ref, when=when)
            (self.repo / evil[0]).write_text(evil[1], encoding="utf-8")
            self.git("add", "-A")
            self.git("commit", "--quiet", "--no-edit", when=when)
        return self.git("rev-parse", "HEAD")

    def tree(self, sha: str) -> str:
        return self.git("rev-parse", f"{sha}^{{tree}}")

    def fresh_branch(self, name: str) -> None:
        """Start a new PR branch at V. Every commit here is DETERMINISTIC --
        fixed content, fixed dates, fixed parents -- so two tests building
        "H1 = merge m1 at 10:00" produce the SAME sha, and sharing one repo
        across the module cannot let one test's commits leak into another's
        chain: a chain is read by parenthood from its own head."""
        self.git("checkout", "--quiet", "-B", name, self.v)


@pytest.fixture(scope="module")
def _shared_repo(tmp_path_factory):
    # ONE repo per module. Building it is ~20 git spawns, which cost ~4 s per
    # test on the Windows box this was written on, and the mutation matrix
    # runs this file once per arm.
    return ChainRepo(tmp_path_factory.mktemp("repin"))


@pytest.fixture
def chain(_shared_repo, monkeypatch, request):
    _shared_repo.fresh_branch(f"t-{request.node.name}"[:100])
    # `sh()` runs every git read in REPO_ROOT, so this points the REAL
    # production reads -- rev-list, rev-parse, merge-tree, merge-base, show --
    # at the fixture. Nothing below stubs git.
    monkeypatch.setattr(merge_gate, "REPO_ROOT", str(_shared_repo.repo))
    return _shared_repo


def _approval(at: str, cid: int = 1) -> dict:
    return {"id": cid, "body": "## Independent review - APPROVE\n\nlooks right.",
            "created_at": at}


def _verdict_gate(repin: dict, head_date: str, approved_at: str) -> dict:
    """Gate 2+3 through the REAL `run_gates`, with the repin `resolve_repin` made."""
    result = tmg._run(head_date=head_date, repin=repin,
                      comments=[_approval(approved_at)])
    return tmg._gate(result, "2+3")


# --- (a) two hops: the #4791 shape ---------------------------------------

def test_a_two_hop_content_free_chain_transfers_the_approval(chain):
    """V -> H1 (merge m1) -> H2 (merge m2). The APPROVE was posted at 09:00,
    after V and before H1. Both hops are content-free merges of main.

    BREAKS IF the walk follows ONE hop (arm CH1, the pre-#4811 code): the pin
    becomes H1, dated 10:00, the 09:00 approval predates it, and gate 2+3 goes
    red. The pin assertion names that value directly -- `pin == H1` is the
    defect, `pin == V` the fix.
    """
    h1 = chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)

    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    assert repin["ok"], repin["why"]
    assert repin["pin"] == chain.v, (
        f"pinned to {repin['pin'][:12]}, expected V {chain.v[:12]}; H1 is "
        f"{h1[:12]} -- a pin at H1 is the one-hop defect")
    assert repin["date"] == T_V, repin

    gate = _verdict_gate(repin, T_H2, APPROVED_AT)
    assert gate["ok"], gate["detail"]


def test_a_control_the_same_approval_is_stale_without_the_re_pin(chain):
    """THE CONTROL for the test above: identical chain and approval, ONLY the
    re-pin refused. If this were green, the approval would be live for some
    reason other than the walk, and the test above would prove nothing.

    BREAKS IF `run_gates` stops honouring `repin.ok`, or the fixture's 09:00
    approval stops predating H2 (12:00).
    """
    chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    refused = {"ok": False, "why": "control", "date": "", "pin": ""}
    gate = _verdict_gate(refused, T_H2, APPROVED_AT)
    assert not gate["ok"], gate["detail"]
    # ...and the positive half, so the refusal above is not merely "the chain
    # never resolves": the same head DOES re-pin when asked.
    assert merge_gate.resolve_repin(h2, chain.base_tip)["ok"]


# --- (b) a middle hop that authored content -----------------------------

def test_b_an_evil_merge_in_the_middle_ends_the_chain(chain):
    """V -> H1' (merge m1 PLUS an amended file) -> H2 (merge m2).

    H1' has two parents and m1 is on main, so ONLY its tree distinguishes it
    from a real base update. H2 transfers; H1' is the pin.

    BREAKS IF the tree check is dropped (arm CH2): H1' then transfers, the pin
    walks down to V, and the 09:00 approval -- which never saw the amended
    file -- goes live. The absence assertion is paired with a positive one: an
    approval at 11:00, after H1', IS live, so the chain still works.
    """
    h1_evil = chain.merge(chain.main[0], T_H1, evil=("pr.txt", "UNREVIEWED\n"))
    h2 = chain.merge(chain.main[1], T_H2)
    # The fixture's shape, CHECKED rather than assumed: H1' really is a
    # two-parent merge whose tree differs from what merge-tree computes.
    auto = chain.git("merge-tree", "--write-tree", chain.v, chain.main[0])
    assert auto.splitlines()[0] != chain.tree(h1_evil), (
        "the evil merge's tree equals the auto-merge -- the fixture authored "
        "nothing, and this test would measure nothing")

    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    assert repin["ok"], repin["why"]
    assert repin["pin"] == h1_evil, (
        f"pinned to {repin['pin'][:12]}; the evil merge {h1_evil[:12]} authored "
        f"content, so a pin below it (V = {chain.v[:12]}) transfers an unseen change")
    assert "carries content the merge did not produce" in repin["why"], repin["why"]

    stale = _verdict_gate(repin, T_H2, APPROVED_AT)
    assert not stale["ok"], (
        "an approval older than the evil merge transferred across it: "
        + stale["detail"])
    live = _verdict_gate(repin, T_H2, LATE_APPROVAL_AT)
    assert live["ok"], live["detail"]


def test_b_an_ordinary_commit_in_the_middle_ends_the_chain(chain):
    """V -> H1 (merge m1) -> C (a one-parent commit) -> H2 (merge m2).

    C authored content and is not a merge, so the walk stops AT C even though
    H1 below it is a perfectly good base update: verdicts older than C never
    saw C.

    BREAKS IF the walk skips a non-merge (e.g. follows `parents[0]` without
    requiring two parents): the pin reaches V and the 09:00 approval goes live.
    """
    chain.merge(chain.main[0], T_H1)
    c = chain.commit("pr.txt", "a later edit\n", T_C)
    h2 = chain.merge(chain.main[1], T_H2)

    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    assert repin["ok"], repin["why"]
    assert repin["pin"] == c, (repin["pin"][:12], c[:12], chain.v[:12])
    assert not _verdict_gate(repin, T_H2, APPROVED_AT)["ok"]
    assert _verdict_gate(repin, T_H2, LATE_APPROVAL_AT)["ok"]


# --- (c) a hop whose second parent is not on main -----------------------

def test_c_a_merge_of_a_branch_that_is_not_main_does_not_transfer(chain):
    """V -> H1 (merge of `side`, NOT on main) -> H2 (merge m2).

    H1 is a CLEAN merge -- its tree equals merge-tree's -- so the tree check
    alone accepts it. It still imports `side.txt`, which no reviewer of this PR
    measured. Only the ancestry check refuses it.

    BREAKS IF the main-ancestry check is dropped (arm CH3): H1 transfers, the
    pin reaches V, and the 09:00 approval goes live over unreviewed content.
    """
    h1_side = chain.merge(chain.side, T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    # The shape, CHECKED: the side merge is clean (so only ancestry can refuse
    # it) and `side` really is not on the base tip.
    auto = chain.git("merge-tree", "--write-tree", chain.v, chain.side)
    assert auto.splitlines()[0] == chain.tree(h1_side), "fixture: side merge not clean"
    ancestry = subprocess.run(
        ["git", "merge-base", "--is-ancestor", chain.side, chain.base_tip],
        cwd=chain.repo, capture_output=True, text=True)
    assert ancestry.returncode == 1, ancestry

    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    assert repin["ok"], repin["why"]
    assert repin["pin"] == h1_side, (repin["pin"][:12], h1_side[:12], chain.v[:12])
    assert "NOT an ancestor of the base tip" in repin["why"], repin["why"]
    assert not _verdict_gate(repin, T_H2, APPROVED_AT)["ok"]
    assert _verdict_gate(repin, T_H2, LATE_APPROVAL_AT)["ok"]


def test_c_a_head_that_merges_a_non_main_branch_does_not_re_pin_at_all(chain):
    """The same property at the HEAD, where the one-hop code never checked it:
    V -> H1 (merge of `side`). Nothing transfers; the head date governs.

    BREAKS IF the ancestry check is dropped (CH3): the head transfers and the
    09:00 approval goes live.
    """
    h1_side = chain.merge(chain.side, T_H1)
    repin = merge_gate.resolve_repin(h1_side, chain.base_tip)
    assert not repin["ok"], repin
    assert "NOT an ancestor" in repin["why"], repin["why"]
    assert not _verdict_gate(repin, T_H1, APPROVED_AT)["ok"]


# --- (d) three hops ------------------------------------------------------

def test_d_a_three_hop_chain_transfers(chain):
    """V -> H1 -> H2 -> H3, all merges of main.

    BREAKS IF the walk follows one hop (CH1): pin = H2 (12:00) and the 09:00
    approval is stale. Also breaks if the walk follows a FIXED two hops: pin =
    H1 (10:00), still stale.
    """
    chain.merge(chain.main[0], T_H1)
    chain.merge(chain.main[1], T_H2)
    h3 = chain.merge(chain.main[2], T_H3)
    repin = merge_gate.resolve_repin(h3, chain.base_tip)
    assert repin["ok"], repin["why"]
    assert repin["pin"] == chain.v, (repin["pin"][:12], chain.v[:12])
    assert _verdict_gate(repin, T_H3, APPROVED_AT)["ok"]


# --- (e) one hop: the regression check for the old behaviour -------------

def test_e_a_single_base_update_still_transfers(chain):
    """V -> H1. What the one-hop code already did must still happen.

    BREAKS IF the walk refuses a chain that ends after one hop -- e.g. requires
    two, or treats the pin itself as a hop to cross.
    """
    h1 = chain.merge(chain.main[0], T_H1)
    repin = merge_gate.resolve_repin(h1, chain.base_tip)
    assert repin["ok"], repin["why"]
    assert repin["pin"] == chain.v
    assert _verdict_gate(repin, T_H1, APPROVED_AT)["ok"]


def test_e_a_verdict_older_than_the_pin_never_transfers(chain):
    """The lower edge: an approval at 07:00 predates V itself (08:00), so it
    measured some EARLIER version of the PR. It must stay stale however long
    the chain above V is.

    BREAKS IF the pin date is taken from anywhere older than V, or the walk
    crosses V (a non-merge) and keeps going.
    """
    chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    assert repin["ok"], repin
    assert repin["date"] == T_V, repin
    assert not _verdict_gate(repin, T_H2, "2026-09-10T07:00:00Z")["ok"]


def test_e_an_ordinary_head_is_not_re_pinned(chain):
    """A plain push on top of V: nothing to walk. Pins to the head.

    BREAKS IF a non-merge head is accepted as the start of a chain.
    """
    head = chain.commit("pr.txt", "pushed fix\n", T_H1)
    repin = merge_gate.resolve_repin(head, chain.base_tip)
    assert not repin["ok"], repin
    assert "1 parent(s), not 2" in repin["why"], repin["why"]


# --- (f) the bound --------------------------------------------------------

def test_f_a_chain_longer_than_the_bound_refuses(chain):
    """Three content-free hops with a bound of TWO: refuse, and say why.

    The positive boundary is asserted beside it, so the refusal is about the
    COUNT and not about this chain: the same head with a bound of three
    transfers, and a two-hop head with a bound of two transfers.

    BREAKS IF the bound is off by one, or is removed at BOTH of its sites. It
    is enforced twice since round 2 -- in the loop's `else` when the facts run
    out, and after the loop -- so removing ONE site does not turn this red:
    arm CH4 (the `else` site) is killed by
    `test_facts_that_end_before_a_content_commit_refuse`, and CH5 (the
    after-loop site) by `test_the_bound_holds_when_a_content_commit_follows`.
    Said here so this test is not counted as CH4's witness (measured: green
    under CH4 alone, round 2).
    """
    chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    h3 = chain.merge(chain.main[2], T_H3)

    over = merge_gate.resolve_repin(h3, chain.base_tip, max_hops=2)
    assert not over["ok"], over
    assert "longer than 2 hop(s)" in over["why"], over["why"]

    assert merge_gate.resolve_repin(h3, chain.base_tip, max_hops=3)["ok"]
    assert merge_gate.resolve_repin(h2, chain.base_tip, max_hops=2)["ok"]


def test_f_the_default_bound_is_twenty():
    """Pins the declared value, so a silent change is a visible diff here.

    BREAKS IF `REPIN_MAX_HOPS` changes, or `resolve_repin`'s default stops
    being it. (A documentation pin: the value, not the behaviour -- the
    behaviour is `test_f_a_chain_longer_than_the_bound_refuses`.)
    """
    import inspect

    assert gates.REPIN_MAX_HOPS == 20
    default = inspect.signature(merge_gate.resolve_repin).parameters["max_hops"].default
    assert default == gates.REPIN_MAX_HOPS


# --- missing objects refuse -------------------------------------------------

def test_an_unreadable_base_tip_refuses_rather_than_transferring(chain):
    """The ancestry check cannot run against an object the store lacks. That
    is UNKNOWN, and unknown must refuse -- never read as "on main".

    BREAKS IF `merge-base --is-ancestor`'s rc=128 is folded into True, or the
    hop accepts `base_side_on_main=None`.
    """
    h1 = chain.merge(chain.main[0], T_H1)
    repin = merge_gate.resolve_repin(h1, "f" * 40)
    assert not repin["ok"], repin
    assert "not SHOWN to be an ancestor" in repin["why"], repin["why"]
    # Positive half: the same head against the real tip transfers.
    assert merge_gate.resolve_repin(h1, chain.base_tip)["ok"]


def test_an_unreadable_head_refuses(chain):
    """A head the store does not have -- the un-fetched PR head of #4648.

    BREAKS IF a failed `rev-list` resolves to anything but a refusal.
    """
    repin = merge_gate.resolve_repin("e" * 40, chain.base_tip)
    assert not repin["ok"], repin


# --- the detail line names every hop ---------------------------------------

def test_the_gate_detail_names_every_hop_sha_tree_and_second_parent(chain):
    """The auditor's line: each hop's sha, tree and second parent, so every
    `merge-tree` can be re-run by hand.

    BREAKS IF any hop is dropped from `why` (e.g. only the first or last is
    described), or run_gates stops appending it to the 2+3 detail.
    """
    h1 = chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    detail = _verdict_gate(repin, T_H2, APPROVED_AT)["detail"]
    assert "RE-PINNED" in detail, detail
    for hop, second in ((h2, chain.main[1]), (h1, chain.main[0])):
        for fact in (hop, chain.tree(hop), second):
            assert fact[:12] in detail, (fact[:12], detail)
    assert "2 content-free base update(s)" in detail, detail


# --- the pure resolver: shapes a real repo cannot produce ----------------

def _hop(sha, p1, p2="m" * 40, tree="t" * 40, auto="t" * 40, on_main=True):
    return gates.BaseUpdateHop(sha=sha, parents=(p1, p2), automerge_tree=auto,
                               tree=tree, base_side_on_main=on_main)


def test_a_walk_that_skips_a_commit_refuses():
    """Hop 2 is not hop 1's first parent. A collector that skipped a commit
    could have skipped the one that authored content.

    BREAKS IF the linkage check is removed: this chain would then pin at
    `v` with ok=True.
    """
    hops = [_hop("h" * 40, "x" * 40), _hop("y" * 40, "v" * 40),
            gates.BaseUpdateHop("v" * 40, ("0" * 40,), None, "t" * 40, None)]
    got = gates.resolve_repin_chain(hops)
    assert not got.ok, got
    assert "skipped a commit" in got.why, got.why
    # Positive half: the correctly linked chain pins at v.
    linked = [_hop("h" * 40, "y" * 40), _hop("y" * 40, "v" * 40), hops[2]]
    assert gates.resolve_repin_chain(linked).pin == "v" * 40


def test_facts_that_end_before_a_content_commit_refuse():
    """Every supplied hop transfers and there are fewer than the bound: the
    facts were truncated, so no pin was established.

    BREAKS IF a truncated walk pins at the last hop's parent.
    """
    got = gates.resolve_repin_chain([_hop("h" * 40, "v" * 40)], max_hops=5)
    assert not got.ok, got
    assert "facts end after 1" in got.why, got.why
    assert not gates.resolve_repin_chain([]).ok


# --- Round 2 (#4843 review) -------------------------------------------------

def test_the_reason_names_the_commit_that_ended_the_walk_not_the_head(chain):
    """B1 (R7). V -> H1 -> H2: the walk ends at V, a one-parent commit two hops
    BELOW the head. The reason must name V, not call it "head".

    BREAKS IF the chain walk stops passing `subject` (the one-hop wording then
    reads "head has 1 parent(s)" -- about a commit that is not the head, which
    is the false statement B1 found). Arm CH6.
    """
    chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    repin = merge_gate.resolve_repin(h2, chain.base_tip)
    assert repin["ok"], repin["why"]
    pin = repin["pin"]
    assert pin == chain.v, (pin[:12], chain.v[:12])
    assert f"{pin[:12]} has 1 parent(s)" in repin["why"], repin["why"]
    # Paired absence: the head's name is not attached to V's fact.
    assert "head has 1 parent(s)" not in repin["why"], repin["why"]


def test_a_refused_re_pin_is_named_in_the_gate_detail(chain):
    """B2. A plain push on V: nothing transfers, and the 2+3 detail must SAY so
    and why -- otherwise "no re-pin" and "the walk never ran" read the same.

    BREAKS IF `run_gates` prints the re-pin reason only on success (arm CH7).
    The positive half: a transferring chain prints RE-PINNED and not the
    refusal, so the two lines are not merely both always present.
    """
    head = chain.commit("pr.txt", "pushed fix\n", T_H1)
    refused = merge_gate.resolve_repin(head, chain.base_tip)
    assert not refused["ok"], refused
    detail = _verdict_gate(refused, T_H1, APPROVED_AT)["detail"]
    assert f"NOT re-pinned: commit {head[:12]} has 1 parent(s)" in detail, detail
    assert "RE-PINNED" not in detail, detail

    chain.fresh_branch("t-b2-positive")
    h1 = chain.merge(chain.main[0], T_H1)
    ok = merge_gate.resolve_repin(h1, chain.base_tip)
    ok_detail = _verdict_gate(ok, T_H1, APPROVED_AT)["detail"]
    assert "RE-PINNED" in ok_detail, ok_detail
    assert "NOT re-pinned" not in ok_detail, ok_detail


def test_a_reversed_parent_merge_does_not_transfer(chain):
    """A3. The SAME content merged the other way round: main's tip first, the
    PR commit V second (`git checkout main && git merge V`). Its tree equals
    the forward merge's, so only parent ORDER differs -- and parents[0] is the
    side the walk treats as the PR, so the reversed merge must refuse: its
    second parent V is not on main.

    BREAKS IF the ancestry check is dropped (arm CH3) or the walk picks the
    PR side by anything but first-parent position. The positive half is the
    forward merge of the same two commits, which transfers.
    """
    forward = chain.merge(chain.base_tip, T_H1)
    fwd = merge_gate.resolve_repin(forward, chain.base_tip)
    assert fwd["ok"], fwd["why"]
    assert fwd["pin"] == chain.v

    chain.git("checkout", "--quiet", "-B", "t-a3-reversed", chain.base_tip)
    reversed_head = chain.merge(chain.v, T_H1)
    assert chain.tree(reversed_head) == chain.tree(forward), (
        "fixture: the reversed merge should carry the same bytes, so that ONLY "
        "parent order distinguishes it")
    rev = merge_gate.resolve_repin(reversed_head, chain.base_tip)
    assert not rev["ok"], rev
    assert f"second parent {chain.v[:12]} is NOT an ancestor" in rev["why"], rev["why"]


def test_an_unreadable_pin_date_refuses(chain, monkeypatch):
    """B3. The chain resolves, but the pin's committer date cannot be read.
    That is an unmeasurable re-pin, and it must refuse rather than hand
    `run_gates` an `ok` repin with an empty date.

    The failure is injected at the ONE git call that reads the date (`show -s`)
    and nowhere else, so the walk itself runs for real.

    BREAKS IF `resolve_repin` stops checking the date (arm CH8 -- the `if not
    date:` guard becomes `if False:` and the result is ok=True, date="").
    """
    chain.merge(chain.main[0], T_H1)
    h2 = chain.merge(chain.main[1], T_H2)
    assert merge_gate.resolve_repin(h2, chain.base_tip)["ok"]   # positive half

    real_sh = merge_gate.sh

    def sh_without_show(argv, *a, **kw):
        if argv[:3] == ["git", "show", "-s"]:
            return 128, "", "fatal: injected - cannot read the pin"
        return real_sh(argv, *a, **kw)

    monkeypatch.setattr(merge_gate, "sh", sh_without_show)
    got = merge_gate.resolve_repin(h2, chain.base_tip)
    assert not got["ok"], got
    assert got["date"] == "", got
    assert "pin's date could not be read" in got["why"], got["why"]


def test_the_pin_date_is_utc_whatever_the_local_timezone(chain):
    """B5. `commit_date_utc` must produce UTC regardless of the box's zone.
    On a UTC runner a LOCAL-time conversion gives the same string, so an
    in-process test cannot tell them apart there. This runs the real function
    in a CHILD Python with `TZ=IST-5:30` (POSIX form, which both glibc and the
    Windows CRT honour), so local time is 5h30 ahead of UTC on every OS.

    The child ALSO prints the local conversion of the same epoch -- the
    positive control that TZ took effect. If it did not, the control assert
    fails loudly rather than the test passing blind.

    BREAKS IF `fromtimestamp` loses its `timezone.utc` argument (arm CH9):
    the child then prints 13:30 for an 08:00Z commit.
    """
    epoch = int(_dt.datetime.strptime(T_V, "%Y-%m-%dT%H:%M:%SZ")
                .replace(tzinfo=_dt.timezone.utc).timestamp())
    drain_dir = os.path.dirname(os.path.abspath(merge_gate.__file__))
    script = (
        "import sys, datetime\n"
        f"sys.path.insert(0, {drain_dir!r})\n"
        "import merge_gate\n"
        f"merge_gate.REPO_ROOT = {str(chain.repo)!r}\n"
        f"print(merge_gate.commit_date_utc({chain.v!r}))\n"
        f"print(datetime.datetime.fromtimestamp({epoch})"
        ".strftime('%Y-%m-%dT%H:%M:%S'))\n"
    )
    env = {**os.environ, "TZ": "IST-5:30"}
    done = subprocess.run([sys.executable, "-c", script], env=env,
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    assert done.returncode == 0, done.stderr
    got, local = done.stdout.strip().splitlines()[-2:]
    assert local == "2026-09-10T13:30:00", (
        f"control: TZ did not take effect in the child (local={local}) - this "
        "test would be blind to a local-time conversion")
    assert got == T_V, f"pin date {got}, expected {T_V} (13:30Z is local time)"


def test_the_pr_head_is_fetched_before_gate_one_reads_it():
    """A1. In `collect`, the `git fetch origin pull/<n>/head` must come BEFORE
    the `git merge-base <tip> <head>` that gate 1 reads, and before the re-pin
    walk -- both read the head from the local store (#4648).

    A STRUCTURAL pin, read from the AST (so a comment cannot satisfy it), not
    a behavioural one: `collect` has no harness, it calls `gh` a dozen times.
    Disclosed as such (`assertion-design.md` #5): it proves the ORDER of the
    calls, not that the fetch succeeds.

    BREAKS IF the fetch moves back below the merge-base (arm CH10), or is
    deleted (the lookup then finds nothing).
    """
    import ast
    import pathlib

    tree = ast.parse(pathlib.Path(merge_gate.__file__).read_text(encoding="utf-8"))
    collect = next(n for n in tree.body
                   if isinstance(n, ast.FunctionDef) and n.name == "collect")

    def first_line(pred):
        lines = [n.lineno for n in ast.walk(collect)
                 if isinstance(n, ast.Call) and pred(n)]
        return min(lines) if lines else None

    def git_argv(call):
        arg = call.args[0] if call.args else None
        if not (isinstance(arg, ast.List) and arg.elts
                and isinstance(arg.elts[0], ast.Constant) and arg.elts[0].value == "git"):
            return None
        return arg.elts

    def is_pull_fetch(call):
        elts = git_argv(call)
        return bool(elts) and any(
            isinstance(e, ast.JoinedStr) and any(
                isinstance(v, ast.Constant) and "pull/" in str(v.value)
                for v in e.values) for e in elts)

    def is_gate1_merge_base(call):
        elts = git_argv(call)
        return bool(elts) and len(elts) > 2 and getattr(elts[1], "value", None) == "merge-base" \
            and getattr(elts[2], "value", None) != "--is-ancestor"

    def is_repin(call):
        return getattr(call.func, "id", None) == "resolve_repin"

    fetch, mb, rp = (first_line(is_pull_fetch), first_line(is_gate1_merge_base),
                     first_line(is_repin))
    assert None not in (fetch, mb, rp), (fetch, mb, rp)
    assert fetch < mb, f"pull-head fetch at line {fetch} is after gate 1's merge-base at {mb}"
    assert fetch < rp, f"pull-head fetch at line {fetch} is after the re-pin at {rp}"


def test_the_bound_holds_when_a_content_commit_follows():
    """A2. Three content-free hops, THEN a content commit, with a bound of 2.
    The walk reaches a real pin, but only by crossing more hops than the bound
    allows -- it must refuse.

    BREAKS IF the bound is checked only when the facts run out (arm CH5): this
    chain then pins at `v` with ok=True. Positive half: the same facts with a
    bound of 3 pin at `v`.
    """
    content = gates.BaseUpdateHop("v" * 40, ("0" * 40,), None, "t" * 40, None)
    hops = [_hop("a" * 40, "b" * 40), _hop("b" * 40, "c" * 40),
            _hop("c" * 40, "v" * 40), content]
    over = gates.resolve_repin_chain(hops, max_hops=2)
    assert not over.ok, over
    assert "longer than 2 hop(s)" in over.why, over.why
    at = gates.resolve_repin_chain(hops, max_hops=3)
    assert at.ok, at.why
    assert at.pin == "v" * 40

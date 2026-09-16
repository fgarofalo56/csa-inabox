# ASSERTION DESIGN — every assertion must name the value that would break it (die-hard rule)

**Effective: 2026-09-16. Scope: every test, every guard, every mutation arm,
every measurement this repo treats as evidence — Python, JS/TS, shell, workflow
YAML. All branches, all contributors (human or agent). This rule sits ABOVE "the
suite is green": a passing suite that cannot fail is not evidence, and this
repo's dominant defect class is a control that watches nothing.**

## The rule

**For every assertion you write, answer one question before you keep it:**

> **What value would make this fail?**

If you cannot name a concrete input that turns it red, the assertion is not
coverage. It may still be worth keeping — as documentation, or as a guard
against a future loosening — but it must be **labelled as such** and must not be
counted toward the claim that a behaviour is tested.

This is deliberately not "does this cover the case". That question is answered
by intent, and intent is exactly what is wrong when a test is written by the
same person who wrote the defect.

## Why this rule exists (measured, 2026-09-15/16)

In one session, across PRs #4491, #4498 and #4506, **five tests witnessed
nothing**: three passed against the very defect they were written to condemn,
one was red against the fix *and* the defect, and one was counted as coverage
while having no kill power at all. Every one was written by an author who
believed the test was aimed correctly.

The distinction in the last column is not pedantry. A test that **cannot fail**
reports false green and a defect ships. A test that **cannot pass** reports
false red and sends the author to fix code that was already correct — which is
what happened here, and it cost a round. Both are the same underlying error
(the fixture never reaches the rule), and neither is caught by asking "does
this cover the case".

| what was written | why it witnessed nothing | failure mode |
|---|---|---|
| a leak test for `lastRun.error` | used an `outcome` that never reaches that read — the vulnerable branch was `rebuild_failed` | could not fail |
| a straddle fixture through `writeBody` | `JSON.stringify` prepends a quote; the offset shifted by one, 17 characters survived the cut and the assertion looked for 18 | could not fail |
| a test for a deleted stderr redirect | a file shared with another phase kept the disclosure firing, so the mutation was invisible | could not fail |
| a straddle fixture for a credential | padding abutted `code=`, and the rule's negative lookbehind (`(?<![A-Za-z0-9_])`) means `xcode=` never matches — so nothing was redacted and the fragment was present in BOTH outputs | could not **pass** |
| `assert args["before"] != args["after"]` | a dict-equality assertion three lines above pinned both values and threw first | no kill power |

The fourth row is annotated at its site, and the annotation is the reason this
rule exists in the form it does: *"the test failed WITH the fix applied while
appearing to prove the fix was broken"*
(`scripts/ci/__tests__/classify-reindex-result.test.mjs:1011-1013`).

Two of these were the fix for the previous one. The remedy each time was not a
better assertion — it was asking **what value would make this fail** (or pass)
and discovering the answer was "none".

## What "done" means

1. **A new test states the input that breaks it.** Either in an assertion
   message, a comment, or by construction (a fixture whose arithmetic is
   asserted inline). "This covers X" is not that.
2. **A test claimed to catch a defect is run against that defect.** Apply the
   mutation **to a sandbox copy**, watch it go RED, and check the tracked tree
   is untouched. Do NOT mutate the tracked tree and revert: `mutate_gates.py`
   refuses any run where the tracked tree changed (`:2308`), an `|| echo` after
   a failed `git checkout --` has already fabricated a revert that never
   happened, and the reviewers this rule memorialises all copied to a scratch
   directory instead. If you do mutate in place, prove the revert with
   `git hash-object` before and after — but prefer the copy.
   A test that has never failed has never been shown to work.
3. **A fixture's shape is checked against the rule it must trigger.** Read the
   regex, the lookbehind, the length floor, the serialisation — do not reason
   about them. Lift the pattern out of the source at runtime rather than
   transcribing it, so a typo cannot make the probe disagree with the
   implementation.
4. **Absence-only assertions are paired with a positive one.** `doesNotMatch`
   alone is satisfied by deleting the feature. Pin that the thing still works.
   **This binds new and touched assertions only.** There are ~407 existing
   `doesNotMatch` sites; they are not retroactively in violation, and this rule
   is not a licence to open 407 issues. Fix one when you touch its test.
5. **An un-killable assertion is DISCLOSED, not counted.** If no input can break
   it, say so at the site and say what it is for. An equivalent mutant is
   evidence about the arm, not a gap in the suite — but it must be named.

## Explicitly forbidden

- Reporting a suite as covering a behaviour when no input distinguishes the
  correct code from the defect.
- A fixture whose two operands are equal, used to test that they are not
  swapped.
- A test that asserts on a MESSAGE while the mutation changes only a COUNT, or
  the reverse, without saying which it pins.
- Transcribing a pattern into a probe instead of lifting it from the source.
- Closing a finding by its LABEL rather than at its SITE. Two findings bundled
  under one name get closed by that name while one of them stays open —
  measured on #4498, where `redactBodyFile` was pinned and `pollFields` was not.
- A green mutation arm reported without saying which it is: a blind test, a weak
  mutation, or a genuine equivalent mutant.

## How to spot a violation

**Read this before running them: these greps are weak, and the numbers below
are why.** They were measured across `tests/ scripts/ tools/ apps/` on
2026-09-16, and reporting them as a triage tool without the counts would be the
same defect this rule is about — a control that looks like it watches.

```bash
# 1. Assertions that can only ever be true. Returns ZERO today, repo-wide.
#    That is a REGRESSION GUARD, not a finder -- run it to keep the count at
#    zero, and do not read a clean result as evidence the suite has teeth.
grep -rnE "assert(\.ok)?\(\s*(true|True|1)\s*\)" tests/ scripts/ tools/ apps/

# 2. Absence-only tests. 432 `doesNotMatch` hits, and the rule binds only the
#    ones you touch (see "done" #4) -- so this is a list to check AGAINST your
#    diff, never a backlog to burn down.
#    `assertNotIn` is not used in this repo (0 hits) and bare `not in` is 300
#    hits of ordinary control flow; neither belongs in this grep.
grep -rn "doesNotMatch" tests/ scripts/ tools/ apps/
```

**The real check is not greppable**, and no version of it will be: take the
diff's new assertions and, for each, name the input that breaks it. If you
cannot, it is not coverage. Every one of the five failures above would have
passed all of the greps above.

The one mechanically decidable fragment — a new `doesNotMatch` with no positive
assertion in the same `test(...)` block — is worth a real check rather than a
grep, and is tracked separately.

## Verification per merge

A PR adding a test states, for at least its load-bearing assertions, what value
would make each fail — and for any test claimed to catch a specific defect,
shows the mutation run: RED with the defect, green without, tree restored and
proven.

Related: `no-vaporware.md` (a control that does nothing is vaporware),
`deploy-integrity.md` R7 (never assert what you did not establish), and the
`csa_loom_a_green_mutation_is_ambiguous_blind_test_or_weak_mutation` memory.

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

In one session, across PRs #4491, #4498 and #4506, **four tests written to
condemn a specific defect passed against that defect**, and one more was
counted as coverage while having no kill power at all. Every one was written by
an author who believed the test was aimed correctly.

| what was written | why it could not fail |
|---|---|
| a leak test for `lastRun.error` | used an `outcome` that never reaches that read — the vulnerable branch was `rebuild_failed` |
| a straddle fixture for a credential | padding abutted `code=`, and the rule's negative lookbehind (`(?<![A-Za-z0-9_])`) means `xcode=` never matches |
| a straddle fixture through `writeBody` | `JSON.stringify` prepends a quote; the offset shifted by one, 17 characters survived the cut and the assertion looked for 18 |
| a test for a deleted stderr redirect | a file shared with another phase kept the disclosure firing, so the mutation was invisible |
| `assert args["before"] != args["after"]` | a dict-equality assertion three lines above pinned both values and threw first |

Two of those were the fix for the previous one. The remedy each time was not a
better assertion — it was asking **what value would make this fail** and
discovering the answer was "none".

## What "done" means

1. **A new test states the input that breaks it.** Either in an assertion
   message, a comment, or by construction (a fixture whose arithmetic is
   asserted inline). "This covers X" is not that.
2. **A test claimed to catch a defect is run against that defect.** Apply the
   mutation, watch it go RED, revert it, and prove the revert with
   `git hash-object` before and after. A test that has never failed has never
   been shown to work.
3. **A fixture's shape is checked against the rule it must trigger.** Read the
   regex, the lookbehind, the length floor, the serialisation — do not reason
   about them. Lift the pattern out of the source at runtime rather than
   transcribing it, so a typo cannot make the probe disagree with the
   implementation.
4. **Absence-only assertions are paired with a positive one.** `doesNotMatch`
   alone is satisfied by deleting the feature. Pin that the thing still works.
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

```bash
# Assertions that can only ever be true (start here, they are the cheap cases):
grep -rnE "assert(\.ok)?\(\s*(true|True|1)\s*\)" tests/ scripts/ tools/
# Absence-only tests with no positive pair in the same test:
grep -rn "doesNotMatch\|assertNotIn\|not in " tests/ scripts/ tools/
# The real check is not greppable: take the diff's new assertions, and for each
# one name the input that breaks it. If you cannot, it is not coverage.
```

## Verification per merge

A PR adding a test states, for at least its load-bearing assertions, what value
would make each fail — and for any test claimed to catch a specific defect,
shows the mutation run: RED with the defect, green without, tree restored and
proven.

Related: `no-vaporware.md` (a control that does nothing is vaporware),
`deploy-integrity.md` R7 (never assert what you did not establish), and the
`csa_loom_a_green_mutation_is_ambiguous_blind_test_or_weak_mutation` memory.

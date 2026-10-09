# PRP Master Index — run order, model, and current status

**Local planning only: do NOT commit secrets here.** The repo is public;
anything sensitive stays in private GHSA drafts and is referenced by id only
(same convention as `finish-2026-10/README.md`).

Measured 2026-10-05 by reading every `PRPs/active/*` directory and
cross-checking every issue/PR number it names against live GitHub state
(`gh issue view` / `gh pr view`). Supersedes `PRPs/active/REGISTER.md`'s
2026-08-31 snapshot for everything it covers below — that file's own
decisions (estate-pause-resume and loom-brain fold into the drain; omnibus
and drain-2026-08-31 are superseded) are carried forward here, re-verified,
not re-litigated.

## How to run each one (same cost rules as `finish-2026-10/README.md`)
1. **Start a fresh session for each PRP.** Never reuse a long one.
2. **Model: Sonnet by default.** Switch to Opus with `/model` only for the
   specific step called out below, then switch back.
3. **Lean briefs:** `temp/brief_common.md` (implementers), `temp/review_protocol.md`
   (reviewers). One reviewer per round on Sonnet; at most 3 rounds.
4. **No sleep-polling.** Queue PR numbers in `temp/automerge_queue.txt` and run
   `python temp/automerge.py` in the background.
5. **Close the session when the PRP's "Done" line is met.** Anything left over
   becomes a GitHub issue, not more conversation.

---

## Run order

| # | PRP | Status (2026-10-05) | Why this order | Model |
|---|---|---|---|---|
| 1 | `finish-2026-10/PRP-02-estate-power.md` | **NOT STARTED.** #4876, #4243, #4235 all still OPEN. | Live Azure spend — every day it's not done is money. Same reasoning the original finish-2026-10 order already gave it; it just never got picked up. | Sonnet; **Opus** only for step 1 (the resume-failure root-cause diagnosis) if the first pass doesn't find it |
| 2 | `PRPs/active/canvas-stacked-docks-minimap/PRP.md` | **READY.** Phase 1 shipped (PR #4951, approved, queued). This PRP covers Phases 2-3. *File is on branch `docs/3699-prp-phase2-3` / PR #4958 — not yet on `main`; if #4958 has merged by the time you read this, it's at the path above, otherwise check out that branch first.* | Fully scoped with exact file paths, prop shapes, and design decisions already made — zero ambiguity, lowest-risk session on this list, and it's a live feature commitment already in motion. | Sonnet. The PRP made the hard calls (reflow algorithm, persistence format, keyboard convention) up front specifically so the implementer doesn't have to — Opus only if the `StackedSplit` reflow math genuinely stalls Sonnet twice |
| 3 | `PRPs/active/per-workspace-spark-identity/PRP.md` | **W0 (spike) approved to start; nothing else is.** Design approved with defaults 2026-09-30. | Least-privilege security hardening (today every workload shares one submitter identity with data-plane scope) — security debt compounds, and W0 is explicitly scoped as cheap/investigative. | Sonnet for W0. Expect to re-plan model choice per later wave once the spike reports back — do not pre-commit. |
| 4 | `PRPs/active/apim-ai-gateway/PRP.md` | **DRAFT, design unblocked, no wave started** (since 2026-09-10/11). 13pt epic, issue #4442. | Largest scoped-but-dormant epic on the shelf. §0 already corrects ~14 wrong premises from the original draft against live Azure/Learn measurement — read that section first, it is not optional. | **Opus** for the first session (re-reading §0-§2 and committing to Wave order against a 13pt, multi-boundary, compliance-sensitive design). Sonnet per-wave after the plan is re-confirmed. |
| — | `finish-2026-10/PRP-05-backlog.md` (i.e. `tools/drain/tick.py` cycles) | **ONGOING, not a one-shot.** 336 ready, 60 needs-audit, 90 parked, 9 declined of 542 total as of this writing. | Not sequenced into the numbered list above — it's the standing mechanism, run via the drain-cycle prompt pattern every session that has spare capacity. **Do not run it in the same session as #3 or #4 above** — both touch `platform/fiab/bicep/**`, and a drain-cycle bicep lane picking up unrelated work in parallel is a real file-collision risk, not a hypothetical one. | Sonnet, lean mode, per all standing 2026-10-01/02 operator cost decisions already in `tools/drain/policy.json` |

### Already done — do not re-run
- `finish-2026-10/PRP-01-tooling-hygiene.md` — `.git/config` is 19.8 KB (under the 20 KB target), #4873 closed, the policy.json escalation rules it shipped are themselves now superseded by the 2026-10-02 "one reviewer on sensitive paths, zero elsewhere" decision (already live in `tools/drain/policy.json`).
- `finish-2026-10/PRP-03-land-open-prs.md` — every PR it named (#4868, #4790, #4822, #4864, #4861, #4866, #4863, #4865, #4838) is MERGED; #4841 and #4233 are CLOSED (per that PRP's own "Done" line: "merged or explicitly closed").
- `finish-2026-10/PRP-04-gov-unity.md` — #4656 is CLOSED.

### Superseded / folded — do not run as standalone
- `PRPs/active/estate-pause-resume/PRP.md` — folds into PRP-02-estate-power.md above (per `REGISTER.md` §2, re-verified: same scope, same tracking issues).
- `PRPs/active/loom-brain/PRP.md` — folds into the drain's console/brain lane (per `REGISTER.md` §2).
- `PRPs/active/omnibus-2026-08-22/PRP.md` — explicitly superseded (its own `:202` records this for several programs including `finishline`).
- `PRPs/active/snowflake-parity/PRP.md` — parked as feature-class work per recorded operator decision (defects-first); not scheduled.
- `PRPs/active/drain-2026-08-31/` and `PRPs/active/drain-2026-09-28/` — both are earlier checkpoints of the exact same mechanism `PRP-05-backlog.md` / `tools/drain/tick.py` now runs live. `tools/drain/state.json` + `tick.py --status` is the only authoritative snapshot; neither document's own embedded counts should be read as current (both say so themselves).
- `PRPs/active/zero-backlog/PRP.md` — same situation: an earlier (2026-09-11, 297-issue) iteration of the same standing drain program, absorbed into the current ledger.
- `PRPs/active/finishline-retirement/` — explicitly retired 2026-09-17; its own README says so and names `tools/drain/` as "the harness of record from here." Pure historical reconciliation record.

---

## Opus vs Sonnet, briefly (unchanged from `finish-2026-10/README.md`)
Sonnet costs about a fifth of Opus per token, and keeps its context small —
which matters more than the per-token price, since most spend on this program
has been re-reading a long conversation on every step, not the reasoning
itself. Use Opus only for the specific steps named in the table above:
a stalled diagnosis, or a first planning pass on a large, compliance-sensitive,
multi-boundary design. Switch back to Sonnet once that step is done.

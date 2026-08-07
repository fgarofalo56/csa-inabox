# loom-apex — DONE ledger (close-out, 2026-08-06)

**Status: the program is CLOSED as an execution vehicle, with honest final
states — NOT declared complete.** Its open residue was folded into
`PRPs/active/finishline/AUDIT-2026-08-06.md` rows C1–C6 and G1, which is now the
authority (`FINISHLINE/PRP.md` §Authority).

This ledger is written at the Phase-E boundary by the FINISHLINE `C1` lane. It
did not exist before this commit — apex ran from 2026-07-24 without one, which
is why phase states had to be reconstructed by measurement rather than read off
a ledger. That gap is itself recorded below.

**Definition of DONE (apex `PRP.md:20`, unchanged):** merged + rolled +
live-verified on BOTH Commercial AND Gov, guard suite green, G1 browser receipt,
zero new vaporware/orphans, LIC0 clean. **No phase below meets it in full.**

Evidence for every claim here: [`ADVERSARIAL-REVIEW.md`](ADVERSARIAL-REVIEW.md)
(refutation battery R1–R14) and [`PHASE-E-REGRADE.md`](PHASE-E-REGRADE.md)
(142-type ledger). Repo `57ab6a66`; live Commercial `7e9289cc` / v0.88.0.

---

## Phase states (measured 2026-08-06, not asserted)

| Phase | Landed | Honest final state | Evidence |
|---|---|---|---|
| **A1** chunk-skew recovery | `4bfa3ed5` | **LIVE-VERIFIED (partial).** `deploymentId` provably live (`?dpl=7e9289cc0a51` on every static asset). ChunkLoadError reload behaviour **not** exercised. | R1 |
| **A2** route error/loading boundaries | `4bfa3ed5` | **SHIPPED, qualified.** Root `error.tsx` + `global-error.tsx` + 41 segment `error.tsx` + 40 `loading.tsx` over 136 pages. No root `loading.tsx`; shell-preservation unverified. | R2 |
| **A3** silent-failure surfaces | `4bfa3ed5`, `96900d4b` | **PARTIAL — 1 of 5 verified.** `incident-console` fixed with a named regression test. Other 4 unconfirmed. | R3 |
| **A4** live page-by-page sweep | `5555d622`, `96900d4b` | **NOT RE-RUN.** Route-smoke harness exists; today only an unauthenticated probe was possible — 127/127 static routes HTTP 200, zero 404/5xx. Not a click-walk. | REGRADE §3 |
| **A5** canvas resize | `4bfa3ed5` | **UNVERIFIABLE without a browser.** `SplitPane`/`sizingKey` in 50 files; `top-tabs` overflow reworked. The operator's actual complaint (grip unreachable at short viewport) is a geometry outcome no source read settles. | R4 |
| **A6** zero involuntary gates | — | **REFUTED — and the instrument is untrustworthy.** Operator saw gates present 08-05; AUDIT **D15** shows day-one scoring wrong in BOTH directions; **D16** s3-gateway opt-in violates default-ON. | R5 |
| **A7** ledger/PRP truth reconcile | (docs) | **DONE.** PARITY-MATRIX fine-tuning F→A−; access-governance DRAFT flipped. | R6 |
| **B** drain | `449b97a8`, `bd4336a4` | **PARTIAL.** Waves 1+2 landed. Open → AUDIT **C2** (N14b/c/e, N19c′, N19d, embedding-pipeline item type), **C3** (B-FN, 11 Functions), **C4** (B-FP′/B-U12/B-R10-17). | R7 |
| **C** Loom Unity | `0c011be8` (LU-2), `a28a5fdd` (LU-3) | **REFUTED — security-material.** LU-2 merged, but **Gov `loom-unity` auth is STILL DISABLED LIVE** (anonymous read+mutate+SAS since the 07-15 image, measured 08-05 → AUDIT **G1**). Commercial has **no producer at all** (**D2**). LU-7/11/12 open (**C5**). | R8 |
| **D** Help Center | `479d3126`, `c35b343d`, `61a46c22` | **PARTIAL.** 144 `editor-*.md` on disk; 142/142 slugs registered. **Visual tutorials 0/159 published** (D6, operator-gated). Residual D3–D5 → **C6**. | R9 |
| **E** validated A+ + adversarial review | *this commit* | **ARTIFACTS LANDED; ACCEPTANCE NOT MET.** Both documents now exist. The click-walk (deliverable 1) did **not** happen — 0/142 exercised. Competitive red-team panel **declared OWED**, not fabricated. | R10, R13 |
| **FRESH0** | *this commit* | **DONE — strict pass, mutation-proved.** Re-baselined at the Phase-E boundary: param-cap 232→234, route-total 1643→1671, route-toolkit-gap 1338→1197. Mutant → exit 1; restored → exit 0. | below |
| **Housekeeping R20–R27** | — | **NOT STARTED.** Was explicitly "LAST, never blocking". | — |

## Why the click-walk did not happen (all three verified today)

1. `loom-ui-verify` last succeeded **2026-08-04T01:02:35Z** (run `30867496747`);
   all three dispatches today failed.
2. **GitHub Actions is degraded** — `Failed to resolve action download info.
   Error: Service Unavailable`; the newest run hung 79 min then cancelled.
3. No authenticated browser path exists from the C1 worktree; minting a session
   needs a secret this agent is forbidden to read.

Per `ux-baseline.md` G1, **zero catalog surfaces are currently eligible for an
A/A+ grade.** Not "known bad" — un-evidenced. Grading them A anyway is the exact
failure this program exists to prevent.

## FRESH0 re-baseline (Phase-E boundary)

`scripts/ci/check-prp-freshness.mjs` — all three numeric facts re-baselined to
live counts; `--strict` now passes with **0 warnings**.

| Fact | Was | Now | Direction |
|---|---:|---:|---|
| `param-cap` (admin-plane bicep params) | 232 | **234** | +2 (still under the 256 cap) |
| `route-total` (`app/api/**/route.ts`) | 1643 | **1671** | +28 |
| `route-toolkit-gap` (hand-rolled session routes) | 1338 | **1197** | **−141 (ratchet tightens — route-toolkit adoption grew)** |

**Mutation proof** (`gates_that_cannot_fail` discipline): with
`route-toolkit-gap` poisoned to 900, `--strict` exits **1**; restored, exits
**0**. Note the guard is wired **warn-only** in `loom-guardrails.yml:202` by
design — `--strict` is for boundary runs like this one.

*Process note worth keeping:* my first mutation test read `$?` after a piped
`tail` and reported `EXIT=0` — a hollow proof of exactly the kind this repo has
been burned by. Re-run with the exit captured from `node` directly. Pipe your
mutation proof and you are testing `tail`.

## What closing this ledger does NOT mean

- It does **not** mean the catalog is A/A+. **33 of 142 item types (23%) are
  disqualified from A on documentary grounds alone** — 14 with no parity doc,
  29 with no editor unit test, 10 missing both — before a browser is opened (R11).
- It does **not** mean gates are clear (R5), Unity is delivered (R8), or the
  Help Center is complete (R9).
- It does **not** close AUDIT rows C1–C6 or G1. C1's own live-verification
  remains OWED.

## Carry-forward (owned by FINISHLINE, not by apex)

| Apex residue | FINISHLINE row |
|---|---|
| Phase-E click-walk + per-surface §7 re-grade | **C1** (this lane — receipts OWED) |
| Phase-B tail (N14b/c/e, N19c′, N19d, embedding-pipeline) | **C2** |
| B-FN Functions → ACA jobs (11) | **C3** |
| B-FP′ / B-U12 / B-R10-17 | **C4** |
| LU-7 / LU-11 / LU-12 | **C5** |
| Help D3–D5 residual; D6 captures (0/159) | **C6** |
| Gov `loom-unity` auth disabled live | **G1** (P0 security) |
| `loom-unity` has no Commercial producer | **D2** |
| Day-one scoring lies both ways | **D15** |
| s3-gateway opt-in violates default-ON | **D16** |
| 14 missing parity docs / 29 missing editor tests | new — see REGRADE §4 |

## Operator items 1–7 (apex `PRP.md:179-186`) — VERBATIM, still owed

Reproduced exactly; these are surfaced to the FINISHLINE operator queue (OP-9).

> 1. Entra CA exclusion for `svc-loom-synthetic@limitlessdata.ai` → V1 login probe online.
> 2. I6/I7 enforce flip — after I9 sign-off + clean-shadow window (~08-05).
> 3. S2 FIC flip on the prod app reg.
> 4. Visual-tutorial capture runs + privacy review (D6).
> 5. RisingWave image-tag confirm; Trino Helm install (opt-ins).
> 6. Esri license for GEO-2 (future program).
> 7. The 10 operator actions in the zero-gates checklist ([research/gates-zero.md](research/gates-zero.md)).

Notes measured today, not re-litigating the items: **#2** names a
clean-shadow window of "~08-05" that has now passed — it needs a fresh
operator decision, not a silent roll-forward. **#4** is quantified: `0/159`
published (items 0/142, features 0/17).

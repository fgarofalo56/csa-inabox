# ACTIVE WORK REGISTER

**The register of record is `PRPs/active/drain-2026-08-31/`.** This file is a
pointer, not a snapshot. The previous revision of this file was a live-state
snapshot measured 2026-08-23; by 2026-08-31 it was actively misleading (stale PR
lists, a merge queue that had since drained, a P0 that had since been verified),
and the operator authorized this rewrite. The history is in git if you need what
it said.

**The design change is deliberate:** a register that embeds live state goes stale
the day after it is written. This one holds only pointers and dispositions, each
dated. Live truth comes from `gh issue list` / `gh pr list` / `gh run list` and
the estate's own `/build-marker.txt` — never from prose in this file.

---

## 1. The register of record — `PRPs/active/drain-2026-08-31/`

The backlog-drain program covering **every open issue** (244 measured
2026-08-31), written to the operator's standing ask: complete specs for
everything owed, built for parallel dev loops.

| Document | Holds |
|---|---|
| `PRP.md` | The program: waves W0–W6, lanes, batching, merge protocol, the ten operator decisions |
| `LEDGER.md` | **Generated** per-issue register — every open issue, exactly once, with verdict/size/wave/lane. Regenerate with `python PRPs/active/drain-2026-08-31/gen-ledger.py`; never hand-edit |
| `OWNERSHIP.md` | Lane file-ownership rules; collision map; what may not run in parallel |
| `FILES.md` | Per-issue file lists with provenance — the input `OWNERSHIP.md` §8 requires before a lane opens |
| `OWED.md` | The honesty ledger: unfiled measured defects, open operator questions (§2), owed receipts, parks with dates |
| `DEV-LOOP.md` | The per-lane dev loop: re-measure at head, implement, verify-gates, review, merge |

An issue absent from `LEDGER.md` is a gap in the program, not an issue that does
not matter. `PENDING-TRIAGE` rows are carried in the open rather than rounded
away.

## 2. Prior in-flight PRPs — dispositions (2026-08-31)

Per `OWED.md` §6. Nothing was dropped; everything folded somewhere named.

| PRP | Disposition |
|---|---|
| `PRPs/active/estate-pause-resume/` | **Folds into the drain's W1 estate-power lane.** Its Gov half is OWED U5: `scripts/measure/estate-resume.mjs` hard-codes the Commercial RG, which cannot satisfy "arm the power button in every boundary" |
| `PRPs/active/loom-brain/` | **Folds into the drain's W1 brain lane** (#4222 — the Brain has zero inbound links — plus #3933-family items per the ledger) |
| `PRPs/active/omnibus-2026-08-22/` | **Superseded.** Its open items are absorbed into `LEDGER.md`; the directory stays for history. Its population count (261) was stale against reality before it was superseded — do not quote it |
| `PRPs/active/snowflake-parity/` | **Feature-class → W6** (defects-first operator decision). Its decisions are recorded and binding: migration-first · transpiler now, wire-compat later · **outcome** parity |

## 3. Standing operator decisions carried by the program

Recorded in `PRP.md`; listed here because they are the ones a cold reader needs
before touching anything: defects first, features parked to W6 · Gov = fix
what's free, park the rest **with a date** · estate verification happens in
batched W4 validation windows · every merge is preflighted, review verdicts are
posted before `--admin` merge · big batches, one CI cycle each · the estate
power button arms by default in **every** boundary.

Merge-drain mechanics (close-parser negation-blindness, hollow-check audit,
`--admin` authorization and its limits) live in auto-memory and `OWED.md` §7 —
not restated here.

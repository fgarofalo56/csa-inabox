# OWNERSHIP — file map, collision matrix, lane cut

Companion to `PRP.md`. **Parallel safety is a property of FILES, not of topics**
(CLAUDE.md §8). This document is the single authority on which lane may touch which
file. A lane that needs a file outside its declared set **stops and reports a
blocker** — it does not widen silently (PRP I5).

---

## 1. Why ownership is consolidated here — a first-class finding

Two independent triage agents each produced an internally collision-free batch
proposal. **Their proposals collide with each other**, and neither could see it,
because each could only see its own subset of issues.

Measured cross-agent collisions:

| File / glob | Claimed by | Claimed by | Consequence |
|---|---|---|---|
| `scripts/ci/check-env-sync.mjs` | **#3344** (agent A, batch A) | **#3956** (agent B, batch 3) | Two lanes editing the same guard |
| `.github/workflows/*.yml` (broad) | **#3458**, **#3344** (agent A) | **#3979** (agent B — claims ~84 of 123 workflow files, incl. `fiab-console-ci.yml`, `loom-guardrails.yml`) | Near-total workflow-tree overlap |
| `scripts/csa-loom/*.sh` (broad) | **#3458**, **#3637** (agent A) | agent B's grant-script claims | Overlapping shell-script sweeps |

Agent A flagged the risk in its own report: *"#3458 and #3344 both claim broad ranges
of `.github/workflows/*.yml` and `scripts/csa-loom/*.sh` — I could not enumerate
their exact line-level targets, so a real overlap between these two specifically is
possible but unconfirmed."*

**Conclusion, binding for this program:** batch proposals may be *drafted* by
per-issue triage, but **ownership is assigned centrally, here**. A per-agent batch
proposal is an input, never a schedule.

---

## 2. Broad-glob claimants — must be narrowed before scheduling

Four issues claim a glob rather than a file list. A glob claim is unschedulable: it
collides with everything by construction. Each must be narrowed to an enumerated
file list **before** its lane opens.

| Issue | Glob claimed | Narrowing action | Blocks |
|---|---|---|---|
| **#3458** | `scripts/csa-loom/*.sh` + `.github/workflows/*.yml` | Enumerate the actual `az role assignment create` call sites. See §5 C1 — the population is disputed (41 executed / 109 raw / 33 the guard can see). Produce the file list from the guard's own executed-site parse. | #3344, #3637, #3979 |
| **#3344** | `.github/workflows/*.yml` (17+ `env[?name==` sites) | `git grep -l "env\[?name=="` → 23 hits → enumerate to a file list | #3458, #3979, #3956 |
| **#3979** | ~84 of 123 workflow files | Narrow to the workflows that actually carry the defect, not the ones scanned | #3458, #3344 |
| **#3847** | `apps/fiab-console/tsconfig.json` + *"unsized sweep of every consumer the flag flags"* | The **bounding pass** (PRP §7): turn the flag on, capture the `tsc` error list, promote that file list to ownership, revert the flag | potentially all 112 `lane:console` issues |

**#3847 is the highest-leverage narrowing in the program.** Taken at face value it
blocks 112 of 243 issues. One `tsc` run converts it into a bounded file list.

---

## 3. Intra-batch collision matrix (measured)

Pairs that **must not** run concurrently. Sequence them in the order shown, or
combine into one PR.

| File | Issues | Resolution |
|---|---|---|
| `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` | **#4136** + **#3543** | Combine — both are S, same file, adjacent concerns (`KNOWN_CONTAINERS` dup at 2897/3048; raw input at ~744-745) |
| `content/evals/eval-floors.json` | **#3846** + **#3633** | Sequence: #3846 (code) first, #3633 is `NEEDS-ESTATE` → W4 anyway |
| `scripts/csa-loom/check-eval-regression.mjs` | **#3846** + **#3633** | Same as above |
| `scripts/csa-loom/eval-regression-lib.mjs` | **#3846** + **#3633** | **Third file, added 2026-08-31.** The metric-kind hardening lives here (`:100-227`), not in the checker. A declaration listing only the other two would be exceeded by the diff and rejected at review |
| `platform/fiab/bicep/main.bicep` | **#4036** + **#3327** | Sequence: #3327 is `NEEDS-ESTATE` (code already on main) → W4; #4036 proceeds in W3 |
| `platform/fiab/bicep/modules/admin-plane/main.bicep` | **#4036** + **#3327** | Same as above |
| `.github/workflows/deploy-fiab-commercial.yml` | **#4030** + **#3327** | Both are non-code residuals → W4 together |
| `.github/workflows/loom-guardrails.yml` | **#3941** + **#4046** | Sequence together in one W5 lane — #4046 adds a new guard + wiring, #3941 tightens `TOUCH_EXEMPT` |
| `scripts/ci/check-env-sync.mjs` | **#3344** + **#3956** | **Cross-agent collision.** Combine into one W5 lane — #3956's three defect classes all live in this one file |

**Explicit non-collision (recorded so it is not re-litigated): #3344 does not
write bicep.** Its checker *parses* `platform/fiab/bicep/**` but emits none —
reading is not a write collision, so #3344 does **not** contend with #4036 and
the bicep lane needs no sequencing against it. (Corrected 2026-08-31; propagated
from the `FILES.md` verification sweep, `OWED.md` §7.2.)

---

## 4. The five serializing generated artifacts

Committed generated files. Any two PRs touching the same one will conflict, and the
conflict cascades: one merge previously re-conflicted **seven** PRs and voided their
CI.

| Artifact | Generated by | Rule |
|---|---|---|
| `security-graph.json` | `scripts/ci/extract-security-graph.mjs` | Re-derive after every base update. Its drift check is **advisory** — it cannot block, so a stale one merges silently. Note: the extractor walks the **filesystem**, not the git index — a gitignored file makes the gate unsatisfiable locally (rc=0 here, RED in CI). |
| `docs/fiab/route-inventory.md` | route extractor | Re-derive; goes stale on every base update |
| `apps/fiab-console/deploy-templates/main.json` | bicep build | The **compiled ARM is a second artifact**. A re-render **drops out-of-band state** — diff it, never hand-edit |
| `apps/fiab-console/lib/api-routes.generated.d.ts` / `.json` | route codegen | Re-derive |
| `scripts/ci/no-freeform-inputs-baseline.json` | baseline generator | Re-derive |

**Protocol:** scripted re-derive loop across every open branch after any base update.
**Never hand-merge.** A hand-merged generated file matches no generator output and
passes its drift check by coincidence.

---

## 5. Disputed populations — resolve by one fresh measurement

Recorded rather than resolved by preference. The owning lane resolves each with a
single measurement at implementation time.

**C1 — #3458.** 41 executed sites / 17 files · 109 raw grep hits · 33 executed calls
the guard's own parser can see. Three populations, three methods. Direction is not
disputed: **zero** sites pass `--name`, and the guard judges **none**. Defining the
population is part of the fix.

**C4 — #4035 RESOLVED, #4064 still open.** The reporting agent disclosed that both
rested on memory rather than a fresh grep. **#4035 was re-measured at head 2026-08-31**
and is `REAL` — see `FILES.md` §5 and `OWED.md` Q2. It carries **three** regressions,
not the one recorded: contexts 15 → 3, `strict` back to `true`, and `enforce_admins`
on. Its path is `scripts/github/`, not `scripts/csa-loom/`. **#4064 remains
`PENDING-REVERIFY`** — re-measure before its lane opens.

**Every file list is now enumerated in `FILES.md`** — the companion register this
document's §8 requires. Two rows remain genuinely unpinned (#3540, #3518); every
other schedulable row carries a path verified to exist at head.

**#3513 is ~5× larger than its own text.** The issue cites 10 sites across 23 files.
Measured 2026-08-31: **119 `status:'remediation'` sites across 26 provisioner files,
zero Fix-it affordances anywhere in that tree.** Still sized L, but the size is now
measured rather than asserted. Ownership: `apps/fiab-console/lib/install/provisioners/**`
— exclusive; nothing else may touch that tree while #3513 runs.

**#3525** overlaps #3513's tree: 5 confirmed `status:'remediation'` sites at
`provisioners/kql-db.ts:81,105,131,147,173`. It is `NEEDS-ESTATE` → W4, so it does
not contend with #3513's W3 lane — but if it were pulled forward it would.

---

## 6. Lane cut by tree

Top-level ownership. Within a tree, sub-partition by file from triage.

| Lane | Tree | Open issues (approx) | Notes |
|---|---|---|---|
| **console-ui** | `apps/fiab-console/lib/editors/**`, `lib/components/**`, `lib/panes/**`, `app/**` (pages) | ~70 | Gated on the #3847 bounding pass. Sub-partition by editor file. |
| **console-provisioners** | `apps/fiab-console/lib/install/provisioners/**`, `provisioning-engine.ts` | ~20 | **#3513 takes this tree exclusively** while it runs. `provisioning-engine.ts` itself is **#3573's alone** — #3525 and #4183 edit provisioner bodies without re-registering, so neither contends |
| **vscode** | `apps/loom-vscode/**` | 1 | **#3684.** 97 files, disjoint from the console's 6283. Ungated — does **not** wait on the #3847 bounding pass |
| **console-api** | `apps/fiab-console/app/api/**` | ~22 | #4016, #4183, #4101(STALE), #3941 |
| **bicep** | `platform/fiab/bicep/**` | 30 | T3 rigor. #4036, #3327(W4) |
| **ci-guards** | `scripts/ci/**` | 37 | W5. Two-round stop rule applies |
| **workflows** | `.github/workflows/**` | ~25 | **Contended** — #3458/#3344/#3979 must narrow first (§2) |
| **scripts** | `scripts/csa-loom/**` | ~15 | **Contended** — #3458/#3637 |
| **dataplane** | Iceberg/Trino/Unity, `apps/` dataplane services | 21 | W1 (Iceberg is a live operator bug report) |
| **docs** | `docs/**`, `PRPs/**` | 3 | T0, free to run always |

**WIP ceiling: 4 concurrent implementing lanes.** Read-only lanes (triage, review)
are free.

---

## 7. Wave-by-wave lane schedule

### W0 — deploy paths + triage sweep (parallel, non-colliding)

| Lane | Owns | Issues |
|---|---|---|
| deploy-A | `.github/workflows/*deploy*`, `*roll*` | #3676, #3683, #3754, #4190, #4196, #3968, #3429 |
| deploy-B | Gov workflow files | #4072, #3449, #4071, #4073 |
| deploy-C | dataplane roll + ACR | #3346, #4064, #4144, #3882 |
| triage | **read-only** | the 158 `PENDING-TRIAGE` |

deploy-A/B/C partition the workflow tree by filename prefix — verify disjointness
against §2's glob claimants before opening.

### W1 — live operator bug reports

| Lane | Owns | Issues |
|---|---|---|
| iceberg | Iceberg/Trino catalog + credential vending | #3339, #3110, #3841, #3746 |
| estate-power | `estate-pause-resume` PRP tree + `scripts/measure/estate-*.mjs` | #3922 + the Gov-resume defect (OWED §1) |
| brain | Brain surfaces + nav | #4222, #3933, #3934, #3937 |
| cleanup | cleanup-engine surfaces | TBD from triage |

### W2 — console drain

Opens **after** the #3847 bounding pass. Sub-partitioned by editor/component file.

### W3 — bicep + provisioners

`#3513` exclusive on `provisioners/**`; bicep lane runs concurrently (disjoint trees).

### W4 — batched validation window

Not a code lane. Queue: #3327, #3633, #3736, #3525, #4030-rotation, plus the G1
receipts in `OWED.md` §3.

### W5 — guard strength

Two-round stop rule. Known lanes: `check-env-sync.mjs` (#3344 + #3956 combined),
`loom-guardrails.yml` (#3941 + #4046 sequenced), `check-role-assignment-determinism.mjs`
(#3458, after narrowing), `check-release-please-integrity.mjs` (#4038).

### W6 — unpark features

33 items, listed in `OWED.md` §4.

---

## 8. Ownership declaration format

Every lane declares ownership in its PR body before the first commit:

```
## Declared file ownership
- apps/fiab-console/lib/editors/foundry-sub-editors.tsx
- apps/fiab-console/lib/azure/adls-client.ts   (read-only — canonical source)

## Generated artifacts this branch must re-derive
- (none)   |   - security-graph.json, lib/api-routes.generated.d.ts

## Boundaries verified
- Commercial: <how>    - GCC/GCC-High/IL5: <how, or "not verified">
```

A PR whose diff exceeds its declaration is rejected at review — not amended silently.

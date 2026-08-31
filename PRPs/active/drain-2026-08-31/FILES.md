# FILES — per-issue file register

Companion to `OWNERSHIP.md`. That document assigns **trees** to lanes; this one
pins **files** to issues. `OWNERSHIP.md` §8 requires every lane to declare an
enumerated file list in its PR body *before the first commit* — a row with no file
list cannot be assigned, cannot be collision-checked, and therefore cannot be
scheduled. This is where that requirement is satisfied.

Recovered 2026-08-31 to close the gap recorded in `OWED.md` §7.1.

---

## 1. Confidence legend

A file list is only as good as how it was obtained. Each row carries its provenance
so a lane knows whether it may act on the list or must re-measure first.

| Level | Meaning |
|---|---|
| **`HEAD`** | I read the file this session. Path and line evidence both verified against the current tree. |
| **`PATH`** | Path verified to exist by `git ls-files` this session; the **line numbers** are agent-reported and not independently re-read. Schedulable; re-measure lines at implementation time. |
| **`GLOB`** | A glob, not a file list. **Unschedulable** — must be narrowed before its lane opens (`OWNERSHIP.md` §2). |
| **`UNPINNED`** | No file identified anywhere. Fresh measurement required. |

Per `DEV-LOOP.md` §10 box 1, a lane re-verifies its own rows at head before writing
code regardless of level. `PATH` means "schedulable", never "confirmed".

---

## 2. The register

### 2.1 Console — editors and components

| # | Files | Level |
|---|---|---|
| **#3515** | `apps/fiab-console/lib/editors/event-grid-topic-editor.tsx` (`:474-475`, `:532`) | `PATH` |
| **#4136** | `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` (`:2897`, `:3048`) | `PATH` |
| **#3543** | `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` (`~:744-745`) | `PATH` |
| **#3727** | `apps/fiab-console/lib/components/browse/all-items-explorer.tsx` (`:133`) | `PATH` |
| **#3748** | **root-cause file not pinned.** `apps/fiab-console/lib/panes/landing-zones-canvas.tsx` was read in full and **CLEARED** — it is not the cause | `UNPINNED` |
| **#3847** | `apps/fiab-console/tsconfig.json` + *"every consumer the flag flags"* | `GLOB` |
| **#3915** | corpus stage script + Dockerfile runner stage — **neither filename pinned** | `UNPINNED` |

**#4136 + #3543 share one file** — combine into one PR (`OWNERSHIP.md` §3).

### 2.2 Console — provisioners and API

| # | Files | Level |
|---|---|---|
| **#3573** | `apps/fiab-console/lib/install/provisioners/stream-analytics-job.ts` (**new**) · `lib/install/provisioning-engine.ts` (registry, imports `:25-43`) · `app/api/items/stream-analytics-job/[name]/route.ts` (`:29-32`) · `lib/azure/stream-analytics-client.ts` · `lib/editors/stream-analytics-editor.tsx` | `PATH` |
| **#3513** | `apps/fiab-console/lib/install/provisioners/**` — 119 sites / 26 files. **Takes the tree exclusively** | `PATH` |
| **#3525** | `apps/fiab-console/lib/install/provisioners/kql-db.ts` (`:81`, `:105`, `:131`, `:147`, `:173`) | `PATH` |
| **#4183** | `apps/fiab-console/lib/install/provisioners/mirrored-databricks.ts` (registered at engine `:36`) | `PATH` |
| **#4113** | `apps/fiab-console/lib/install/provisioners/_activator-receivers.ts` + `__tests__/activator-receiver-reachability.test.ts` — **attribution VERIFIED 2026-08-31** (`git ls-files`; receiver wiring lives here, which is why #4105's provision-time fix reaches no pre-existing action group). Fix shape per `auto-bind-by-default.md` §3: bindings self-heal on next touch — a backfill that re-binds existing groups in code, not a one-time script | `PINNED` |
| **#4016** | — | `UNPINNED` |
| **#4101** | `scripts/ci/check-route-guards.mjs` — **verdict CORRECTED 2026-08-31: not STALE.** The issue's own text says head is correct (mirrored-database POST deliberately omits `allowReadRoles`, verified at route.ts:94); the deliverable is a guard for the caller-picks-guard-scope idiom, which is the #3941 guard-strength class, and `check-route-guards.mjs` is its natural home | `PINNED` |

**`provisioning-engine.ts` is #3573's alone.** Checked explicitly: #3525 and #4183
modify existing provisioner *bodies* and do not re-register, so neither touches the
engine. This was a live collision risk and it is resolved.

### 2.3 VS Code extension — *not the console*

| # | Files | Level |
|---|---|---|
| **#3684** | `apps/loom-vscode/src/auth/device-code.ts` (read in full — the flow is real and complete) | `PATH` |

**This is a lane correction.** `LEDGER.md` assigns #3684 to lane `console-ui` / W2.
Its file is in `apps/loom-vscode/` (97 files), a different tree from
`apps/fiab-console/` (6283 files). It collides with **nothing** in the console, so it
does not belong inside W2's file partition and is not gated on the #3847 bounding
pass. It can run fully parallel to W2 in its own lane.

### 2.4 Bicep

| # | Files | Level |
|---|---|---|
| **#4036** | `platform/fiab/bicep/main.bicep` (`:1446`) · `modules/**/synapse.bicep` (`:43` → `:415`) · `modules/admin-plane/main.bicep` (`:5773`, `:6038`) | `PATH` |
| **#3327** | `platform/fiab/bicep/main.bicep` (`:1482`) · `modules/admin-plane/main.bicep` (`:1359`, `:1727`) · `.github/workflows/deploy-fiab-commercial.yml` | `PATH` |

**#4036 and #3327 share two bicep files at different lines.** #3327's code is already
on main and it is `NEEDS-ESTATE` → W4, so there is no contention *now*. Recorded
because when #3327's estate receipt drives follow-up work, that work must be
**sequenced against #4036's lane**, not run in parallel with it.

### 2.5 CI guards and scripts

| # | Files | Level |
|---|---|---|
| **#4035** | `scripts/github/configure-branch-protection.sh` (`:11-13`) | **`HEAD`** |
| **#4038** | `scripts/ci/check-release-please-integrity.mjs` (`:736` — claimed unconditional `exit 1` is **conditional**) | `PATH` |
| **#3956** | `scripts/ci/check-env-sync.mjs` | `PATH` |
| **#3344** | `scripts/ci/check-env-sync.mjs` · `scripts/csa-loom/resolve-msal-client-id.sh` · `scripts/csa-loom/openlineage-pool-setup.sh` · `.github/workflows/*.yml` (23 `env[?name==` hits) | `GLOB` (partial) |
| **#3846** | `content/evals/eval-floors.json` · `scripts/csa-loom/check-eval-regression.mjs` · `scripts/csa-loom/eval-regression-lib.mjs` | `PATH` |
| **#3633** | same three as #3846, **plus** the live Container App Job `loom-copilot-evaluator` | `PATH` |
| **#3637** | `scripts/csa-loom/bootstrap-msal-app-reg.sh` (flag-parse block `:126-130`; no `--rotate` / `--revoke`) | `PATH` |
| **#3941** | `.github/workflows/loom-guardrails.yml` (`TOUCH_EXEMPT`) | `PATH` |
| **#4046** | `.github/workflows/loom-guardrails.yml` | `PATH` |
| **#4030** | `.github/workflows/deploy-fiab-commercial.yml` | `PATH` |
| **#3458** | `scripts/ci/check-role-assignment-determinism.mjs` + `scripts/csa-loom/*.sh` + `.github/workflows/*.yml` | `GLOB` |
| **#3979** | ~84 of 123 workflow files | `GLOB` |

**The eval collision is three files wide, not two.** `OWNERSHIP.md` §3 lists
`eval-floors.json` and `check-eval-regression.mjs` for #3846 ∩ #3633; the third shared
file is `eval-regression-lib.mjs`, which is where the metric-kind hardening actually
lives (`:100-227`). The conclusion is unchanged — one PR — but the ownership
declaration needs the third path or the PR will exceed its declaration and be
rejected at review.

**#3344 does not write bicep.** It was a live risk that #3344 would collide with
#4036's bicep tree. Measured: `check-env-sync.mjs` *parses* bicep (146 references
inside the checker) but writes none of it. **Reading is not a write collision.** The
two may run in parallel.

### 2.6 Deploy paths, dataplane, estate

| # | Files | Level |
|---|---|---|
| **#3676**, **#3754**, **#4190**, **#4196**, **#3968**, **#3429** | `.github/workflows/*deploy*`, `*roll*` — per-issue filenames **not enumerated** | `GLOB` |
| **#3683**, **#4072**, **#3449**, **#4071**, **#4073** | Gov workflow files — per-issue filenames **not enumerated** | `GLOB` |
| **#3346**, **#4064**, **#4144**, **#3882** | dataplane roll + ACR — **not enumerated** | `GLOB` |
| **#3339**, **#3110**, **#3841**, **#3746** | Iceberg / Trino / credential vending — **not enumerated** | `UNPINNED` |
| **#3922** | `scripts/measure/estate-*.mjs` (+ the Gov-resume defect, `OWED.md` U5) | `PATH` |
| **#4222**, **#3933**, **#3934**, **#3937** | Brain surfaces + nav — **not enumerated** | `UNPINNED` |
| **#3736** | `NEEDS-ESTATE`; needs `ContainerAppConsoleLogs_CL`, not a file | n/a |

W0's three deploy lanes partition the workflow tree **by filename prefix**, which is
why they can open on globs where a console lane could not: the prefixes are disjoint
by construction. `OWNERSHIP.md` §7 still requires verifying that disjointness against
§2's glob claimants before opening.

---

## 3. Genuinely unpinned — the honest remainder

Fresh measurement required. This is **two issues**, not the five estimated in
`OWED.md` §7.1 before this recovery ran:

| # | Title | Why it needs measurement |
|---|---|---|
| **#3540** | Databricks Unity Catalog credential dialog requires typing Access Connector | No file identified in any triage lane |
| **#3518** | AI Foundry hub 'New connection' dialog requires typing an endpoint URL | No file identified in any triage lane |

Both are freeform-input defects, so `scripts/ci/no-freeform-inputs-baseline.json` is
the natural starting point — it is the generated baseline of hand-typed config sites
and should name the file for each.

**Not in this set, though `OWED.md` §7.1 counted them:**

- **#3543** — pinned above (`foundry-sub-editors.tsx ~744-745`).
- **#3525** — pinned above (`kql-db.ts:81,105,131,147,173`).
- **#3519** — `STALE` at head. Needs a **closure receipt**, not a file list.

---

## 4. Corrections this recovery produced

Building the register surfaced four errors in documents that were already written.
Recorded here rather than silently patched, because each changes a schedule.

| Correction | Was | Is | Consequence |
|---|---|---|---|
| **#4035's path** | `scripts/csa-loom/configure-branch-protection.sh` | `scripts/github/configure-branch-protection.sh` | The claimed path does not exist. A lane would have failed to find its own file. |
| **#4035's severity** | "declares 3 contexts that do not exist live" | **three** regressions, not one | See §5 — this is now `HEAD`-measured and larger than `OWED.md` Q2 describes |
| **#3684's lane** | `console-ui` / W2, gated on #3847 | `apps/loom-vscode/**`, own lane, **ungated** | Removes an item from W2's critical path |
| **Eval collision width** | 2 files (#3846 ∩ #3633) | **3** files (+ `eval-regression-lib.mjs`) | Ownership declaration must list all three |

---

## 5. #4035 re-measured at head — `PENDING-REVERIFY` resolved

`OWNERSHIP.md` §5 C4 flagged #4035 as resting on memory rather than a fresh grep. It
has now been read at head. The verdict is **REAL**, and the issue is understated.

`scripts/github/configure-branch-protection.sh` would `PUT` this over live protection:

```json
{
  "required_status_checks": { "strict": true, "contexts": ["validate", "test", "security-scan"] },
  "enforce_admins": true,
  "required_linear_history": true
}
```

Three separate regressions, each independently significant:

1. **Contexts 15 → 3.** Live protection carries 15 required contexts; this script
   declares `validate` / `test` / `security-scan`. A required context must exist on
   main before it can block, so these three would likely register as *nothing* —
   converting required checks into no-ops. Running this script **reduces** protection.
2. **`strict: true`.** This is the setting that is quadratic in open-PR count and
   previously starved the runners into **false reds across 12/12 PRs**. `strict:
   false` is a deliberate standing decision (`OWED.md` §8), and this script reverses
   it silently.
3. **`enforce_admins: true`.** This revokes the standing `--admin` merge
   authorization, which the drain's merge stage depends on (`DEV-LOOP.md` §1).

**Verdict:** `REAL`, size `S`, and `OWED.md` Q2's recommendation (A — regenerate from
live protection, add a drift guard) still holds. But the "cost of running it as-is"
is three regressions rather than one reduced context list, and it pairs naturally
with #4038, which is the same class: a mirror stuck at 14 while live carries 15.

---

## 6. Unadjudicated disagreements

Two triage lanes disagree on these. Recorded rather than resolved by preference —
neither affects batching, both are resolved by one measurement at implementation time.

| Item | Disagreement | Effect on scheduling |
|---|---|---|
| **#3515 size** | One lane found **3** ARM-id inputs (`:474-475`, `:532`); the freeform baseline records **10** hand-typed config sites in that file | None — same lane, same file. Governs whether "done" means zeroing the baseline entry or only the ARM-ID fields |
| **#3344 file set** | One lane named `csa-loom-post-deploy-bootstrap.yml`; another named `check-env-sync.mjs` + two `csa-loom` shell scripts | None — everything lands in the same batch either way |
| **#3637 scope** | One lane named **3** files; a later, better-evidenced lane named **1** (`bootstrap-msal-app-reg.sh:126-130`) | None — narrower is the safer declaration; widen only if the fix demands it |

Per `csa_loom_agreement_is_not_independence_shared_method`, note that the *narrower*
report being better-evidenced does not make it correct — it makes it better-evidenced.
Both remain agent-reported until a lane reads the file.

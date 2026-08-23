# PRP — FINISHLINE: drain everything, validated at every level (2026-08-06)

**Mission.** Execute every item in `AUDIT-2026-08-06.md` (same directory) to
DONE, where DONE is defined below — not merged, not "should work": working on
the live estate, at every level, documented, default-ON day one. Run as many
lanes in parallel as the dependency graph allows.

**Authority.** This PRP supersedes the open tails of OPEN-REGISTER-2026-07-12,
reconcile, and loom-apex (their residues are folded into the AUDIT). The
`.claude/rules/` die-hard rules all bind — especially `deploy-integrity.md`
(R1 broken deploy preempts everything; R2 merged ≠ done), `ux-baseline.md`
(G1 browser E2E, G2 zero day-one gates), `no-vaporware.md`,
`auto-bind-by-default.md`, `no-fabric-dependency.md`.

---

## 1. The PIV loop (Plan → Implement → Validate) — the only path to "done"

Every task cycles PIV until the Validate gate passes in FULL. A task that
fails any Validate level goes back to `doing` with the failure recorded. No
self-certification: the implementing session never writes its own `done`.

**P — Plan.** Read the task's AUDIT row + linked issues (NEWEST comments
override bodies). Establish current truth by measurement (grep/run/az/gh —
never from doc claims; this repo's plans go stale). Write the plan into the
task's `plan` field in `.harness/state.json` with the exact validation
commands that will prove each level.

**I — Implement.** Own git worktree per session/agent (`git worktree add`,
never `git stash`, never `pnpm install` at repo root). Real backends only.
Bicep-sync for any new infra/env/role (no-vaporware §Bicep sync). Guards for
any new invariant, each MUTATION-PROVED (break the subject → guard goes red →
restore; mutate the CONTROL, not the value).

**V — Validate. ALL SIX LEVELS, evidence attached to the task ledger:**

| Level | Bar | Evidence |
|---|---|---|
| V1 backend | Real Azure/OSS call succeeds (no mocks, no `return []` stubs) | curl/az/SQL receipt, first 300 chars |
| V2 middleware | BFF route validates session, returns structured `{ok,data,error}` + correct HTTP codes; authz unskippable | minted-session probe receipt |
| V3 frontend | In-browser E2E on the LIVE console — every touched control clicked, real data end-to-end, narrow-width + first-open passes (G1). DOM strings ≠ proof | loom-ui-verify run URL or Playwright receipt |
| V4 deployed | Change is LIVE on the estate and verified there (build-marker/az/live probe). CI green ≠ deployed (R2). Infra: what-if first, then green apply, then live resource check | run URL + live measurement |
| V5 docs | User docs + parity/prp docs updated in the SAME PR; wizard↔docs agree (R8) | file paths in PR |
| V6 day-one | Works by default on a fresh deploy: bicep emits the config, no new opt-in, no remediation MessageBar the platform could have resolved (G2, auto-bind) | env-check/gate-registry state + bicepparam diff |

Levels that genuinely don't apply (e.g. V3 for a CI-guard task) are marked
`n/a: <reason>` in the ledger — never silently skipped. A guard task's V4 is
"observed failing on a mutant + passing on main, in CI".

**Reviewer gate.** A separate reviewer pass (harness-reviewer) checks the
evidence — not the code style — and is REQUIRED to flip `review → done`.
Reviewer verifies evidence is real (links resolve, receipts match claims),
levels all present or justified n/a, and no die-hard rule violated. On any
gap: status back to `doing` with the gap named.

---

## 2. Parallel lanes

Tasks carry a `lane`. Lanes are file-disjoint by construction; agents in
different lanes run CONCURRENTLY, each in its own worktree. Inside a lane,
tasks run serially unless marked `parallel-ok`.

| Lane | Scope (AUDIT rows) | File territory | Wave 1 entry |
|---|---|---|---|
| **L-DEPLOY** | D1, D3-D8, D10-D13, D15, D17 | platform/fiab/bicep/**, .github/workflows/deploy-*+full-app-*, scripts/csa-loom, scripts/ci deploy guards, lib/gates+admin scoring, docs/deployment | D1 risingwave probe fix (smallest, unblocks readiness) |
| **L-UNITY** | D2, C5 | modules/compute/loom-unity-*, workflows job for unity, lib unity clients | D2 producer + unseal |
| **L-SUPPLY** | D9, D14, D16 | loom-uat image, package.json (vite/vitest), ACR mirror scripts, s3-gateway bicep | D9 CVE root-fix |
| **L-GOV** | G1-G5 | .github/workflows/gov-*, Gov bicep params | G1 #2643 dispatch (OPERATOR AUTH REQUIRED — see §4) |
| **L-EVALS** | E1-E4 | content/evals/**, copilot-quality-evals.yml, retrieval libs | E1 judge deployment |
| **L-PRODUCT-A** | C1, C8 (receipts/verification) | loom-ui-verify specs, e2e/**, parity docs | C1 Phase-E sweep design |
| **L-PRODUCT-B** | C2, C4, C5-tail, C7 (build work) | lib/editors, lib/copilot, app routes (SERIALIZE if same editor as another task) | C7 FGC-31 wizard |
| **L-PLATFORM** | C3 (Functions→ACA jobs), C10 | azure-functions/**, modules/compute jobs | C3 one function first, prove pattern |
| **L-TRUTH** | C9 (verify-then-close), P2 docs currency | PRP/parity docs, issue hygiene | C9 immediately (cheap wins) |
| **L-DEFERRED** | C11, C12 | (planning only until unblocked) | re-scope EH 2-4; write bridge-services/GEO sequencing |

**Cross-lane rules.** L-DEPLOY's D7 (safe inputs) lands BEFORE anyone
dispatches deploy-fiab full; the workflow stays disabled between attended
dispatches. Any lane needing an estate deploy queues it through L-DEPLOY
(one deploy at a time, what-if first, always `region=centralus
keep_resources=true allow_existing_hub=true`). Two lanes touching the same
file = the later one rebases and re-validates on the COMBINED tree.

**Merge protocol.** Small PRs per task; required checks green; `--admin` only
to drain strict-mode staleness, then WATCH main's next run (an --admin merge
makes main's CI the real gate). Never report a merge as a fix.

---

## 3. Wave sequencing (dependencies, not phases)

- **Wave 0 (immediate, parallel):** D1, D3, D9, E1, C9, D15 scoring fix,
  #3045 release merge. Everything else in Wave 0's lanes proceeds as entries
  free up.
- **Wave 1:** D2 (needs D1's deploy slot), D4-D6 (bundled brownfield-idempotency
  PR + one attended deploy proving all leaves clear), D11 bootstrap dispatch
  (after D1-D3), G2 Gov image lane first-runs (after D9 clears image path).
- **Wave 2:** D7+D8 then a GREEN unattended-safe deploy-fiab (closes #3038,
  re-enables schedules per #2775); G1 Gov dispatch (operator window); E2-E4;
  C1 sweep runs; C2/C4/C7 stream.
- **Wave 3:** D17 docs+acceptance runs (operator window for clean-sub);
  C3 migration completes; C5/C6/C10; P2 docs currency batch.
- **Exit:** §5 acceptance.

## 4. Operator-gated items (harness must SURFACE these, never fake them)

#2643 Gov dispatch window (3.5-4.5h); #2958 attended re-apply; clean-sub
acceptance runs (Commercial + Gov); D16 svc-postgres cost ruling; GOV-3 /
model-strategy §7 / TPM decisions; #2330 Gov SP UAA grant; PG quota; Esri
license; D6 visual captures; apex operator items 1-7. The harness writes these
to `.harness/state.json` as `status: "operator"` with exact commands/portal
steps, and lists them in every session summary until cleared.

## 5. Acceptance (program exit)

1. `deploy-fiab-commercial` green END-TO-END on the live estate, unattended-safe
   inputs, zero ARM leaf failures; `full-app-deploy-commercial` green incl.
   loom-uat; #3038/#3024 closed on those runs.
2. All 25+ container apps `Succeeded/Running` on current revisions incl.
   loom-risingwave + loom-unity; post-deploy bootstrap green.
3. `/admin/readiness` = 10/10 workloads, 0 blocked; `/admin/gates` = 0 blocked,
   opt-ins only where POLICY-ACCEPTED (trino AKS; postgres if operator so
   rules; NOT s3-gateway); `/admin/env-config` = honest 100% (D15 fixed —
   opt-in status exists, derived-unset not counted).
4. Gov: #2643 closed on live measurement; the 4 never-run workflows have green
   first runs; deploy-gov green; drift check produces verdicts.
5. Evals: judge resolves, all 10 surfaces pass floors (rbac included — fixed,
   not lowered), floors ratcheted from measured data.
6. loom-apex Phase E artifacts exist: ADVERSARIAL-REVIEW.md + re-grade ledger;
   zero-❌ parity docs for touched surfaces.
7. Docs currency batch merged; every AUDIT row's issue closed WITH live
   verification evidence, or explicitly parked in `status: "operator"`.

## 6. Estate facts (save the next session the discovery)

Commercial: sub `FedCiv ATU FFL - DMLZ`-adjacent (resolve via az at runtime,
never hardcode), RG `rg-csa-loom-admin-centralus`, region **centralus**, ACR
`acrloomk6mvh5sm6z7do` (data plane firewalled — use lease scripts), console
`https://csa-loom.limitlessdata.ai`, build marker at `/build-marker.txt`.
Purview account name is eastus2-suffixed but LIVES in the centralus RG.
Deploy identity = `limitlessdata_deploy` SP. Gov: NO local az ever — GitHub
Actions workflows only. deploy-fiab-commercial: keep DISABLED between
dispatches until D7 lands (#3022 nightly auto-upgrade).

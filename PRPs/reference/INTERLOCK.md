# Program interlock — shared files, owners, and the bicep slot

Written 2026-11-14 by the PRP audit. Every PRP in `PRPs/active` and `PRPs/backlog` links here instead of restating it.
Programs: **LHDS** (`active/loom-health-data-services`), **apigw** (`active/loom-api-gateway-plane`), **apim** (`active/apim-ai-gateway`),
**gov** (`backlog/governance-autopilot`), **spark** (`backlog/per-workspace-spark-identity`), **estate** (`backlog/estate-power-receipts`),
**brain** (`backlog/loom-brain`), **snow** (`backlog/snowflake-parity`), **ib** (`backlog/issue-batches`, 12 issue-batch PRPs).

The order in which PRPs run together and take the bicep slot is generated: [`GLOBAL-SCHEDULE.md`](GLOBAL-SCHEDULE.md)
(`python tools/prp/gen_plan.py`). A file that two PRPs need has one owner; the other PRP lists it under an
`Integration step (serialized)` and carries a `depends_on` edge or a `Cross-program order` line, which the generator reads.

## 1. The bicep slot (one at a time)

At most ONE PR that edits any file under `platform/fiab/bicep/**` is in flight across all programs. A PRP that is `touches_bicep: yes`
takes the slot when its first bicep commit is pushed and releases it when that PR merges (not when it deploys — deploy receipts do not
hold the slot). Claim the slot by commenting `bicep-slot: <PRP name>` on the tracking issue for the PRP and writing the PRP name into the
table below in the same PR. A PR that finds the slot held rebases its non-bicep work first and waits.

| Slot holder | PRP | Since | Released |
|---|---|---|---|
| feat/lhds-w1b-close-receipts | W01b-close-deploy-receipts | 2026-11-14 | 2026-11-15 (#5304 merged `cbd434703`; slot free, next per GLOBAL-SCHEDULE: apim WA) |
| feat/lhds-w1b-stamp-tls | W01b-close-deploy-receipts | 2026-11-15 | 2026-11-16 (#5322 merged `0edc18128`) |
| fix/lhds-tls-script-storage-rbac | W01b-close-deploy-receipts | 2026-11-16 | 2026-11-16 (#5326 merged `0afcbaca8`) |
| fix/4672-retire-dotnet6-vm-images | none (compliance hotfix #4672) | 2026-11-16 | |
| fix/lhds-5345-kv-issued-tls | W01b-close-deploy-receipts | 2026-11-17 | 2026-11-17 (#5355 merged `99da651a9`; slot free) |
| feat/lhds-w1b2-afd-issuer | W01b-close-deploy-receipts | 2026-11-21 | 2026-11-21 (#5413 merged `99e020124`) |
| fix/lhds-issuer-dedicated-waf | W01b-close-deploy-receipts | 2026-11-21 | 2026-11-21 (#5419 merged `1a8940553`) |
| feat/lhds-w2-2b-1-engine-delivery | W02a-fhir-core-build (W2-2b) | 2026-11-21 | released (W2-2b B1-B3 merged and deployed by 2026-11-23; row left open in error) |
| feat/lhds-fhir-edge-router | W01b-close-deploy-receipts | 2026-11-25 | 2026-11-25 (#5481 merged `261d3f3cd`; slot free) |
| fix/5483-runner-pat-expiry-tracking | none (follow-up of #5483) | 2026-11-25 | |

Rationale: `main.bicep`, `admin-plane/main.bicep`, `apim.bicep`, `health.bicep` (~279 KB) and the seven `params/*.bicepparam` files are
co-edited by five programs, and `main.json` has an ARM size ceiling (measure it with `git cat-file -s` at the ref; never quote a number).

## 2. Hot files and their owner per wave

A file is owned by exactly one PRP while that PRP is in flight. A second PRP that needs it waits or lands its change as a serialized
integration step after the owner merges.

| File / area | Programs that edit it | Rule |
|---|---|---|
| `platform/fiab/bicep/modules/admin-plane/apim.bicep` | apim (WA..WG), apigw (W2, W7) | apim WA then WB1 first (they gate apigw-W07); apigw W2 waits for the slot |
| `platform/fiab/bicep/main.bicep`, `modules/admin-plane/main.bicep`, `params/*.bicepparam` | apim, gov, LHDS, apigw, snow | bicep slot (section 1) |
| `platform/fiab/bicep/modules/health/{tenant,stamp,engines,ingress}.bicep` | LHDS W1b, W2, W3, W6, W8, W11 | LHDS waves already serialize; new engine files (`engines-*.bicep`) preferred over editing `engines.bicep` |
| `apps/fiab-console/lib/gates/registry/*.ts` | LHDS, apigw, gov, apim | one category file per program; new export line is the only shared edit |
| `apps/fiab-console/lib/copilot/health-tools.ts` | LHDS W2..W9 | one owner per wave (see LHDS `CONTRACT-FREEZE-W2.md`) |
| `apps/fiab-console/lib/copilot/copilot-orchestrator.ts`, `lib/items/item-crud.ts` | gov, apigw, snow | serialized integration step after each owner merges |
| `apps/fiab-console/lib/fabric-item-types.ts`, `lib/item-types/types.ts` | snow, gov, apigw, LHDS | single owner decided in snowflake W0 arbitration (RECOMMENDED, not ratified) |
| `apps/loom-health-cp/src/{jobs,relay}/` | LHDS W2, W3, W6, W10 | one wave at a time |
| `.github/workflows/build-fiab-images-acr-tasks.yml` (matrix rows) | LHDS, apigw, apim | additive rows; rebase before merge |
| `tools/drain/policy.json`, root and app lockfiles | all | regenerate after merge, never hand-merge |

## 3. Cross-program ordering facts

- apim WA + WB1 gate apigw-W07 (model pools). Run them before apigw-W07 is started.
- LHDS W01b (deploy + receipts) gates every other LHDS wave from producing a Done receipt.
- Snowflake W0 (arbitration, a decision record) gates snowflake W1 and every later snowflake wave.
- Governance W2..W4 and brain ownership (#4255) are independent of the above and may run beside them if no bicep is needed.

## 4. Operator-held items (not solvable by an agent)

`CI_RUNNER_AUDIT_TOKEN` (#4727), release-please 403 on tag/release, GHSA publish approval, Gov device-code / interactive sign-in, runner
image roll, any Gov or GCC-High deploy dispatch that needs an approval or lifts a stand-down, **LHDS W13 full-scale spend approval
(NOT approved 2026-11-14)**. A PRP blocked on one of these says so in `blocked_by` and in its first Steps line.

## 5. Per-cloud honesty

Commercial and GCC-High carry deploy receipts; **GCC is supported-in-code and never exercised**; IL5 has no successful run
(`cloud-parity.md`). Any PRP validation that names a boundary must say which of these states it proves.

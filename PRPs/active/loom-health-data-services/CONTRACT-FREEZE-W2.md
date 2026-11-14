# LHDS contract freeze for waves 2-6 (reference doc, not a PRP)

Purpose: W02a/W02b, W03a/W03b, W04, W05 and W06 run in parallel lanes. They collide
only at the points below. Each point has ONE owner and a fixed merge order. A PRP that
needs a change to a frozen contract stops and files an issue; it does not edit the contract.
Facts here were read from `origin/main` ea1a38d72 (2026-11-14); anything unread is marked UNVERIFIED.

## 1. PDP decision API (frozen; owner W1-5, already merged, not deployed)

Source of truth: `apps/loom-health-pdp/README.md` (section "Decision API") and
`apps/loom-health-pdp/input-contract.json`. Not restated here.

- Call: `POST /v1/data/lhds/authz/decision` on the in-cluster OPA; body `{input:{access_token, request}}`.
- Reply: `result.{allow, reason, policy_version, obligations}`. `obligations` is `[]` in bundle v1.
- Interceptor rules (W2-3, W3-3, any later engine): only `result.allow == true` permits; a missing `result`,
  timeout, 5xx or connection error is deny and the engine answers 503; `request.tenant` comes from the route.
- Fields marked PROVISIONAL in `input-contract.json` (`patient_compartment`, `categories`) are CONFIRMED or
  CHANGED only by W2-3 (the first interceptor). W2-3 edits `input-contract.json` and the Rego in the SAME PR
  (it is the one permitted contract edit, because the contract names W2-3 as the confirming owner). W3-3 may be
  built against the PROVISIONAL fields in parallel (no `depends_on` edge between W03a and W02a), but it MERGES after
  W2-3 and rebases onto any change W2-3 makes. > ASSUMPTION: merge-order, not a hard edge, is wanted; the alternative
  is W3-3 confirming the DICOM-side fields and W2-3 the FHIR-side in separate PRs.
- Obligations are NOT used by W2/W3. Response filtering is done by the engine from the allow decision plus the
  token scopes. Adding a non-empty `obligations` shape is a W8 change (consent, ADR-011).

## 2. Outbox event schema (frozen; owner W2-4, in W02b)

Source: `adr/ADR-007-async-write-path-outbox.md` (Decision). Row: `(seq bigserial, tenant, kind fhir|dicom,
resourceType, id, versionId, op, occurredAt, hash)`; NO payload. Event Hubs message = the row, `seq` is the
idempotency key; one hub per tenant. Consumers upsert on `(tenant, kind, id, versionId)` and alert on a `seq` gap > 60 s.

- W2-4 owns the table DDL, the relay worker (`apps/loom-health-cp/src/relay/**`) and the FHIR change-feed endpoint.
- W3-4 (DICOM, W03b) adds ONLY `apps/loom-health-cp/src/relay/dicom-*.ts` and DICOM producers; it reuses the relay
  worker and the same row shape with `kind=dicom`. For DICOM, `resourceType` carries the DICOM level
  (`study|series|instance`) and `id` the UID. > ASSUMPTION: the ADR does not define the DICOM mapping; this is the proposal.
- W6 (bulk export, sink) and W7 consume the stream; they must not add columns. A column change is an ADR-007 amendment,
  its own PR, before any consumer wave merges.
- That is why W03b depends on W02b: W3-4 has a real code edge on the W2-4 relay. W3-5..W3-8 do not; they are held
  only because they live in the same PRP. Run W2-4 first inside W02b so W03b is released early.

## 3. Registration points (hot files) and merge order

One owner per file per merge window; the others append exactly one block after the owner has merged.

| File | Collision | Order |
|---|---|---|
| `apps/fiab-console/lib/copilot/health-tools.ts` (does NOT exist yet) | W2-7, W3-6, W4-4 each add tools | Created by W2-7 (W02b). Then W3-6, then W4-4, then W6. Each PR adds its tool(s) in a block named by service; no reformatting of earlier blocks |
| `apps/fiab-console/lib/gates/registry/health.ts` (`HEALTH_GATE_META`; ids today: `health-control-plane`, `health-stamp-capacity`, `health-gov-image-gate`, `health-auth-graph-consent`, `health-lakehouse-isolation`) | W2-6 (reindex gate), W4-3 (`health-terminology-licensed`), W01b (Fix-it fixes) | W01b first, then W2-6, then W4-3. Gate ids are `health-<service>-<reason>`; the Fix-it launcher is registered in the same PR as the entry |
| `apps/fiab-console/lib/catalog/item-types/health.ts` | one item type per wave (`health-fhir-service`, `health-dicom-service`, `health-terminology`, `health-conversion-pipeline`) | W2-7, W3-6, W4-4, W5-3; append-only |
| `.github/workflows/build-fiab-images-acr-tasks.yml` (`DEFAULT_APPS` is ONE long JSON line, merge-hostile) | W2-5 (scrubber row), W3-1 (dicom rows), W4-2, W5-1 | W2-5, then W3-1, then W4-2, then W5-1. Add the matrix row as the LAST commit of the item and rebase immediately before merge |
| `platform/fiab/bicep/health.bicep` + `modules/health/engines.bicep` | W2-2 (HAPI workload), W4-2, W5-1 | ONE bicep PR in flight (INTERLOCK). W4-2 and W5-1 add their workload as a NEW module file (`engines-terminology.bicep`, `engines-converter.bicep`) so only the single `module` line in `health.bicep` is shared. > ASSUMPTION: new files instead of editing `engines.bicep`, to avoid the collision |
| `platform/fiab/bicep/modules/health/tenant.bicep` | W3-2 only (DICOM storage block) | W3-2 after W1-2 (merged) |
| `apps/loom-health-cp/src/jobs/*` | W2-2 (`fhir-tenant-*`), W2-6 (`reindex-*`), W3-2/W3-5 (`dicom-*`), W4-3, W5-2 | new files per item; `builtin.ts` / `compose.ts` are edited ONLY to register a handler (one line each) |
| `params/*.bicepparam`, `health-params/*-health.bicepparam` | any env/param addition | W01b owns the three missing control-plane values; later PRPs add rows, never reorder |

## 4. Editor, provisioner, BFF and parity-doc registration (per item type)

Each item type registers in four places and no others: catalog entry (`lib/catalog/item-types/health.ts`), provisioner
(`lib/install/provisioners/health-<type>.ts`), editor (`lib/editors/health/<type>-editor.tsx`), BFF route
(`app/api/health/[tenant]/<surface>/**`), plus `docs/fiab/parity/health-<type>.md`. The exemplar is `health-tenant`
(`lib/editors/health/health-tenant.ts`, `lib/install/provisioners/health-tenant.ts`, `healthTenantAutoBindOnCreate` in
`lib/azure/auto-bind.ts`). Every provisioner follows `auto-bind-by-default.md`: create provisions and binds, names match,
readback self-heals, the editor never opens on a bind form. `LOOM_HEALTH_*` env rows go in `admin-plane/main.bicep` and
`scripts/ci/check-env-sync.mjs` must stay green (serialized with the bicep rule above).

## 5. Control-plane jobs and relay

Job kinds are registered through `builtinHandlers` / `tenantHandlers` in `apps/loom-health-cp/src/jobs/`; kinds are
`<noun>.<verb>` (existing: `tenant.create`, `tenant.destroy`). New kinds go in new files. The relay worker lives in
`apps/loom-health-cp/src/relay/` (new in W2-4); nothing else writes there except the `dicom-*.ts` files in W3-4.

## 6. Verification state that waves must not over-claim

W01 is merged, not deployed: the Commercial control plane revision is deactivated and no health route, auth, FHIR or
DICOM behaviour has been exercised (see `W01b-close-deploy-receipts.md`). Any wave 2-6 acceptance that needs a live
stamp is blocked on W01b's receipt; code and unit work may proceed.

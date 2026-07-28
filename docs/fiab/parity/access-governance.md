# access-governance — parity with Microsoft Entra ID Governance (Access Reviews + group sync)

Source UI: Entra ID Governance — Access Reviews, Entitlement Management group
assignment, Lifecycle Workflows (leaver). Benchmarked per
`PRPs/active/access-governance/PRP.md` (b).

Azure-native default: Loom-native (Cosmos `access-reviews` + the W1 entitlement
ledger) + read-only Microsoft Graph for group membership. **No Fabric / Power BI
dependency.** Entra/Graph is Azure, allowed per `no-fabric-dependency.md`.

## Feature inventory → Loom coverage (W4)

| Entra ID Governance capability | Loom coverage | Backend |
|---|---|---|
| Access review campaign (scope: package / resource / principal / group / all) | ✅ `/admin/access-reviews` builder wizard (pickers, no JSON) | `POST /api/access-governance/reviews` → snapshots ledger grants into `access-reviews` |
| Reviewer decides attest / revoke per item | ✅ Reviewer inbox, per-item checkbox | `POST /api/access-governance/reviews/[id]/decision` |
| **Bulk** approve/deny in a review | ✅ Attest/Revoke selected + "all remaining" | same route (`itemIds[]` / `all:true`) |
| Reviewer delegation | ✅ Delegate dialog (IdentityPicker) | `PATCH …/reviews/[id] {action:'delegate'}` |
| Auto-revoke on no-response | ✅ `autoRevokeOnExpiry` → close auto-revokes undecided | `closeCampaign` → real `revokeAssignment` |
| Recurring reviews (cadence) | ✅ cadence picker (30/60/90/180/365) + due-date | `nextDueDate`; review sweep closes past-deadline |
| Scheduled close of overdue campaigns | ✅ timer (hourly) + admin "Run review sweep" | `POST …/reviews/sweep` (system token) + sweeper Function |
| **Signed evidence / audit record of a completed review** | ✅ every close seals an append-only, SHA-256 hash-chained record (campaign metadata + every decision + the resulting revocations), verified + downloadable as JSON or a readable summary from the campaign's "Evidence pack" dialog | `closeCampaign` → `sealCampaignEvidence` → Cosmos `access-review-evidence` (PK /tenantId) + `emitAuditEvent` (SIEM + webhooks); read via `GET …/reviews/[id]/evidence[?scope=tenant][&download=json\|txt]` |
| Group-based assignment (package group target) | ✅ `groupTargets[]` on a package | `access-packages` sanitizer |
| Group membership → grant/revoke reconcile | ⚠️ opt-in `graph-group-sync` gate (Graph read-only) | `POST …/group-sync` → `enforceAccessGrant`/`revokeAssignment` + sweeper timer |
| Request access from a 403 / access-gate | ✅ shared `RequestAccessInline` (qualifying packages) | `GET /api/access-packages?resourceRef=` → `POST …/[id]/request` |
| Bulk approve/deny in request inboxes | ✅ | `POST /api/access-requests/bulk-decision` (reuses F16 decision) |
| Leaver revoke-all | ✅ admin "Leaver revoke-all" | `POST /api/access-governance/revoke-all` |
| Request-on-behalf-of | ✅ admin `onBehalfOf` on package request | `POST …/[id]/request` |

Honest gate (the sole day-one gate, per PRP non-goals): **`graph-group-sync`** —
`LOOM_GRAPH_GROUP_SYNC_ENABLED=true` + Graph `Group.Read.All` +
`GroupMember.Read.All`. Registered in `lib/gates/registry.ts` and surfaced on
`/admin/gates`. Absent it, group-targeted packages are still requestable directly;
only the automatic membership reconcile is gated. Everything else is day-one-ON.

Zero ❌. Real backends throughout (no mock arrays). Owed: live minted-session
browser E2E receipt (no browser available this session).

## Signed evidence record (loom-apex B-N19c′)

Entra ID Governance keeps a review's decision history for audit; Loom's
Azure-native equivalent goes one step further and makes the history *provable*.
When a campaign closes (admin action **or** the deadline sweep), `closeCampaign`
persists the closed campaign first, then seals an immutable record into the
tenant's chain:

* **Contents** — campaign metadata (scope, reviewers, delegates, cadence,
  deadline, auto-revoke setting, opened/closed by+at), every decision (reviewer,
  subject, entitlement, verdict, timestamp, note), and every resulting revocation
  (`reviewer` vs `auto-close` reason), plus rollup totals and any close warnings.
* **Signature** — SHA-256 over a canonical JSON encoding of the record (sorted
  keys, `contentHash` and Cosmos system fields excluded). The body embeds
  `prevHash`, the previous record's `contentHash` for the same tenant, so editing
  any historical decision both breaks that record's own hash AND orphans every
  later record. Genesis is 64 zeroes.
* **Storage** — append-only Cosmos container `access-review-evidence`
  (PK `/tenantId`, ARM-provisioned in `landing-zone/cosmos.bicep` with the
  `createIfNotExists` fallback). Nothing in Loom replaces or deletes a row.
* **Fan-out** — `emitAuditEvent({ action: 'access-review.evidence-sealed' })`
  reaches the SIEM Logs-Ingestion stream and any subscribed outbound webhook;
  a Cosmos `review-evidence-sealed` audit-trail row lands for `/admin/audit-logs`.
* **Surface** — the campaign inbox's **Evidence pack** button verifies the chain
  live (VERIFIED / per-record tamper issue), lists each record's hashes, renders
  the auditor summary, and downloads the pack as JSON or `.txt`.
  `?scope=tenant` proves continuity across the whole tenant chain.
* **Failure policy** — sealing never fails a close (the revokes already ran); a
  failed seal returns as a warning on the close response.

Verify independently: canonicalise a record (sorted keys, drop `contentHash` and
`_rid`/`_self`/`_etag`/`_attachments`/`_ts`), SHA-256 it, compare to
`contentHash`; then confirm each `prevHash` equals the previous record's
`contentHash`. `lib/access/__tests__/evidence-record.test.ts` asserts continuity,
tamper detection (including the re-seal attempt), and close-path emission.

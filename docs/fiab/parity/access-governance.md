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

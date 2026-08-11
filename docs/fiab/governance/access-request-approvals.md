# Access-request approvals (F16)

How a request for access to a data asset reaches an approver, who is allowed to
action it, and — for an estate that predates 2026-08-08 — the one-time migration
that makes existing requests visible again.

## The flow

1. A user asks for access to a catalog asset (**Governance → Data catalog →
   Request access**), or requests an **access package**
   (**Governance → Access packages**).
2. Loom writes an `access-request` document to the `access-request-workflow`
   Cosmos container, opened at the first stage of the governing approval policy
   (by default **manager**).
3. Approvers advance it through **manager → privacy → approver → access
   provider** in **Governance → Access requests**.
4. The final approval provisions a **real Azure RBAC grant** on the backing
   store (ADLS container, Synapse SQL, ADX database, or a Loom workspace role)
   and notifies the requester. No Microsoft Fabric dependency.

## Who may approve

Reading the tenant inbox and actioning a request are governed by
`lib/access/approval-authority.ts`, enforced structurally by the
`withApprovalAuthority` route-toolkit wrapper.

**May review** — see the tenant's requests, and be considered for acting on
them. Any one of:

| Route to authority | How it is granted |
| --- | --- |
| Tenant admin | Membership of `LOOM_TENANT_ADMIN_GROUP_ID` (produced by the deploy), or `LOOM_TENANT_ADMIN_OID` for the single-operator bootstrap. |
| `governance.access-approvals` capability, Contributor or higher | A tenant admin grants it to a user or group at **/admin/permissions**. This is how you delegate approvals to a governance team without making them tenant admins. |
| Named approver on an enabled approval policy | A tenant admin names the user (or a group they belong to) on a stage at **Governance → Approval policies**. Named approvers reach their own queue without needing the capability grant. |

**May act** on a specific request — all of the above, **and**:

- The caller is **not** the requester. Separation of duties is absolute and
  applies to tenant admins too: nobody approves or denies their own request.
- `actorMayApprove` passes for that request's current stage — i.e. when the
  governing policy sets `enforceApprovers`, the caller is one of that stage's
  named approvers.

Anyone else receives a **403** naming the reason and the remediation. The inbox
renders that as a gate with a **Fix it** button, never as an empty list.

!!! note "An unreadable count is shown as `?`, not `0`"
    If a tier's count cannot be read, the tab badge shows `?`. A failed read
    displayed as `0` would tell an approver nothing is waiting for them, which
    is the most misleading thing this surface could say.

## Per-cloud status

Commercial and Azure Government behave identically. The workflow is Cosmos plus
Azure RBAC only, with no dependency on any service that differs between
boundaries. The `governance.access-approvals` capability, the approval policies
and the migration below all apply unchanged in both.

## Migration — estates created before 2026-08-08

### What was wrong

`access-request-workflow` is partitioned by `/tenantId`. Until 2026-08-08 the
creating routes stamped that field with the **requester's** Entra object id,
while the inbox query and the decision route read it using the **signed-in**
user's object id.

Those are different people, so they resolve to different partitions. The
observable effect on an affected estate:

- an approver's inbox returned **zero rows**, at every tier;
- a decision POST returned **404** before any approver logic ran;
- consequently the only person who could action a request was the person who
  filed it — a self-approval, which is now explicitly blocked.

The routes now use `tenantScopeId(session)` (`claims.tid || claims.oid`, the
Entra tenant) — the helper that already exists precisely so state written by one
user resolves for any grantee in the same tenant.

### Why a migration is needed

**Cosmos partition keys are immutable.** The fix governs documents written from
now on. Requests filed before it still sit in per-requester partitions and stay
invisible to the inbox until they are physically rewritten under the new key.
They are not corrupt — they are unreachable.

### Running it

Tenant admin, from a browser session on the console (dry run first — that is the
default, and it writes nothing):

```bash
# 1. Dry run. Read `scanned`, `needingMigration`, and the `plan` array.
curl -sS -X POST https://<console-host>/api/access-governance/repartition \
  -H 'content-type: application/json' -b "$COOKIE" -d '{}'

# 2. Apply. Require ok:true AND residual:0 in the response.
curl -sS -X POST https://<console-host>/api/access-governance/repartition \
  -H 'content-type: application/json' -b "$COOKIE" -d '{"confirm":true}'

# 3. Only once step 2 reports residual:0 — seed the entitlement ledger.
curl -sS -X POST https://<console-host>/api/access-governance/backfill \
  -b "$COOKIE"
```

**Order matters.** The backfill sweeps completed requests cross-partition so it
reads both layouts, but running it before the repartition finishes would seed
the who-has-access report from requests the inbox still cannot show.

### What it guarantees

| Property | Behaviour |
| --- | --- |
| Idempotent | The unit of work is "documents whose `tenantId` is not the tenant". A second run finds none and moves nothing. |
| Resume-safe | A run interrupted between the write and the delete leaves the document in both partitions. The next run sees the target copy, skips the write and completes the delete. Convergent from any partial state. |
| Fail-closed | Every document lands in `moved`, `alreadyMigrated` or `failed`, and `failed` is itemised with its error. Any failure makes the whole run `ok:false` and the message says `INCOMPLETE`. Nothing is silently skipped. |
| Honest counts | `scanned` is reported separately from `needingMigration`, so an empty container can never be mistaken for a fully-migrated one. |
| Verified | After moving, an independent re-scan reports `residual`; the run is only `ok` when that is 0. The result is not inferred from the write loop's own counters. |
| Reversible | Each moved document carries `_repartition.previousTenantId` recording the partition it came from, so a move is auditable and can be undone. |
| Refuses rather than guesses | With no Entra `tid` claim on the session the destination cannot be determined, so the endpoint refuses with HTTP 409 and moves nothing — a refusal, not a completed no-op. |

Every apply run writes an audit-log entry, including a failed one.

### Do I need it?

Run the dry run. If `scanned` is 0 the container is empty and there is nothing
to do. If `scanned` is greater than 0 and `needingMigration` is 0, the estate is
already correct. If `needingMigration` is greater than 0, those requests are
currently invisible to their approvers and the migration will restore them.

## Related

- `docs/fiab/governance/workspace-rbac.md` — workspace-level roles.
- `.claude/rules/deploy-integrity.md` — R6 (self-diagnosing failures, retries,
  concrete remediation) and R7 (error messages must be true), which the
  migration's reporting is written against.

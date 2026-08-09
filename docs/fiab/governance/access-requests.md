# Access requests — the multi-tier approval inbox

> **Surface:** `/governance/access-requests`
> **Editor:** `apps/fiab-console/lib/editors/access-request-inbox.tsx`
> **BFF:** `apps/fiab-console/app/api/access-requests/{route.ts,[id]/decision,bulk-decision}`
> **Store:** Cosmos `access-request-workflow` (PK `/tenantId`)
> **Clouds:** Commercial and Azure Government — identical code path; the grant is
> plain ARM / data-plane RBAC, which exists in every boundary.

When someone asks for access to a catalog data asset, the request lands in this
inbox and advances through an ordered chain of approval tiers. The **final**
approval is not a status flip: it provisions a **real Azure RBAC grant** on the
backing store and records the resulting role-assignment id on the request.

There is no Microsoft Fabric dependency — the grant is an Azure Storage /
Synapse SQL / ADX assignment (`no-fabric-dependency.md`).

!!! info "Cross-user approval — fixed in code; the back-fill of OLD requests is a separate, manual step"
    The partition-key defect that made an approver's inbox come back **empty**
    and a decision call return **404** is corrected: every route on this
    container now scopes to the Entra **tenant** via `tenantScopeId(session)`.
    See [The cross-user partition defect](#the-cross-user-partition-defect-fixed-2026-08-08).

    Two caveats before you read the walkthrough as live behaviour:

    - **Requests filed BEFORE the fix stay invisible until they are migrated.**
      Cosmos partition keys are immutable, so the code fix only governs new
      documents. The one-time repartition is documented in
      [Access-request approvals](access-request-approvals.md#migration-estates-created-before-2026-08-08),
      and it has **never been executed against a real Cosmos container**.
    - **Per `deploy-integrity.md` R2, a merge is not a deploy.** Check the live
      build SHA on `/admin/readiness` before assuming this estate carries it.

## How a request gets here

A user browses **Governance → Data catalog**, opens an asset, and chooses
**Request access**. That posts to `POST /api/catalog/request-access`, which
writes three real records:

1. an audit-log entry on the asset (visible in the item's activity),
2. a confirmation notification to the requester,
3. an access-request document opened at the **Manager** tier.

The requested permission is one of `read`, `write`, or `admin`, and the request
carries the requester's justification text.

## The approval chain

Four tiers, in order. The tab strip on the page **is** the tier selector, and
each tab's badge counts the requests awaiting that tier.

| # | Tier | Doc field written on decision |
|---|---|---|
| 1 | Manager | `managerApproval` |
| 2 | Privacy reviewer | `privacyApproval` |
| 3 | Approver | `approverApproval` |
| 4 | Access provider | `accessProviderApproval` |

Approving advances the request to the next tier. **Denying at any tier closes
it immediately** with the recorded reason, the denying tier, and a timestamp —
a reason is mandatory, and a denial without one is rejected with HTTP 400.

Each tab lists only the requests currently sitting at that tier
(`GET /api/access-requests?tier=<tier>&status=open`). A **Completed / Denied**
history view shows closed requests with their receipt.

### Where an access package changes the chain

A request raised against an **access package** carries an immutable
`approvalPlan` snapshot. When that snapshot is present the workflow advances
over the plan's stages — an ordered *subset* of the four tiers — instead of the
full sequence. Requests without a plan use all four tiers, so behaviour is
unchanged by default.

Packages can also name specific approvers. When they do, an actor who is not a
named approver for the current stage gets HTTP 403; tenant admins always pass.

## What the final approval actually does

The **Access provider** tier is where real infrastructure changes. Before
granting, the access provider may confirm or override the grant scope —
`scopeType` and `scopeRef` — which is the point at which a logical asset is
bound to a concrete container or database. Scope overrides are honoured **only**
at this final tier.

Loom infers the initial scope from the asset's item type:

| Item type | Inferred scope | Backing grant |
|---|---|---|
| `warehouse`, `mirrored-warehouse` | `warehouse` | Synapse SQL |
| `kql-database`, `eventhouse`, `kusto-database` | `kql-database` | ADX |
| `lakehouse`, `materialized-lake-view`, `mirrored-database`, `mirrored-databricks`, `lakehouse-shortcut` | `adls-container` | ADLS Gen2 container RBAC |
| everything else (data products, reports, semantic models, APIs, apps) | `item` | Loom-native workspace role |

That last row matters: logical assets with no physical store get a real
workspace-role grant. They are deliberately **not** defaulted to
`adls-container` — doing so previously sent data-product grants into an empty
container reference and failed with a 502 at the final tier.

On approval the route calls `enforceAccessGrant(...)` and branches on the
result — it never reports success it did not observe:

| Grant result | What happens |
|---|---|
| `active` | Request marked **completed**, `subscribedAt` set, the real ARM `roleAssignmentId` stored on the request, an entitlement-ledger row written, and the requester notified that access is provisioned. |
| `pending` | The request **stays** at the Access provider tier, the recorded step is rolled back, and the honest infra/config gate is surfaced. Nothing is marked complete. |
| `error` | The request **stays** at the tier and the call returns **502** with the grant error, so the access provider can fix the scope and retry. |

Every decision — approve or deny, at any tier — writes an audit-log entry keyed
to the request id, naming the actor, the tier, the reason, and (on completion)
the granted role and its assignment id.

### Time-bound and activation-required grants

When the governing package sets a grant lifetime, the completed grant carries an
expiry rather than being permanent.

When the package sets **activation required**, the final approval does *not*
grant RBAC. It records an **eligible** assignment and notifies the requester to
activate it from the Access report for a bounded window — the PIM-style path.

## Bulk decisions

Selecting rows reveals a bulk action bar that posts to
`POST /api/access-requests/bulk-decision`. This is not a shortcut around the
checks: the route applies each decision by **reusing the same per-request
handler**, so every leg runs the identical approver check, RBAC grant, ledger
write, notification, and audit entry. A leg the caller may not approve comes
back as a 403 in the per-id `results` array — never as a silent success. The
response reports `total`, `succeeded`, and `failed`.

## The cross-user partition defect (fixed 2026-08-08)

Recorded because the shape of it is worth keeping, not because it is still live.

Three routes disagreed with each other about what the `tenantId` partition key
holds. Until 2026-08-08:

| Route | Value written / read |
|---|---|
| `POST /api/catalog/request-access` | wrote `tenantId: s.claims.oid` — the **requester's** object id |
| `POST /api/access-packages/[id]/request` | wrote `tenantId: requesterId` — the **requester's** object id |
| `GET /api/access-requests` | queried `WHERE c.tenantId = @t`, `@t = s.claims.oid` — the **approver's** object id |
| `POST /api/access-requests/[id]/decision` | read `c.item(id, s.claims.oid)` — the **approver's** object id |

`oid` is the Entra **user** object id, not the tenant id. So unless the approver
and the requester were the same person, the inbox query matched zero rows and the
decision read 404'd before any approver logic ran.

The platform already had the correct helper for exactly this case.
`tenantScopeId(session)` in `apps/fiab-console/lib/auth/session.ts` returns
`claims.tid || claims.oid` — the Entra **tenant** id — and its doc comment states
it exists so that state written by one user "resolves for any grantee in the
**same tenant**". All four routes now use it.

**Widening the partition removed an accidental authorization boundary.** The
per-requester partition was the only thing confining a caller to their own rows,
and `actorMayApprove` returns `allowed: true` whenever the governing plan does
not enforce named approvers — which is the default plan. So the fix ships with
the real boundary that has to replace the accident: `withApprovalAuthority`
(a route-toolkit wrapper, not a droppable `if (gate) return gate;` line) plus
separation of duties, so a requester can never action their own request. See
[Who may approve](access-request-approvals.md#who-may-approve).

**Old documents are not fixed by the code change.** Cosmos partition keys are
immutable; requests filed before the fix remain in per-requester partitions and
stay invisible to the inbox until physically rewritten. The one-time repartition
endpoint and its guarantees are in
[Access-request approvals](access-request-approvals.md#migration-estates-created-before-2026-08-08).
It has **never been run against a real Cosmos container** — its properties are
proven only against an in-memory partition-honest fake. Sequence it before
`POST /api/access-governance/backfill`, which sweeps completed requests into the
entitlement ledger.

Why CI did not catch it: the decision-route unit test built its fixture with the
document's `tenantId` set equal to the approver session's `oid`. That modelled
the code's assumption rather than what the creating routes actually wrote, so the
mismatch could not appear in the test. The regression test added with the fix
now drives the reader from a document produced by the **real creating route**,
so the two can no longer disagree silently.

## Related

- [Access-requests parity doc](../parity/access-requests.md) — the
  feature-by-feature inventory against Purview / Fabric / Entra, including the
  two rows this defect regresses.
- [Access requests admin page](../admin/access-requests.md) — a *different*
  system: the sign-in front-door queue, not data-asset access.
- [Workspace RBAC](workspace-rbac.md) — the workspace-role model the `item`
  scope grants against.
- [Catalog](catalog.md) — where a requester raises the request.

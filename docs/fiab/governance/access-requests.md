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

!!! warning "Known defect — cross-user approval does not currently work"
    The inbox and the decision route both scope their Cosmos reads to the
    **signed-in user's own object id**, while requests are written under the
    **requester's** object id. In any tenant where the approver is a different
    person from the requester, the approver's inbox comes back **empty** and a
    direct decision call returns **404 `not found`**.

    Do not read the walkthrough below as a description of working cross-user
    behaviour — today it is reliable only where approver and requester are the
    same identity. See [What is broken](#what-is-broken-today) for the exact
    lines and the fix. This page will be updated when the fix ships and is
    verified live.

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

## What is broken today

Three routes disagree with each other about what the `tenantId` partition key
holds.

| Route | Line | Value written / read |
|---|---|---|
| `POST /api/catalog/request-access` | 141 | writes `tenantId: s.claims.oid` — the **requester's** object id |
| `POST /api/access-packages/[id]/request` | 98 | writes `tenantId: requesterId` — the **requester's** object id |
| `GET /api/access-requests` | 39 | queries `WHERE c.tenantId = @t`, `@t = s.claims.oid` — the **approver's** object id |
| `POST /api/access-requests/[id]/decision` | 65, 72 | reads `c.item(id, s.claims.oid)` — the **approver's** object id |

`oid` is the Entra **user** object id, not the tenant id. So unless the approver
and the requester are the same person, the inbox query matches zero rows and the
decision read 404s before any approver logic runs.

The platform already has the correct helper for exactly this case.
`tenantScopeId(session)` in `apps/fiab-console/lib/auth/session.ts` returns
`claims.tid || claims.oid` — the Entra **tenant** id — and its doc comment states
it exists so that state written by one user "resolves for any grantee in the
**same tenant**". It is adopted by 84 API route files. The four routes above are
not among them.

The fix is to scope this container's reads and writes with `tenantScopeId(s)`
consistently, plus a one-time repartition of existing documents. Note that the
existing `POST /api/access-governance/backfill` sweeps completed F16 requests
into the entitlement ledger, so a repartition needs to be sequenced with it.

Why CI did not catch it: the decision-route unit test builds its fixture with the
document's `tenantId` set equal to the approver session's `oid`. That models the
code's assumption rather than what the creating routes actually write, so the
mismatch cannot appear in the test.

## Related

- [Access-requests parity doc](../parity/access-requests.md) — the
  feature-by-feature inventory against Purview / Fabric / Entra, including the
  two rows this defect regresses.
- [Access requests admin page](../admin/access-requests.md) — a *different*
  system: the sign-in front-door queue, not data-asset access.
- [Workspace RBAC](workspace-rbac.md) — the workspace-role model the `item`
  scope grants against.
- [Catalog](catalog.md) — where a requester raises the request.

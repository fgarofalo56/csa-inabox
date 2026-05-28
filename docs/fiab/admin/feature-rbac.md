# Feature Permissions (Fabric-style RBAC)

CSA Loom v3.4 ships a Fabric-style permissions model that lets tenant
admins delegate access to every editor type, every admin page, and every
workload domain to specific Entra users and groups. The surface lives at
**/admin/permissions** and is enforced by the BFF feature gate on every
request.

## Model

| Term         | Meaning                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Capability   | Stable id like `editor.notebook`, `admin.tenant-settings`, `workload.warehouse`.                 |
| Domain       | Top-level bucket (`Data`, `Realtime`, `BI`, `AI`, `APIs`, `Graph`, `Ops`, `Admin`).              |
| Workload     | Sub-grouping within a domain (`Lakehouse`, `Eventhouse`, `Power Platform`, ...).                 |
| Principal    | Entra user oid OR Entra group oid.                                                               |
| Role         | `Reader` (view), `Contributor` (view+edit), `Admin` (view+edit+grant).                           |
| Grant        | Tuple `(tenantId, capabilityId, principalId, principalType, role)` stored in Cosmos.             |

Grants on a parent capability propagate to every child. e.g. granting
`workload.warehouse` covers every warehouse editor (`editor.warehouse`,
`editor.synapse-dedicated-sql-pool`, ...) automatically.

## Storage

Cosmos container `feature-permissions`, partition key `/tenantId`,
auto-created by the BFF on first access. No bicep change required — the
cosmos-client's `createIfNotExists` flow provisions the container the
first time the gate runs.

## Tenant-admin bypass

Two env vars set in `admin-plane/main.bicep` give bootstrap admins full
access before any explicit grants exist:

| Env var                       | Meaning                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `LOOM_TENANT_ADMIN_OID`       | Single Entra user oid that bypasses all permission checks.    |
| `LOOM_TENANT_ADMIN_GROUP_ID`  | Comma-separated group oids whose members bypass all checks.   |

Tenant admins always see capability id `Admin` resolved by the gate, so
they can grant access from the empty state in `/admin/permissions`.

## Enforcement

Every BFF route + every admin page calls `enforceCapability(session,
capabilityId, role)` from `@/lib/auth/feature-gate`. The helper:

1. Returns 401 when the session is missing.
2. Resolves the caller's principal set: their oid + every group oid in
   the session claims.
3. Walks the capability's ancestor chain (workload → domain) so parent
   grants are honored.
4. Runs a single Cosmos point query against `feature-permissions`
   partitioned by tenant.
5. Returns 403 with a structured `{ error, capability, requiredRole,
   reason, remediation }` body when no matching grant exists.

The 403 body always carries an actionable remediation. The frontend
renders that remediation in a Fluent UI MessageBar with `intent="warning"`
— never silently swallowed.

## Granting access

1. Navigate to `/admin/permissions`. The left pane is the capability
   tree (Domain → Workload → Capability).
2. Click a capability. The right pane shows existing grants + the
   **Add grant** button.
3. The grant dialog opens with a tabbed Entra search (User or Group)
   that hits `/api/admin/permissions/principals?q=...&kind=...`. The
   BFF route uses the Console UAMI's Microsoft Graph token (requires
   `User.Read.All` + `Group.Read.All` app permissions).
4. Pick a principal, pick a role, click **Grant**. The dialog POSTs to
   `/api/admin/permissions/grants`.
5. Remove a grant via the inline **Remove** button in any row.

## Graph permission prerequisites

For the principal-search to work, the Console UAMI must hold these
Microsoft Graph application permissions (admin-consented):

| Permission           | Why                          |
| -------------------- | ---------------------------- |
| `User.Read.All`      | Search users by display name |
| `Group.Read.All`     | Search groups by display name |

Grant via Azure CLI:

```bash
# Graph appId is the same across tenants:
GRAPH_APP_ID=00000003-0000-0000-c000-000000000046

az ad sp permission add \
  --id <uami-objectid> \
  --api $GRAPH_APP_ID \
  --api-permissions \
    df021288-bdef-4463-88db-98f22de89214=Role \
    5b567255-7703-4780-807c-7be8301ae99b=Role

az ad app permission admin-consent --id <uami-objectid>
```

When permissions are missing, the dialog renders a MessageBar with the
exact remediation pulled from the BFF's 503 response — there is no
hardcoded fallback principal list (per the no-vaporware rule).

## REST API

| Method | Path                                                    | Capability gate          |
| ------ | ------------------------------------------------------- | ------------------------ |
| GET    | `/api/admin/permissions/capabilities`                   | `admin.permissions::Reader` |
| GET    | `/api/admin/permissions/grants[?capabilityId=...]`      | `admin.permissions::Reader` |
| POST   | `/api/admin/permissions/grants` body `{...}`            | `admin.permissions::Contributor` |
| DELETE | `/api/admin/permissions/grants?id=...`                  | `admin.permissions::Contributor` |
| GET    | `/api/admin/permissions/principals?q=...&kind=user\|group` | `admin.permissions::Contributor` |

All routes return JSON shape `{ ok: boolean, ... }` with proper HTTP
status codes per the BFF contract.

## Catalog extension

Adding a new editor or admin page to the catalog: add one row to
`apps/fiab-console/lib/auth/feature-catalog.ts`, then call
`enforceCapability(session, 'editor.<your-type>', 'Reader')` at the top
of the new route. No other change required — the capability shows up in
`/admin/permissions` immediately.

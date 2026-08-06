# Runtime configuration (env-config) admin page

> **Surface:** `/admin/env-config`
> **BFF:** `apps/fiab-console/app/api/admin/env-config/route.ts`
> **Store:** Cosmos `env-config` (PK `/tenantId`) — desired state; projected onto the Console Container App

The **Runtime configuration** page lets an operator view and set the console
deployment's environment variables (Cosmos, Azure OpenAI, Synapse, ADX, …) from
the UI — with a real ARM revision and an audit trail — instead of opening the
Azure portal. It is the console's self-service knob for the `LOOM_*` settings the
BFF reads at runtime.

## What you can do

- **View desired state** — every `LOOM_*` the console reads, its current value
  (or "unset"), and whether it's secret-typed.

## Status semantics & the coverage score (honest scoring)

Every editable variable carries one server-computed status
(`lib/admin/env-config.ts:envVarStatus` — unit-tested, shared by the BFF route):

| Status | Meaning | Counts configured? |
|---|---|---|
| `set` | The value is present in the running deployment. | ✅ |
| `satisfied` | Unset, but an `anyOf` sibling/alias IS set — the either/or requirement is met (e.g. `LOOM_TENANT_ADMIN_GROUP_ID` while `_OID` is set, or the Power BI embed vars while the Grafana embed path is active). | ✅ |
| `default` | Unset, and the unset state is the fully-functional built-in default (`optionalDefault` — an H-band silent-fallback substrate). The feature is ON via the fallback. | ✅ |
| `opt-in` | Unset, and the owning check is **opt-in by design** (`spec.optIn` — a policy-accepted carve-out such as the Postgres Flexible Server cost carve-out, the Power BI Fabric-family backend, or the s3proxy gateway). **Neither configured nor a gap**: excluded from BOTH sides of the coverage ratio and rendered with a neutral badge. Once a value is set it scores like any other key. | ➖ excluded |
| `derived` | Unset, and bicep is supposed to auto-derive the value on a push-button deploy — **but the value is NOT present**, which means the derivation has not happened (the deploy failed, was skipped, or predates the module). This is a **gap**, never counted configured. | ❌ |
| `unset` | A plain unmet requirement. | ❌ |

The "N of M configured" badge and the progress bar score only the non-opt-in
catalog: `configured = set + satisfied + default`, `M = catalog − opt-in`.
A separate "K opt-in (not scored)" badge names the excluded carve-outs. This is
what makes 100% **honest**: a policy opt-in can never drag the score down
forever, and a derived variable a deploy failed to fill can never prop it up.
- **Set / change a value** — writes the desired value to the Cosmos `env-config`
  doc and projects it onto the `loom-console` Container App as a **new ACA
  revision**, so the change is durable (survives a restart) and audited.
- **Secrets** — secret-typed keys are never stored in plaintext here; only a
  `{ set: true }` marker is kept, with the value living in an ACA secret / Key
  Vault reference.
- **Bicep reconcile snippet** — the page emits the bicep line to add so the
  change also survives the *next* full deployment (drift prevention per the
  bicep-sync rule).

## Backend

| Control | Backend |
|---|---|
| Desired state | Cosmos `env-config` (PK `/tenantId`) |
| Apply | ARM `Microsoft.App/containerApps` PATCH → new revision (`updateContainerAppEnv`) |
| Audit | Cosmos `audit-log` |

## RBAC & honest gates

Runs as the Console UAMI, which needs **Contributor** on the `loom-console`
Container App to roll a revision. Missing rights surface as an honest gate. Secret
values are handled as ACA secrets — the page will not display or persist them in
clear text.

## Related

- [Scale by SKU](scaling.md) · [Feature permissions](feature-rbac.md)

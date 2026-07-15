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

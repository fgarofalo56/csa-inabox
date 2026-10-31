# API Gateway hub (API Management)

> **Surface:** `/admin/api-gateway` (the old `/admin/api-management` and
> `/admin/mcp-servers` redirect here)
> **Backend:** Azure API Management control plane (ARM + APIM management plane),
> Cosmos DB (`apiplane-desired`, `apiplane-observed`, audit)

!!! warning "Status: W1 is merged, not deployed"
    Everything on this page describes code that is merged to the W1 integration
    branch (`feat/apigw-w01`). It has **not been deployed to any estate** and has
    **not been click-walked in a browser**. Where this page says what a screen
    does, that comes from reading the code and from unit tests. Nothing here is
    live-verified. The live receipts (Commercial G1 walk, a second APIM
    registered, GCC-High inventory counts through Actions) are still to be
    collected and are tracked on the W1-7 row of the W1 PRP. Per
    `deploy-integrity.md` R2, treat all of it as "merged, not deployed".

The hub is the one place to register, observe and manage the Azure API
Management (APIM) gateways Loom fronts its APIs with. W1 is read-and-observe
first: registering a gateway reads it and changes nothing in the service.

## Contents

1. [Register a gateway](#register-a-gateway)
2. [Observe mode and inventory sync](#observe-mode-and-inventory-sync)
3. [Environments and classification](#environments-and-classification)
4. [Findings](#findings)
5. [The Manage panes](#the-manage-panes)
6. [Who can administer the API Gateway Plane](#who-can-administer-the-api-gateway-plane)
7. [Gates and Fix its](#gates-and-fix-its)
8. [Per-cloud status](#per-cloud-status)
9. [Rollback](#rollback)
10. [When a step fails](#when-a-step-fails)

## Register a gateway

A gateway is identified by its APIM service resource id:
`/subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<name>`.
Only the service scope is accepted; a child resource id (for example one ending
in `/apis/x`) is refused. The gateway's record id is derived from the resource
id (`gw-` plus the first 16 hex characters of the SHA-256 of the lower-cased id),
so registering the same service twice is the same record, never a second one.

### Greenfield

The gateway the deployment creates is the **deploy-owned** gateway. The
deployment sets `LOOM_APIPLANE_DEPLOY_GATEWAY_ID` on the console; the first call
to the gateway list registers it automatically, with no user step. It is shown
with a `deploy-owned` badge and cannot be removed from the hub (it is
re-registered automatically). If the deployment brought an existing APIM
(`existingApimName`), the id points at that service instead.

### Brownfield (an APIM that already exists)

Use **Register a gateway** on the Gateways tab and paste the resource id. Loom
then runs an access preflight (what the Console identity can do at that scope),
registers the gateway in **observe** mode and reads its inventory once for you.
Nothing is changed in the service.

!!! warning "Not yet met: discovery and offer (deploy-integrity R5)"
    R5 asks the platform to **discover** existing candidates across
    subscriptions and **offer** each one, rather than needing the id. **W1 does
    not do this.** There is no subscription scan and no candidate list for APIM
    services: you must supply the resource id. Nothing is ever adopted silently
    (registration is an explicit action), but the "discover" half of R5 is a
    known gap, not a built feature. The only subscription-scan work planned in
    this program is the W2 endpoint registry, which covers AI endpoints, not
    APIM services. This gap is open and needs an owner and a date.

Registration outcomes (the messages below are what the code returns):

| Outcome | HTTP | What it means |
|---|---|---|
| Registered | 201 | Record created in observe mode, then a first sync runs. |
| `invalid_resource_id` | 400 | The id is not an APIM service id. |
| `already_registered` | 409 | That service is already registered under that id. |
| `gateway_role_missing` | 422 | The Console identity cannot read the service. The message names the role, its definition id, the scope and the exact `az role assignment create` command. |
| `preflight_failed` | 502 | The access check itself could not run. |

## Observe mode and inventory sync

Every gateway starts in `observe` mode: the plane reads, it does not write.
(`manage` is a value the record can hold; nothing in W1 flips a gateway to it.)

**Sync inventory** (and **Re-sync inventory**) reads the service through the
Console identity and stores redacted observed documents. It reads APIs (and each
API's operations), products, subscriptions, users, groups, backends, named
values, policy fragments and MCP-typed APIs. The Overview tab shows the counts
from the last sync: APIs, Endpoints (operations), Products, Subscriptions,
Backends, MCP servers.

What is and is not stored: policy text, subscription keys, named-value values
and e-mail addresses are **not** kept. Backend URLs are reduced to
scheme/host/path with query, fragment and credentials removed. Policy analysis
keeps a SHA-256 of the policy and a set of facets (hosts, auth methods, limits,
included fragments, whether an LLM policy is present).

Behaviours to know:

- A gateway that has never synced shows dashes, not zeros.
- **Endpoints** is taken from the response of the sync you ran in this browser
  session. After a page reload it shows a dash and `counted on sync` until you
  sync again; it is not read back from the stored record.
- A type whose list came back partial or failed is **never swept**: documents
  already stored for it are kept, and the type is listed as `partial` next to the
  last-sync time. Do not read a partial count as a total.
- One sync per gateway at a time (a second returns 409 `in_flight`). Admission
  is per console process, so two replicas could in principle both run one.
- A re-sync does not overwrite an environment classification written in between.
- MCP: if the gateway's ARM does not register the preview api-version that
  exposes the MCP API type, `mcp` is reported `unavailable` and the type is
  partial, not zero.

The API behind the button is `POST /api/admin/api-gateway/gateways/{id}/sync`.

## Environments and classification

Settings -> **Environments** holds a tenant-wide catalog used to classify
gateways. It is seeded with six built-ins: Development, Test, QC, Staging,
Production (the only production-class one) and Sandbox, each with aliases
(for example `dev`, `prod`, `uat`). Names from Loom deployment-pipeline stages
that do not already match are added as custom environments. You can add and edit
custom environments, turn **require classification** on or off (off by default),
and see the derived compatibility matrix between environments. Tag suggestions
read the tags ARM returned for a gateway and offer them as one-click
classifications; Loom never writes tags back to Azure.

A gateway with no environment is **Unclassified**. Reclassifying (one or many
resources, one atomic batch) writes through
`POST /api/admin/api-gateway/environments/reclassify`. It is refused with 409
when it would block an already-applied publication; a concurrent change returns
a 409 asking you to reload. Publications arrive in W2, so in W1 there is nothing
yet to block.

## Findings

Settings -> **Findings** lists advisory findings: pairings that exist in APIM
outside Loom's publications and that the environment rules would block. They are
**advisory only and block nothing**. W1 has one producer: an MCP server observed
on a gateway whose URL matches a registered MCP endpoint in an incompatible
environment. Registered endpoints do not exist until W2, so in W1 this list is
expected to be empty; "empty" here means no producer has anything to compare, not
that the estate was checked and found clean. If the findings source is not wired
in a deployment the page reports it as unavailable rather than showing none.

## The Manage panes

Gateway -> **Manage** hosts the eight existing APIM panes: Service & SKU, APIs,
Products, Subscriptions, Named values, Backends, Policies, Developer portal.
They behave as they did on the old single-gateway page; the Manage tab passes
the selected gateway to each.

**Known W1 gap.** For a gateway other than the deploy-owned one, **Service &
SKU, Subscriptions, Backends and Developer portal** are scoped to that gateway.
**APIs, Products and Policies** are not: they read through
`/api/items/apim-api|apim-product|apim-policy`, which are not gateway-scoped.
**Named values** has a scoped route but its pane is not wired to it yet (it
still carries a typed Key Vault secret URL that must become a picker first). For
a registered (non-default) gateway those four tabs show a "not available yet"
message instead of data (they would otherwise show the deploy-owned
gateway's data under the wrong name). For the deploy-owned gateway all eight
work as before.

## Who can administer the API Gateway Plane

Every plane admin route (`/api/admin/api-gateway/**`) requires the scoped
**`apiplane-admin`** capability ("API Gateway Plane administration"); tenant
admins always have it, so they are a superset. To delegate, a tenant admin
grants the capability (role **Admin**) to an Entra group at
`/admin/permissions` and adds people to that group. It is deliberately not a
child of Tenant administration, so a grant on tenant administration does not
cascade to it.

- A caller with neither gets a 403 whose remediation names the group(s) to
  join, or says that no group holds the capability yet.
- **Settings -> Runtime** (under API Gateway) lists the group(s) holding the
  capability and, when none does, the remediation plus a **Grant to a group**
  link.
- Every audited plane write records the capability used (`apiplane-admin` or
  `tenant-admin`) in the audit record's `capability` field.
- Admin-tier: an interactive browser sign-in is required; a CLI device-code
  session is refused.

## Gates and Fix its

The gateway Overview tab evaluates three gates for that gateway:

| Gate | Fires when | Fix it |
|---|---|---|
| `api-gateway.gateway-role` | The Console identity cannot read the service (or, in `manage` mode, cannot write). | Dialog with the role (Reader to observe, API Management Service Contributor to manage), its definition id, the scope and a copyable `az role assignment create` command. |
| `api-gateway.monitoring-reader` | A telemetry probe was refused for lack of Monitoring Reader. | Same, for Monitoring Reader. **No telemetry probe runs in W1, so this gate cannot fire yet.** |
| `api-gateway.llm-logs-unavailable` | The boundary does not offer the `GatewayLlmLogs` diagnostic category, or it was not measured. | None. It is a **declared gap**: a card naming the owner and the substitute. There is nothing to click because there is nothing the platform or you can do. |

The **Fix it** dialog shows the command; it does not run it. Loom does not
grant roles in W1 (the plane never writes role assignments or diagnostic
settings on a gateway).

Known W1 gaps: the three gates are exported from `lib/gates/registry/api-gateway.ts`
and rendered on the gateway Overview, but they are **not** on the Admin
gate-registry page and Copilot cannot discover or resolve them yet. ux-baseline
G2 asks for both; that is open.

The **Telemetry** card shows only checks that run today: **read access**, from
the registration preflight. There is no logger check and no diagnostic-routing
check in the code, so they are not shown (not shown as passing either).

## Per-cloud status

The hub is the same code in every boundary; what differs is what each boundary's
APIM supports and what has been measured. "Measured" below means the W0
instrument ran in that boundary (W0 receipt, 2026-10-29/30). **None of it means
W1 has been deployed or run there.**

| Boundary | W0 measured | W1 status | Declared gaps |
|---|---|---|---|
| Commercial | Yes (run 40974529572) | Merged, not deployed. No registration or sync has been run. | None declared. `GatewayLlmLogs` is offered. |
| GCC-High | Yes (run 40975571002) | Merged, not deployed. No registration or sync has been run. | `GatewayLlmLogs` absent (substitute: `llm-emit-token-metric` and `GatewayLogs`, owner W4, review 2026-12-01). MCP API type not registered at the preview api-version (substitute: console-hosted MCP as a plain API, owner W6). Named-value runtime and VNet DNS not measured (in-boundary runner, Q18). |
| IL5 | **No.** `deploy-fiab-il5.yml` has never run. Supported-in-code, never exercised. | Not measured. | Everything (LLM logs, token limits, MCP type) is "not measured"; token limits are refused where unavailable, never substituted silently. |
| DoD | **No.** Treated as IL5 by the hub (a DoD cloud gateway is shown with the IL5 gaps). Not separately measured. | Not measured. | As IL5. |
| GCC | **No.** No GCC tenant exists. Supported-in-code, never exercised. | Not measured. | Everything. |

Do not read Commercial and GCC-High as "working" because they are the measured
rows: they are the rows where W0 *measurements* exist. W1 itself has no receipt
in any boundary yet. Gov receipts come from GitHub Actions runs, never from a
local `az`.

## Rollback

Set `LOOM_APIPLANE_ENABLED=false` on the console. The value is read per request
(unset means on; only the literal `false`, any case, turns it off). With it off:

- `/admin/api-management` and `/admin/mcp-servers` stop redirecting and show the
  previous single-gateway pages (their bodies are kept unchanged under
  `app/admin/api-gateway/_legacy/`).
- The deploy-owned gateway is no longer auto-registered.

It does not delete anything already stored. Whether the hub page itself
(`/admin/api-gateway`) is also hidden by the flag is not established here; do not
rely on the flag to remove the hub. The flag is untested on a live estate.

## When a step fails

The remediations below are the strings the code returns.

| You see | Cause | What to do |
|---|---|---|
| `The Console identity cannot read <id> (effective permissions at the scope do not include read). Grant role "Reader" (...) at scope <id> with: az role assignment create ...` | The permissions call answered and read is not in it. | Run the command (or have someone with Owner/User Access Administrator run it), then register or sync again. |
| Same, but `(a direct read of the service was refused or failed)` | The permissions call did not answer, so Loom tried reading the service and it failed. Write access cannot be proven this way and is reported false. | Same grant. If the role is already assigned, check the network path to ARM and RBAC propagation. |
| `resourceId must be an API Management service id: /subscriptions/<guid>/...` | Wrong or child resource id. | Paste the service id. |
| `<id> is already registered as gateway gw-...` | Already registered. | Open it from the list. |
| `Could not run the access preflight for <id>: ...` | ARM was unreachable or the call errored. | Retry; the text after the colon is the underlying error, not a diagnosis. |
| `LOOM_APIPLANE_DEPLOY_GATEWAY_ID is not an API Management service resource id: ...` | Bad value from the deploy. | Fix the deployment output; the deploy gateway is not registered until then. |
| `The Console identity cannot read <id>; grant the role named on the gateway record first.` (sync, 422) | Sync refused because registration recorded no read access. | Grant the role from the gateway's Gates card, re-register to refresh access, then sync. |
| `A sync of <id> is already running.` (409) | A sync is in progress. | Wait for it. |
| `Gateway <id> is not registered.` (404) | Stale id. | Reload the list. |
| `This gateway is owned by the deployment and is re-registered automatically; it cannot be removed here.` | Removing the deploy gateway. | Not removable. |
| `This change would block N applied publication(s): ...` | Reclassification refused. | Unpublish them or pick a compatible environment. |
| `<id> was changed by someone else while this was in progress. Reload and try again.` | Concurrent edit. | Reload. |
| `The gateway registry is not available in this deployment yet, so there is nothing to classify.` | Classification store not wired (503). | Needs Cosmos (`LOOM_COSMOS_ENDPOINT`) and the registry; check the deployment. |
| `Could not read the capability grants: ... Cosmos DB is required (LOOM_COSMOS_ENDPOINT).` | Runtime tab, 503. | Set the Cosmos endpoint. |
| A 403 naming a group | You lack `apiplane-admin`. | Join the named group, or ask a tenant admin to grant the capability. |

Measuring a gateway against Azure: `scripts/measure/apiplane/registry-probe.mjs`
compares Loom's API count for a gateway with `az rest` over ARM and exits
non-zero on a mismatch. It was written for the live receipts and has only been
unit-tested offline.

## Backend

Operations on the Manage panes are real APIM management-plane calls
(`Microsoft.ApiManagement/service/*`) executed as the Console UAMI, with no mock
inventory. Secret named values are Key Vault references, never stored in the
console. The Console identity needs **Reader** on the APIM service to observe and
**API Management Service Contributor** to manage.

## Related

- [Scale by SKU](scaling.md) - change the APIM SKU + capacity.
- [MCP Servers](mcp-servers.md)
- [Parity: AI gateway](../parity/apim-ai-gateway.md)

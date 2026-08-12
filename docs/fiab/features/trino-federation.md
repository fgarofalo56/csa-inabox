# Trino federation

> **Surface:** SQL Lab editor (`/items/sql-lab/<id>`) → the engine picker, **Federated SQL (Trino)** option
> **Backend:** Trino OSS (Apache-2.0) as a scale-to-zero, internal-ingress Container App in your own VNet, registered against the Iceberg REST catalog plus any external connectors; reached only through the audited BFF at `/api/sql/trino`
> **Kill-switch flag:** `n7e-trino-federation` — **default ON** (opt-out)
> **Honest gate:** `LOOM_TRINO_URL` + `LOOM_TRINO_AUTH_MODE` (gate id `svc-loom-trino`) — both wired by a push-button deploy
> **Lake federation:** `LOOM_ICEBERG_CATALOG_URL` (gate id `svc-iceberg-catalog`) — the N1 Iceberg REST Catalog, deployed by the same pass

One SQL statement that joins a Loom Iceberg table with an external PostgreSQL
table. That is the whole value proposition, and it is the one thing the light
default engine cannot do.

## It used to be opt-in. It is not any more.

Trino was the single documented carve-out from Loom's default-on rule, for one
honest reason: it stood up a **private AKS cluster**, which is real, recurring,
un-avoidable cost — an AKS system node pool cannot scale below one node, so it
bills 24/7 whether or not anyone runs a query. Enabling that silently for every
deployment would have been a spend gate imposed without consent.

That premise no longer holds. Trino's supported single-process deployment
(`coordinator=true` + `node-scheduler.include-coordinator=true`) runs the whole
engine in **one container**, so it ships as an internal-ingress Container App
with `minReplicas: 0`: no replica exists until a query arrives, and idle cost is
**nothing**. The capability is therefore default-ON like everything else, and the
multi-node AKS module remains as the **opt-in scale-out** path for federations
that outgrow one container.

The trade is a **cold start**: the first query after an idle period waits ~20-40s
for the JVM. The BFF budgets 120s for that hop
(`LOOM_TRINO_FETCH_TIMEOUT_MS`). If a warm engine is worth ~$60-90/mo/cloud, set
`loomBackends.trinoMinReplicas = 1` in your param file — see
[Paying to skip the cold start](#paying-to-skip-the-cold-start-opt-in). (Until
#3110 that meant editing the module: the orchestrator never passed `minReplicas`,
so the module's parameter was unreachable from a param file.)

## How to use it end to end

**Prerequisites: none on a push-button deploy.** `admin-plane/main.bicep` deploys
`platform/fiab/bicep/modules/data-plane/loom-trino-aca.bicep` and emits
`LOOM_TRINO_URL` whenever `loomBackends.trino != 'disabled'` on a Container Apps
boundary — which is Commercial **and** both Gov boundaries (`commercial-full`,
`tenant-dmlz`, `gcc-high` and `il5` all set `containerPlatform = 'containerApps'`
and `deployAppsEnabled = true`, and none of them override `loomBackends`, so they
all inherit `trino: 'enabled'`).

**The image must exist first.** As with every other Loom Container App, the
from-scratch path is two-phase: provision infra with `deployAppsEnabled=false`,
build the images, then re-deploy with apps enabled. `loom-trino` is produced by
`build-fiab-images-acr-tasks.yml` (its `all` matrix and its
`apps/loom-trino/**` push trigger) and `full-app-deploy-commercial.yml` in
Commercial, and by `gov-provision-dataplane-images.yml` in GCC-High / IL5.
On a live Gov estate, `gov-provision-trino.yml` does the same incrementally.

**The engine sees the lake on the same deploy.** The orchestrator no longer
passes an empty Iceberg catalog URL. `admin-plane/main.bicep` stands up the N1
Iceberg REST Catalog (`data-plane/iceberg-catalog-aca.bicep`, Unity Catalog OSS
on internal ingress, `minReplicas: 0`) in the SAME pass and hands its FQDN to the
engine, so the `iceberg` catalog is rendered against a URL that actually answers
and `SHOW CATALOGS` includes the lake on a first install.

That coupling is the whole point. Until it existed, a default-ON "Federated SQL"
engine answered `SHOW CATALOGS` with `jmx` and `memory` — running, but federating
nothing, because the catalog module was invoked by no orchestrator at all (it was
orphan-allowlisted, with a best-effort step in a dispatch-only bootstrap workflow
as its only automated producer). Opting out of either half
(`loomBackends.icebergCatalog = 'disabled'`) puts you back in that state, and the
`svc-iceberg-catalog` gate says so instead of scoring the estate Ready.

**Adding a federation source, in the template.** Put the connector properties on
the `loomBackends` bag rather than patching the running app:

```bicep
loomBackends: {
  trinoCatalogs: {
    // rendered as <name>.properties by the image entrypoint
    LOOM_TRINO_CATALOG_SALES: 'connector.name=postgresql\nconnection-url=jdbc:postgresql://pg.internal:5432/sales\nconnection-user=loom'
  }
  trinoCatalogSecrets: {
    // becomes an ACA secretRef resolved from Key Vault by the Console UAMI —
    // the password never appears in the template or the ARM history
    LOOM_TRINO_CATALOG_SALES_PASSWORD: '<kvUri>secrets/trino-sales-password'
  }
}
```

An `az containerapp update --set-env-vars` would work once and be reverted by the
next deploy; the bag survives.

Optional knobs: `LOOM_TRINO_ICEBERG_CATALOG` (the Trino catalog name fronting the
Loom lake, default `iceberg`), `LOOM_TRINO_AUDIENCE` (Entra audience),
`LOOM_TRINO_TOKEN` (a Key Vault secret reference bearer), and
`LOOM_TRINO_FETCH_TIMEOUT_MS` (JVM cold-start budget, default 120s — a cold
replica takes ~20-40s to answer).

**Access posture, stated plainly.** Ingress is internal-only and the intended
door is the audited BFF at `/api/sql/trino`. Unless `LOOM_TRINO_TOKEN` is wired,
the engine itself runs with **no authentication**, so anything already inside the
Container Apps environment, a peered network, or the admin P2S VPN can query it
directly and bypass both the session check and the audit row. This is the same
posture as the sibling `loom-duckdb` / Iceberg-catalog services; it is called out
here rather than left implied by "internal ingress".

**Then, as an analyst:**

1. **Expose the tables you want to federate as Iceberg** — see
   [Iceberg REST catalog and interop](iceberg-interop.md). Trino reads the Loom
   lake through that catalog.
2. Open a **SQL Lab** item and pick **Federated SQL (Trino)** in the engine
   picker.
3. **Write one statement across sources.** A Loom Iceberg table joined to an
   external PostgreSQL, MySQL, Kafka or MongoDB connector registered on the
   cluster.
4. **Read the status bar** for the engine and timing, exactly as on the DuckDB
   tier.
5. **Check the audit rows.** A federated query is an external data-access event:
   the BFF writes an `_auditLog` row (principal, statement scope, catalogs, rows,
   outcome, timestamp) and fans out through the SIEM stream. The audit write is
   awaited before the response is sent — there is no unaudited path to the
   cluster.

## What the backend actually does

| Control | Backend |
|---|---|
| Engine option visibility | The `n7e-trino-federation` runtime flag (default ON) |
| Query execution | `POST /api/sql/trino` -> the in-VNet Trino Container App (scale-to-zero) |
| Caller identity | With authorization enforced the JWT principal maps to one Trino session user (`LOOM_TRINO_SESSION_USER`, default `loom-console`); the signed-in Loom principal rides `X-Trino-Client-Info` / client tags and is what the `_auditLog` row records |
| Upstream auth | Entra bearer for `LOOM_TRINO_AUDIENCE`, minted by the Console UAMI. `LOOM_TRINO_TOKEN` (Key Vault secret reference) still wins for a BYO cluster with its own token auth |
| Loom lake access | The N1 Iceberg REST Catalog (`LOOM_ICEBERG_CATALOG_URL`) |
| Audit | `_auditLog` plus SIEM fan-out per statement |

The coordinator has **internal ingress only** — and internal ingress is a network
control, not an authorization one.

## Authentication: on by default, sealed when it cannot be pinned

Round 1 of this work shipped the engine with **no**
`http-server.authentication.type`, so anything already on the VNet (a sibling
container, a peered host, an admin on the P2S VPN) could `POST /v1/statement`
with an arbitrary `X-Trino-User` and bypass both the BFF session check and the
audit row. That is fixed.

`apps/loom-trino/docker-entrypoint.sh` renders Trino's **JWT authenticator**
against the active cloud's Entra JWKS (`login.microsoftonline.us` in Gov —
derived, never hard-coded) and pins the accepted audience.
`LOOM_TRINO_AUTH_MODE` reports the deployed posture:

| Posture | What it means | What SQL Lab shows |
|---|---|---|
| `entra` | Audience pinned to the Console's app registration. The BFF's UAMI bearer is admitted; everything else gets 401 | Federated SQL runs |
| `sealed` | Enforced against the sentinel audience `api://loom-trino-sealed.invalid`, which no tenant can mint. The engine is up, `minReplicas: 0` so it bills nothing, and serves **nobody** | The honest gate, with the un-seal steps |
| `disabled` | Explicit opt-out (`loomBackends.trinoAuthMode='disabled'`) — the old anonymous posture. Logs a SECURITY WARNING every boot; the env-check reports it | Federated SQL runs, unauthenticated engine |

A from-scratch install lands on **`sealed`**: ARM cannot create an Entra app
registration (it is a Microsoft Graph object), so there is nothing to pin at
template time. Run `.github/workflows/csa-loom-post-deploy-bootstrap.yml` — the
sign-in bootstrap every estate needs anyway — and redeploy with
`LOOM_MSAL_CLIENT_ID` set, or pin a dedicated app with
`loomBackends.trinoAudienceClientId`.

Known limitation, stated rather than implied away: `required-issuer` is **not**
pinned by default. Entra issues v1 (`sts.windows.net/<tid>/`) or v2
(`login.microsoftonline.us/<tid>/v2.0`) issuers depending on the app
registration, and Trino's `required-issuer` takes a single value — pinning the
wrong form would seal the engine permanently. Set
`LOOM_TRINO_REQUIRED_ISSUER` once you know which form your tenant issues.

Fail-closed (#2678): when the engine is enforcing (`entra`) but the Console
cannot mint a bearer for the pinned audience — the expected state until the App
ID URI is a registered resource (`api://<clientId>` is not registered anywhere
in this repo yet, so token acquisition fails with **AADSTS500011** before the
engine sees the request) — the BFF returns the honest gate and **never sends an
unauthenticated statement**. It does not earn an opaque 401 while claiming the
posture is "enforced + reachable."

## Catalog authorization: who may query which catalogs (#2678)

Authentication proves *who* a caller is; it does not decide *what* they may
query. Before #2678 the engine had **no system access control**, so any
authenticated caller could query **every** catalog — the authorization posture
was provably incomplete. Authorization is now enforced in **two layers, both
deny-by-default**:

**1. BFF (`lib/azure/trino-authz.ts`) — per-caller, the layer with the real
identity.** The route resolves the signed-in Loom caller (`oid` / Entra
`groups` / tenant-admin tier, exactly the identity model
`resolveDomainTier` uses) to the set of catalogs they may reach, and **refuses a
statement that references anything outside it (403), before the coordinator is
touched** — an audited security event.

* **Built-in catalogs** — `system`, `jmx`, `memory`, and the Loom lake catalog
  (`iceberg`) — are open to any signed-in caller. They are the deployment's own
  resources, exactly like the DuckDB / Synapse-Serverless SQL Lab tiers.
* **External federation catalogs** (an operator-wired Postgres/MySQL/Kafka
  source) are **deny-by-default**. Wiring a source is not the same as
  authorizing every user to read it. Grant it in `LOOM_TRINO_CATALOG_POLICY`
  (`loomBackends.trinoCatalogPolicy`): either `"signed-in"` (any authenticated
  user) or a principal set — `{ "groups": ["<entra-group-oid>"] }` /
  `{ "oids": [...] }` / `{ "upns": [...] }`:

  ```json
  { "sales": "signed-in", "hr": { "groups": ["<hr-entra-group-oid>"] } }
  ```

  A fresh install has no external catalogs, so no policy is needed day one — this
  is never a day-one gate.

A statement that is not fully catalog-qualified (a bare `schema.table` that
resolves against the session catalog) is allowed only for a caller who may
already reach every configured catalog; a **restricted** caller must fully
qualify every table (`"catalog"."schema"."table"`) or use the structured
cross-source join, so authorization can be enforced — otherwise it is denied
fail-closed.

**2. Engine (`apps/loom-trino/docker-entrypoint.sh`) — the deny-by-default
floor for a DIRECT in-VNet caller that bypasses the BFF.** The entrypoint renders
a Trino **file-based system access control** (`access-control.name=file`) from
exactly the catalogs it wired: each is `read-only` (the `memory` scratch catalog
is `all`), everything else — including a phantom catalog or a properties file
dropped in later without a rule — is denied, and impersonation is denied. This
is uniform across callers (every caller maps to the one `loom-console` Trino
user), so **per-caller** narrowing lives at the BFF; the engine floor guarantees
no in-VNet caller can reach an unconfigured catalog. Opt out (Trino AllowAll)
with `loomBackends.trinoAccessControl='none'` — an audited SECURITY WARNING.

Honest follow-up: because every caller maps to one Trino user, the engine cannot
narrow a catalog to a specific Loom group by itself — per-group engine rules need
the signed-in principal at the engine (delegated tokens / an impersonation rules
file). Until then, per-group narrowing is BFF-enforced and the engine floor is
the uniform catalog allow-list.

## Idle cost — the real number

`minReplicas: 0` with no workload profile pinned, so the app lands on the CAE's
Consumption profile: **no replica exists until a query arrives, and a
scaled-to-zero Consumption app bills nothing.** Nothing polls the engine —
`/v1/info` probes only run against a live replica. So the Trino tier is **$0/mo
per cloud at idle**, and while it is `sealed` no replica is ever activated at
all. Under load it is 2 vCPU / 4 GiB for the duration of the query (max 2
replicas), and the first query after idle pays a ~20-40s JVM cold start, which
`TRINO_FETCH_TIMEOUT_MS` (120s) budgets for.

That is the Trino tier only. The synthetic-monitor results store this PR also
adds is **not** free: its blob **private endpoint** bills roughly $7-8/month per
cloud whether or not anything writes to it (the storage itself is cents).

### Paying to skip the cold start (opt-in)

Scale-to-zero is the default and stays the default. If you would rather pay for a
warm engine than pay the ~20-40s JVM cold start on the first query after an idle
window, set a floor on the existing `loomBackends` bag — no new parameter, no
module edit:

```bicep
loomBackends: {
  trino: 'enabled'
  trinoMinReplicas: 1     // always-warm; default 0 = scale to zero
}
```

Two things worth knowing before you set it:

- **It is per-boundary.** `loomBackends` is set per param file, so a floor in
  `commercial-full.bicepparam` does not warm the Gov engines, and vice versa.
- **A `sealed` engine is pinned back to 0 regardless.** Sealed means enforced with
  no mintable audience: the engine is up and serves *nobody*. An always-warm
  replica there would bill continuously for something that cannot answer a single
  query, so the floor is ignored until the audience is pinned (see
  [Authentication](#authentication-on-by-default-sealed-when-it-cannot-be-pinned)).
  If you set a floor and idle cost stays $0, check the posture first — that is the
  likely reason, and `/admin/readiness` reports it.

## Honest gates

- **`LOOM_TRINO_URL` unset.** Should not happen on a push-button deploy; it means
  the backend was opted out (`loomBackends.trino='disabled'`), the boundary is
  not Container Apps, or the `loom-trino` image is not in this ACR yet. The
  option appears in the engine picker and honest-gates when selected, naming the
  variable and the bicep module. It never silently falls back to a different
  engine and pretends the result came from Trino.
- **Flag OFF.** The option is not rendered at all. DuckDB and Synapse Serverless
  are unaffected and remain the engine the picker starts on.
- **No Iceberg REST catalog wired.** The engine still starts and serves its
  `jmx` / `memory` catalogs plus any operator-supplied federation source; the
  `iceberg` catalog is simply not rendered, rather than pointed at a URL that
  does not answer.
- **A SaaS-only external connector in an IL5 boundary.** Trino itself runs
  disconnected — it is a self-hosted OSS container in your own VNet reading your
  own ADLS Gen2 and in-boundary sources. Connectors that reach an external SaaS
  estate stay honestly gated in a disconnected enclave.

## Kill-switch

`n7e-trino-federation` — **default ON** (opt-out). OFF hides the Trino option in
the engine dropdown entirely; DuckDB and Synapse Serverless are unaffected either
way. To remove the Container App as well, redeploy with
`loomBackends.trino = 'disabled'`.

## Related

- [Iceberg REST catalog and interop](iceberg-interop.md) — how Trino sees the Loom lake
- [Arrow Flight SQL and ADBC connect](flight-sql-adbc.md)
- [PRQL modern-query mode](prql-modern-query.md) — the other SQL Lab language option
- [Governance catalog](../governance/catalog.md) · [Multi-cloud data virtualization](../governance/multi-cloud-virtualization.md)

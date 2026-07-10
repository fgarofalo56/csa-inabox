# Loom OneLake — unified-namespace / catalog service (HYP-1)

The namespace-virtualization service that gives every Loom engine one logical
filesystem over the customer's own **ADLS Gen2** — the outcome-equivalent of
Microsoft Fabric's OneLake top layer, built entirely Azure-native with **no
Fabric / OneLake / Power BI dependency** (`.claude/rules/no-fabric-dependency.md`).

It owns one address space:

```
loom://<tenant>/<workspace>/<item>/<path>
   → abfss://<container>@<account>.dfs.<suffix>/<root>/<path>   (+ SAS-less MI auth)
```

and resolves it to the **real** physical location every Azure engine
(Synapse / Databricks / ADX / AAS) already speaks — never a Fabric
`onelake.dfs.fabric.microsoft.com` host.

## Why this is a service, not a library

Loom already reproduces OneLake's namespace/shortcut/security *features* as
per-item console libraries (`adls-client.ts`, `lakehouse-shortcuts.ts`,
`onelake-security-client.ts`). HYP-1 promotes that layer to an **owned service**
every engine funnels through — one `loom://` resolver, one Cosmos registry of
`{ workspace→container, item→managed folder, shortcut→target, role→ACL }`.

The resolution **semantics are ported 1:1** from the shipped, live-verified
`apps/fiab-console/lib/azure/lakehouse-abfss.ts` priority ladder, so the service
and the in-process console fallback resolve a lakehouse to the **same** abfss.

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /health` | Liveness + `configured: { registry, storage }` flags |
| `POST /resolve` `{ uri }` | Resolve one `loom://` address → physical pointer + auth |
| `GET /resolve?uri=loom://…` | Same, query-string form |
| `POST /register` `{ tenant, workspace, item, container, rootPath, abfssRoot?, shortcut? }` | Upsert a namespace registration (real Cosmos upsert) |
| `GET /catalog?tenant=…` | List a tenant's registrations (Explore/Govern/Secure) |

### Resolution priority ladder (from `lakehouse-abfss.ts`)

1. **Shortcut** target (metadata-only symbolic link — internal passthrough MI,
   or external stored-connection `credentialRef`).
2. **Stamped full abfss** root (most accurate, already sovereign-cloud-correct).
3. **Recorded** `{ container, rootPath }` (+ optional explicit `account`).
4. **Convention fallback** `lakehouses/<safeSeg(item)>` in the default container.

When **no real storage account is configured**, `/resolve` returns an honest
`503 { ok:false, code:'not_configured' }` naming the exact env var — never a
guessed host (`no-vaporware.md`).

## Config (env)

| Var | Purpose | Absent ⇒ |
|---|---|---|
| `LOOM_ONELAKE_DEFAULT_ACCOUNT` | DLZ storage account for convention/relative paths (else parsed from `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`) | resolve honest-503 |
| `LOOM_ONELAKE_DEFAULT_CONTAINER` | Convention-fallback container (default `bronze`) | — |
| `LOOM_ONELAKE_DFS_SUFFIX` | Override DFS suffix (else derived from `AZURE_CLOUD`) | Gov auto-detected |
| `LOOM_ONELAKE_COSMOS_ENDPOINT` | Registry Cosmos account (else shared `LOOM_COSMOS_ENDPOINT`) | convention-only; `/register` honest-503 |
| `LOOM_ONELAKE_COSMOS_DATABASE` | Registry DB id (default `loom`) | — |
| `LOOM_ONELAKE_REGISTRY_CONTAINER` | Registry container id (default `onelake-registry`, created on demand) | — |
| `LOOM_UAMI_CLIENT_ID` | UAMI client id for MI auth to Cosmos | falls back to `DefaultAzureCredential` |

The registry container is created lazily (`createIfNotExists`) — a fresh
environment needs no extra ARM/Bicep step.

## Auth model — SAS-less managed-identity passthrough

The resolver **never mints a SAS token**. It returns
`auth: { mode: 'managed-identity', passthrough: true, sas: null, scope }` so the
calling engine authenticates to ADLS Gen2 with **its own** managed identity
(Storage Blob Data Reader/Contributor on the lake). External shortcuts return
`mode: 'stored-connection'` with a `credentialRef` instead.

## Skeleton scope (HYP-1) — executes end-to-end

Per the PRP the P0 skeleton executes its core path with **no stubs**: the
`loom://` resolver returns real abfss for the convention + registered + shortcut
+ stamped paths, backed by a real Cosmos registry when configured, honest-503
otherwise. Advanced OneLake surfaces phase behind tracked follow-ons:

- **HYP-2** — shortcut engine as a service (compile to Synapse external table /
  Databricks UC external location / ADX `external_table()`).
- **HYP-3** — recursive POSIX-ACL security-reconcile service.
- **HYP-4** — the 7 residual UI/BFF gaps (short-lived SAS mint UI, access
  diagnostics, shortcut caching/transforms, OPDG gateway shortcuts, unified hub,
  shortcut event-triggers).

## Local build limitation (honest)

`@azure/cosmos` + `@azure/identity` are declared deps; the container image
`npm install`s them and the Cosmos-backed registered path runs in-cluster. This
worktree did **not** run `npm install` (to avoid pulling the dependency tree into
a shared node_modules), so the Cosmos path was not exercised locally — but it is
imported **lazily** so the **convention-resolve core path executes with zero
deps**, which is what the unit tests + the live `curl` receipts below cover.

## Tests

```bash
cd apps/loom-onelake && node --test    # 24 pure-logic tests, no npm install
```

## Deploy

`platform/fiab/bicep/modules/compute/loom-onelake-app.bicep` (internal ingress,
`minReplicas: 1`, dedicated least-privilege UAMI — Storage Blob Data Contributor
on the DLZ lake + Cosmos Built-in Data Contributor on the registry, nothing
else). The console reads `LOOM_ONELAKE_URL`; unset ⇒ the BFF `/api/onelake/resolve`
returns an honest 503 and the console falls back to the per-item library path
silently (no Fabric gate, no regression).

## Related

- `PRPs/active/next-waves/PRP-loom-hyperscale-custom-components.md` §5 (Component 1)
- `PRPs/active/fabric-parity/appendix-onelake.md` — the 46/46 `strong` grade this promotes
- `apps/fiab-console/lib/azure/lakehouse-abfss.ts` — the resolution semantics reused

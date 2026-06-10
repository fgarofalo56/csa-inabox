# rayfin-app — parity with Microsoft Fabric Apps (Rayfin)

Source UI: https://learn.microsoft.com/fabric/apps/overview ·
https://learn.microsoft.com/fabric/apps/data-apps-template (Build 2026 preview)

Fabric Apps (Rayfin) is a code-first BaaS for Fabric. Two app shapes ship:
the **app backend** (define entities → generated SQL DB + GraphQL Data APIs +
auth + storage + static hosting), and the **data app** (`--template dataapp`):
an analytical app that **binds to an existing semantic model** and queries it
with DAX via the Execute DAX Queries API instead of defining its own schema.

The Rayfin CLI runs on the developer's machine, so Loom authors the spec +
binding and emits the real SDK model, the typed data-access client, and the
exact CLI sequence (the no-vaporware "generate artifact" pattern, like the
deploy planner emitting bicep) — plus a **live DAX probe** so the binding is
proven against a real backend before `npx rayfin up`.

## Fabric feature inventory (grounded in Learn)

| # | Capability (Fabric / Rayfin) | Where |
|---|------------------------------|-------|
| 1 | Define entities with field decorators (`@entity`/`@text`/`@uuid`/`@date`/…) | data-models |
| 2 | Toggle services: database, storage, Fabric (Entra SSO) auth, static hosting | overview / project-structure |
| 3 | Scaffold: `npm create @microsoft/rayfin@latest <app> --workspace <ws>` | create-app |
| 4 | Init + deploy: `npx rayfin init --services … --auth-methods …`, `npx rayfin up` | overview |
| 5 | **Data app: bind to an existing semantic model** (`--template dataapp`) | data-apps-template |
| 6 | **Data app: pick the model via its share link (workspace + model id)** | data-apps-template |
| 7 | **Data app: query the model with DAX (Execute DAX Queries API)** | data-apps-template |
| 8 | **Data app: typed RayfinClient data-access over the model** | read-write-data-graphql |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | Entities + text/boolean/date/number fields → `@entity` model.ts (App backend tab). |
| 2 | built ✅ | Database/storage/static-hosting switches + Fabric (Entra SSO) auth. |
| 3 | built ✅ | Generated `npm create @microsoft/rayfin@latest` command (Copy). |
| 4 | built ✅ | Generated `rayfin init` + `rayfin up` sequence (Copy). |
| 5 | built ✅ | **Data app tab** — model picker backed by a real list (`GET …/bind-model`). |
| 6 | built ✅ | Loom-native + AAS + (opt-in) Power BI models; share-link emitted in the scaffold. |
| 7 | built ✅ | **Live DAX probe** (`POST …/bind-model`) runs EVALUATE against the bound model. |
| 8 | built ✅ | Generated `src/data/model.ts` typed `RayfinClient` client + saved named queries. |

Zero ❌, zero stub banners. The only non-functional state is the **honest probe
gate**: when no Azure Analysis Services server is configured (and no Power BI
workspace is passed), the live DAX probe returns `200 { probeUnavailable }` with
a MessageBar naming `LOOM_AAS_SERVER_NAME` / `LOOM_AAS_REGION` — the binding,
scaffold, and generated client still work.

## Backend per control

| Control | Backend (Azure-native DEFAULT) | Opt-in alternative |
|---------|--------------------------------|--------------------|
| Model picker list | Loom-native semantic-model items (Cosmos) + AAS databases (ARM `listDatabases`) | Power BI/Fabric datasets (`listDatasets`, only when `?workspaceId=` passed) |
| Run DAX (live probe) | AAS XMLA `/query` (`executeDaxQuery`) on the env-pinned server | Power BI `executeQueries` (when workspace + live dataset) |
| Save binding | Cosmos `state.modelBinding` (merged with `state.spec`) | — |
| Generated artifacts | Pure client-side codegen from the binding | — |

## No-Fabric-dependency

The model list and DAX probe both run with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET: Loom-native models come from Cosmos and DAX runs over Azure Analysis
Services (a standalone Azure resource). Power BI / Fabric datasets are reachable
**only** when the operator explicitly passes a `workspaceId` — never on the
default path.

## Bicep sync

No new infrastructure. The feature reuses the already-deployed Azure Analysis
Services server and the `LOOM_AAS_SERVER_NAME` / `LOOM_AAS_REGION` env vars
already wired into the Console app in
`platform/fiab/bicep/modules/admin-plane/main.bicep` (the Console UAMI already
holds the AAS server-administrator role via `aas-server.bicep`). Cosmos is the
existing items container.

# Rayfin app (Fabric Apps) in CSA Loom

**Preview.** Rayfin is Microsoft's open-source **Backend-as-a-Service for Microsoft Fabric** (announced at Build 2026). You define an app's data model, auth, APIs, storage, and business logic in TypeScript with the `@microsoft/rayfin-core` decorators, then `npx rayfin up` deploys the backend to your Fabric workspace as a **Rayfin item** — app data lands in **OneLake** (no copy/ETL) and inherits your tenant's Entra identity, security, and governance.

- Docs: <https://learn.microsoft.com/fabric/apps/overview>
- Repo: <https://github.com/microsoft/rayfin> · Templates: <https://github.com/microsoft/awesome-rayfin>
- CLI: `@microsoft/rayfin-cli` · SDK: `@microsoft/rayfin-core` / `-client` / `-data` / `-auth` / `-storage` / `-functions`

## What Loom does

The Rayfin CLI runs on the **developer's machine**, so Loom doesn't deploy it server-side. Instead, the **Rayfin app** item type (New item → *Fabric Apps*) lets you **author the backend spec** — entities + fields, services (database/storage), Fabric Entra auth, static hosting — and Loom **generates**:

1. `rayfin/model.ts` using the real `@microsoft/rayfin-core` decorators (`@entity`, `@text`, `@boolean`, `@date`, `@number`).
2. The exact **CLI command sequence** to scaffold + deploy.

The spec persists on the Cosmos item, so it round-trips. (Same honest pattern as the Deployment planner generating bicep.)

## Model binding — back an app with a real semantic model (Build 2026 #28)

The **Model binding** tab binds the app to a real semantic model so it renders live data. The Azure-native **default** backend is **Azure Analysis Services** — no Fabric or Power BI workspace required (per the no-Fabric-dependency rule). Loom lists bindable models (ARM), introspects their measures/columns (DAX `INFO.*`/DMV over XMLA), lets you compose a read view (measures + group-by), runs a **live DAX preview**, and emits a typed `rayfin/data/model-view.ts` connector with the exact validated DAX. When AAS env vars are unset the tab shows an honest gate naming `LOOM_AAS_SERVER_NAME`.

## App builder — low-code visual app (audit-T145)

The **App builder** tab is a Loom-native low-code surface for assembling a real app over the bound model:

- **Pages** you add / rename / delete, each holding **components** chosen from a palette — **Table**, **Metric**, **Chart**, **Form**, **Text**.
- **Data components** (table/metric/chart) bind to the model's measures + group-by; a **Scaffold wizard** turns a chosen measure + category into a starter Overview page.
- **Run app preview** is a real **runtime**: it POSTs the app definition to `/api/items/rayfin-app/<id>/render`, which executes every component's read view live over XMLA and renders the rows as a metric card, CSS bar chart, or data grid — the actual data the deployed app would show.
- Loom emits a typed **`rayfin/app.config.ts`** (pages → components → DAX) the deployed Rayfin app's UI layer consumes.

The whole app definition persists on the Cosmos item (`state.spec.app`).

**Standalone, not Atelier.** This visual builder lives in the Rayfin/Fabric-Apps surface itself rather than under Weave/Atelier: the Azure-native build has no separate Atelier item type, and the real Fabric-Apps `--template dataapp` flow is code-first + GitHub Copilot codegen (not a WYSIWYG canvas), so a Loom-hosted visual builder with a real Azure runtime is the honest home. Write-back forms run in the **deployed** app (the Rayfin runtime on the dev machine), not inside Loom — Loom previews their layout and reads live data for the data components.

## Deploy workflow

```bash
# 1) Scaffold the app (binds a Fabric workspace)
npm create @microsoft/rayfin@latest <app> --workspace "<workspace name>"
cd <app>

# 2) …or initialize Rayfin in an existing project with the chosen services
npx rayfin init <app> --services db,storage --auth-methods fabric --static-hosting

# 3) Paste the generated entities into rayfin/model.ts, then deploy to Fabric
npx rayfin up
```

`rayfin up` generates + applies the **DAB** configuration to the Rayfin item workload endpoint, builds/deploys static content, and records the Fabric deployment. Use `rayfin env` to emit `.env.local` values and `rayfin login` to sign in.

> Decorator/CLI surfaces are **preview** and can change — verify generated artifacts against the current `@microsoft/rayfin-core` / `@microsoft/rayfin-cli` versions.

## Why it fits Loom

A deployed Rayfin app is a first-class Fabric item whose data lives in OneLake, so it shows up in the OneLake catalog and is governed alongside your lakehouses, warehouses, and pipelines — the same unified data + compliance layer the rest of Loom rides on.

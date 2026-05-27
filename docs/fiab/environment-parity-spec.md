# Loom Environment Editor — Fabric-parity build spec

> Reference: Microsoft Learn — *Create, configure, and use an environment in Fabric* (`/fabric/data-engineering/create-and-use-environment`), *Spark compute configuration settings in Fabric environments* (`/fabric/data-engineering/environment-manage-compute`), *Manage libraries in Fabric environments* (`/fabric/data-engineering/environment-manage-library`), *Manage the environment through public APIs* (`/fabric/data-engineering/environment-public-api`). Documented 2026-05-26 by catalog agent.

## Overview

A Fabric **Environment** is a shareable Spark configuration item under the Data Engineering workload. It bundles three things — **Spark compute** (runtime + pool + driver/executor sizing), **Libraries** (PyPI/Conda public + custom `.whl`/`.jar`/`.tar.gz`/`.py`), and **Resources** (small files like config JSON, sample data) — and is then attachable to notebooks and Spark Job Definitions as their session backing. One Environment, many consumers. The workspace itself can also pick an Environment as its default for any item that uses `Workspace default`.

Environments have an explicit **publish lifecycle**: edits accumulate in staging, then the user clicks **Publish** to bake them into a runtime snapshot used by new sessions. Two publish modes: **Quick** (~5s, libs install at session start, notebooks only) vs **Full** (3–6 min, baked snapshot, works for SJDs and pipelines; can pair with a custom live pool for 5-second cold starts).

The item is created from **New item → Environment** in a workspace. It opens with a left-rail navigation (Home / Libraries / Resources) and a content pane.

## Fabric Environment UX inventory

### Page chrome
- Page title shows the Environment name (editable inline) · staging-vs-published status chip (`Draft` / `Publishing…` / `Published`)
- Standard workspace breadcrumb, capacity badge, global action bar
- Top-right: **Publish** (primary), **Save**, **Cancel publish** (when publishing in progress), **Share**, **Comments**

### Left-rail tabs
| Tab | Purpose |
|---|---|
| **Home** | Runtime version dropdown · publishing status · summary cards |
| **Compute** | Pool selector + per-session driver/executor tuning |
| **Libraries** → **External repositories** | PyPI / Conda / private pip / Azure Artifact Feed / Maven |
| **Libraries** → **Custom libraries** | Local upload of `.whl` / `.py` / `.jar` / `.tar.gz` |
| **Spark properties** | Free-form key/value Spark conf overrides |
| **Resources** | Small file uploader (config JSON, sample CSV) — real-time, no publish needed |

### Home tab
- **Runtime** dropdown — e.g. `Runtime 1.3 (Spark 3.5, Delta 3.2, Python 3.11)`, `Runtime 1.2`, `Runtime 1.1`. Each carries default preinstalled packages.
- Banner: "Runtime changes don't take effect until you Save and Publish."
- Summary cards: total libraries, custom JAR count, last publish timestamp, last publish duration, default-environment chip if set workspace-default.

### Compute tab
| Control | Source |
|---|---|
| **Environment pool** dropdown | Starter pool + any custom pools created by workspace admin |
| **Spark driver cores** dropdown | Allowed values depend on selected pool's node size |
| **Spark driver memory** dropdown | Same |
| **Spark executor cores** dropdown | Same |
| **Spark executor memory** dropdown | Same |
| **Dynamic allocation** toggle | If pool supports it: min/max executor inputs |
| **Session timeout** input | Minutes (default 20) |

Gated by a workspace-admin setting **Customize compute configurations for items** — if off, this tab is read-only and shows a MessageBar pointing at workspace settings.

### Libraries — External repositories tab
| Action | Behavior |
|---|---|
| **Add library** → **From public repository** | Source picker (PyPI / Conda / Maven). Library search-as-you-type. Version dropdown. Publish-mode toggle (Full / Quick). |
| **Add library** → **From private repository** | pip / conda / Azure Artifact Feed connection picker. Quick mode unsupported. |
| **Import pom.xml** | Maven dependencies bulk import (Spark 4.0+ only, Full mode only). |
| **Import environment.yml** | Bulk import a conda/pip spec file. |
| **YML editor view** toggle | Edit the underlying `environment.yml` directly. |
| **Filter / Update / Delete / View Dependencies / Export to .yml** | Per-row management. |

### Libraries — Custom libraries tab
- **Upload** — accepts `.whl`, `.py`, `.jar`, `.tar.gz` (200 MB per file via public API)
- **Download** — pull a library back to local
- Per-row delete
- File-type validation banner ("R requires .tar.gz; Python requires .whl/.py")

### Spark properties tab
- **DataGrid** of key/value pairs (Add row, Delete row)
- Example presets: `spark.sql.shuffle.partitions`, `spark.sql.adaptive.enabled`, `spark.driver.maxResultSize`
- Banner distinguishing from `spark.conf.set` runtime overrides

### Resources tab
- Folder tree (mkdir, rename, delete)
- File uploader — small files (typically <50 MB)
- Right-side preview pane for text files
- Banner: "Resource changes are real-time and don't require Publish."

### Publish lifecycle
| Stage | Behavior |
|---|---|
| **Save** | Persists staging changes; not yet effective in sessions. |
| **Publish** | Locks staging into a runtime snapshot. Quick mode: ~5s. Full mode: 3–6 min. Background long-running operation; user can navigate away. |
| **Cancel publish** | Available during publish; rolls back. |
| **Published** | Banner with last-publish timestamp, dependency tree viewer. |

### Attachment surfaces (downstream)
- Notebook ribbon **Environment** dropdown — `Workspace default` · any environment shared with you · `+ New environment`
- SJD body — **Environment** dropdown (same)
- Workspace settings → Data Engineering/Science → **Default environment** toggle (admin only)

---

## What Loom has today

Loom's `EnvironmentEditor` (`apps/fiab-console/lib/editors/phase2-misc-editors.tsx` line 347) is **D-grade** — renders but covers only a fraction of the surface:

- Four tabs: **Requirements (PyPI)** · **Spark conf** · **Custom JARs** · **Apply to pool**
- **Requirements**: single textarea, free-form `requirements.txt`
- **Spark conf**: raw JSON textarea (key/value object)
- **Custom JARs**: textarea, one ABFSS URI per line
- **Apply to pool**: Synapse Spark Pool dropdown + a button that PUTs the merged spec onto the pool's `libraryRequirements` / `sparkConfigProperties` / `customLibraries` ARM properties
- Buttons: **Save environment**, **Apply to pool**
- Backend: Cosmos persistence for `{requirements, conf, jars}` on the item. Apply flow reads/writes the Synapse pool via existing `/api/items/synapse-spark-pool/[id]` PUT.

Critically missing: no runtime picker, no compute sizing controls, no public-repo search, no custom-library upload (just URI references), no resources tab, no publish-mode toggle, no per-pool-aware control validation, no attachment side ("which notebooks/SJDs use this?").

## Gaps for parity

1. **Runtime picker** — add Home tab with `Runtime 1.3 / 1.2 / 1.1` dropdown. Persist `state.runtime`. Surface preinstalled package set somewhere.
2. **Compute tab** — driver cores, driver memory, executor cores, executor memory, dynamic allocation toggle, session timeout. Values constrained by selected pool. Workspace-admin gate honored via a MessageBar.
3. **Public-repo library add** — PyPI/Conda search-as-you-type with version dropdown. Today users hand-edit `requirements.txt`.
4. **Custom-library upload** — currently Loom only accepts ABFSS URIs. Add a real multipart upload `POST .../[id]/libraries/custom` that writes to ADLS Gen2 and records the path. Accept `.whl`, `.py`, `.jar`, `.tar.gz`.
5. **YML editor view toggle** — let advanced users edit `environment.yml` directly.
6. **Import `environment.yml` / `pom.xml`** — file-pickers that bulk-import to the requirements/Maven lists.
7. **Resources tab** — folder tree + file uploader for small config/sample files. Persist to ADLS `env/{itemId}/resources/...`. Mount at session start.
8. **Spark properties as DataGrid** — replace raw JSON textarea with a typed key/value editor with autocomplete on known Spark properties.
9. **Publish lifecycle** — Loom has no concept of staging vs published. Add `state.staging` and `state.published` sub-docs, a **Publish** button that snapshots staging→published, and a Quick/Full mode toggle. Track publish progress via long-running operation (LRO).
10. **Cancel publish** — companion to the publish LRO.
11. **Attachment dropdown wiring** — notebook editor and SJD editor must consume `Environment` items from Loom's catalog (currently neither editor has an Environment selector). On submit/run, fetch the Environment's published snapshot and merge into the session.
12. **Workspace-default environment** — Workspace settings page needs a `Default environment` toggle that sets `workspace.state.defaultEnvironmentId`.
13. **Dependency tree viewer** — fetch transitive deps for a public lib (call PyPI/Conda search API) and render a collapsible tree.
14. **Per-row library management** — Update / Delete / View Dependencies / Export to .yml. Today: only bulk textarea edit.
15. **Filter / search** within the library list.
16. **Apply-to-pool flow** — currently this is the editor's only real action. In Fabric, an Environment isn't applied to a pool — it's attached to a notebook/SJD which then picks up the libs via a session-level overlay. Keep the existing apply-to-Synapse-pool flow as a **separate legacy action** behind a MessageBar warning, and make the real attachment flow primary.

## Backend mapping

| Fabric concept | Loom backend |
|---|---|
| Create environment item | ✅ `/api/items/environment` (Cosmos CRUD via the standard item-crud lib) |
| Get / Update environment definition | ✅ `/api/items/environment/[id]` GET / PUT |
| Spark compute settings | **NEW** persist `state.compute = { runtime, poolId, driverCores, driverMemory, executorCores, executorMemory, dynamicAllocation, sessionTimeout }`. Pool-aware validation reads pool node size from `/api/items/synapse-spark-pool/[id]`. |
| Public library add | **NEW** `POST .../[id]/libraries/public` body `{ source: 'pypi'|'conda', name, version, mode: 'quick'|'full' }`. Persist into `state.staging.libraries.external[]`. |
| Custom library upload | **NEW** `POST .../[id]/libraries/custom` multipart. Writes to ADLS at `env/{itemId}/libs/{filename}`. Adds to `state.staging.libraries.custom[]`. |
| Import environment.yml | **NEW** `POST .../[id]/libraries/import-yml` — parses + merges into staging. |
| Resources upload | **NEW** `POST .../[id]/resources` multipart → ADLS `env/{itemId}/resources/<path>`. |
| Publish | **NEW** `POST .../[id]/publish` body `{ mode: 'quick'|'full' }`. Quick: copy staging→published synchronously. Full: kick a worker (Function or run-orchestrator) that pre-resolves deps via `pip download` into a Conda env, packs a snapshot, stores under `env/{itemId}/snapshots/{publishId}/`, then atomically updates `state.published`. Returns LRO id. |
| Cancel publish | **NEW** `POST .../[id]/publish/cancel`. |
| Get publish status | **NEW** `GET .../[id]/publish/{operationId}` → `{ status, percent, message }`. |
| Notebook/SJD attach | **EXTEND** `/api/items/notebook` and `/api/items/spark-job-definition` to accept `state.environmentId`. At submit, server-side fetches the env's `state.published` and merges into the Livy/Databricks session conf + jars + pyFiles. |
| Workspace default environment | **EXTEND** `/api/workspaces/[id]` PUT to accept `defaultEnvironmentId`. |
| Apply-to-pool (legacy) | ✅ Existing flow — keep as-is, demote in UX. |

## Required Azure resources

- ✅ Synapse Workspace + Spark Pools (already in bicep)
- ✅ ADLS Gen2 storage account (already) — needs a `env/` virtual folder used for libs, resources, and snapshots
- ✅ Loom Cosmos `items` container (already)
- **NEW** Azure Function App or extension to the run-orchestrator for the **Publish (Full mode)** worker — performs `pip download` + dependency resolution + snapshot pack. Needs outbound to PyPI/Conda or, in Gov, an Azure Artifact Feed mirror.
- **NEW** Cosmos sub-document `state.staging` + `state.published` on each environment item (just a JSON shape change, no new container)
- **Optional** Azure Artifact Feed (for private-pip support in Gov environments without public PyPI egress)

## Estimated effort

**3 focused sessions.**

- **Session 1 (~2.5h):** Backend — public library add, custom library upload, resources upload, environment.yml import, publish LRO scaffold (Quick mode synchronous, Full mode worker stub), Cosmos schema migration to `staging`/`published`.
- **Session 2 (~3h):** Frontend rebuild — Home (runtime picker + status), Compute tab (pool-aware sizing), Libraries → External repositories (search + per-row mgmt), Libraries → Custom libraries (upload + grid), Spark properties (DataGrid), Resources (folder tree). Keep the legacy Apply-to-pool tab behind a "Legacy" badge.
- **Session 3 (~2h):** Publish worker (Full mode `pip download` + snapshot pack) · attachment wiring (notebook + SJD pick this env and merge at submit) · workspace-default toggle · UAT harness coverage · A11y audit.

Drops Loom Environment from **D** (renders, partially functional) to **A** (real publish lifecycle, real library management, real downstream attachment).

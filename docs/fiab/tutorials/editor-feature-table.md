# Tutorial: Feature table editor

> CSA Loom `feature-table` editor — a first-class **Feature Store** surface:
> Unity Catalog feature tables offline, **Lakebase / pgvector** online, with
> point-in-time joins and feature lookup at inference. One-for-one with the
> Databricks *Feature Engineering* experience, Loom-themed and sovereign — the
> Azure-native default is Databricks UC; Gov uses **OSS Unity Catalog + Azure
> Database for PostgreSQL**. **No Microsoft Fabric.**

## What it is

A feature store solves two hard problems: *training/serving skew* and *feature
reuse*. This editor gives you both halves:

- **Offline** — a versioned feature table (Delta on Unity Catalog, or PostgreSQL
  on the sovereign path) with entity keys and a timestamp key, joined onto
  training spines **as-of** the label time so a model never sees the future.
- **Online** — the same features published to a low-latency store (Lakebase /
  pgvector) and looked up by entity key at inference time, then merged into the
  scoring payload for a model-serving endpoint.

Four tabs: **Overview**, **Define**, **Point-in-time join**, **Online serving**
(the last two unlock once the table is defined).

## When to use it

- Multiple models need the same features and you want one definition, one
  refresh, one lineage.
- You need training data assembled correctly as-of each label's timestamp.
- You need those same features available at inference in milliseconds.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Feature table**, then **Create feature
   table item**. The header badges state the active backend — *Unity Catalog
   feature tables* (Azure-native default) or *OSS Unity Catalog + PostgreSQL*
   (sovereign / Gov path) — plus *Online: Lakebase / pgvector*, and a `defined`
   badge once a spec exists. The right **Details** panel summarizes the table,
   offline backend, entity keys, timestamp key, feature count, and online table.
2. **Define the feature table.** On **Define** fill in:
   - **Catalog** / **Schema** / **Table** — pre-filled with the deployment's
     defaults where available; together they compose the three-part full name.
   - **Entity (primary) keys** — comma-separated (for example `customer_id`).
   - **Timestamp key** — the event-time column (for example `event_ts`).
   - **Feature columns** — **Add feature** rows, each a name plus a type from
     `DOUBLE`, `FLOAT`, `BIGINT`, `INT`, `STRING`, `BOOLEAN`, `TIMESTAMP`,
     `DATE`.

   **Create feature table** creates the **real** offline table (Delta or
   PostgreSQL) *and* the online table, then persists the spec. The button
   becomes **Update feature table** afterwards.
3. **Build a training set with a point-in-time join.** On **Point-in-time
   join**:
   - **Spine / training table** — your labels table.
   - **Spine entity keys** — comma-separated, aligned to the feature keys
     (pre-filled from the spec).
   - **Spine timestamp key** — the label time.
   - **Carry columns** — the label columns to carry through.
   - **Row limit** — defaults to 1000.

   **Preview SQL** shows the generated AS-OF join without running it. **Run
   join** executes it and returns real, type-badged rows with a row count and
   execution time.
4. **Publish to the online store.** On **Online serving**, **Publish latest
   features** materializes the current offline rows into the online table and
   reports how many entity rows were published (or states honestly that there
   are no offline rows yet and the online table is ready).
5. **Look up features and score a model.** Still on **Online serving**:
   - **Serving endpoint** — the model-serving endpoint name (for example
     `fraud-scorer`).
   - One input per **entity key** — the identity to look up.
   - **Scoring payload (JSON)** — the request body; the looked-up features are
     **merged in** before it is sent.

   **Look up + invoke** performs the online lookup and calls the endpoint,
   returning the resolved features, the HTTP status, the end-to-end latency, and
   the model's response body.
6. **Reload.** **Reload** in the ribbon re-reads the spec, backend, and gate
   state.

## The Azure backend it rides on

- **Offline store (default):** **Databricks Unity Catalog** feature tables on
  Delta.
- **Offline store (sovereign / Gov):** **OSS Unity Catalog + Azure Database for
  PostgreSQL**.
- **Online store:** **Lakebase / pgvector** for low-latency key lookups.
- **Serving:** a Loom **model-serving endpoint** (see
  `editor-model-serving-endpoint.md`).
- **Routes:** `GET/POST /api/items/feature-table/<id>`, `…/pit-join`,
  `…/online`, `…/serve` — every control calls a real BFF route; there are no
  mocks and no dead buttons.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| Offline backend not configured | The shared Fix-it gate (`svc-feature-store`) with the exact missing variable and a hint; the Define form's inputs are disabled but the surface still renders — no red banner on a fresh item | Set the env var the gate names, using its inline **Fix it** wizard |
| Online store not configured | A separate online gate; **Publish** and **Look up + invoke** are disabled | Set the online-store variable the gate names |
| Table not defined yet | **Point-in-time join** and **Online serving** tabs are disabled | Define the feature table first |
| Nothing published yet | Publish reports *"No offline rows to publish yet"* and names the ready online table | Land offline feature rows, then publish again |

## No Fabric required

Databricks UC (or OSS UC + Azure Database for PostgreSQL) plus Lakebase /
pgvector. No Fabric capacity, workspace, OneLake path, or Power BI workspace is
used on any path.

## Learn more

- Model serving endpoint editor tutorial: `editor-model-serving-endpoint.md`
- ML model editor tutorial: `editor-ml-model.md`
- Parity source: `docs/fiab/parity/feature-store.md`

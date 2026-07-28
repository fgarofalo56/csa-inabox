# Tutorial: Activation sync editor

> CSA Loom `activation-sync` editor — **reverse ETL**. Push a modeled lake table,
> model, or audience *out* to your operational systems: **Dataverse / Dynamics**
> first, plus a **webhook**, an **Event Grid** custom topic, or a **Service Bus**
> queue/topic. Full or **incremental via Delta Change Data Feed**, with idempotent
> upserts and a real run history. Azure-native — **no Microsoft Fabric**.

## What it is

Everything else in Loom brings data *in* and models it. An activation sync sends
the modeled result back *out* to the systems people actually work in — so the
segment your analysts built in the lake becomes rows a salesperson sees in
Dynamics, or an event another service can react to.

Every configuration surface is a dropdown or picker: the source is **browsed**
from the lake, the Dataverse destination is picked from **live** environments and
tables, and field mappings pick real source columns against real destination
fields. There is no free-typed JSON.

Two tabs: **Settings** and **Runs**.

## When to use it

- Push a scored / segmented lake table into Dataverse so CRM users act on it.
- Emit modeled rows to Event Grid or Service Bus for another in-boundary service.
- Call an internal webhook when a modeled dataset changes.
- If you want data *into* the lake, use a pipeline, copy job, or mirrored
  database instead.

## Step-by-step in Loom

1. **Create the item.** **+ New item → Activation sync**, then **Create
   activation sync**. An unconfigured item opens with a guided three-path empty
   state — *pick a source*, *pick a destination*, *map fields* — never a red
   banner.
2. **Pick the source.** In **Source**, choose the **Source kind** (`Table`,
   `Model`, or `Audience / segment`), then a lake **Container**. A breadcrumb
   folder browser lists real ADLS paths; drill in and click **Use as source
   table**. The selection is echoed back as `container/path`.
3. **Pick the destination.** In **Destination**, choose one of:
   - **Dataverse / Dynamics** — pick an **Environment** and a **Table** from live
     Power Platform lists.
   - **Webhook** — an `https` URL (validated as https).
   - **Event Grid** — a custom topic endpoint.
   - **Service Bus** — a namespace plus a queue or topic name.
4. **Map fields and set the key.** In **Mapping & key**:
   - **Key column** — the source column that fills the destination key, which is
     what makes upserts idempotent.
   - **Dataverse key attribute** — for Dataverse, the alternate key or primary
     column on the target table (picked from that table's real field list).
   - **Field mapping** — **Add mapping** rows pairing a real source column with a
     real destination field. For non-Dataverse destinations the target mirrors
     the source name; with **no** mappings at all, every source column is sent
     as-is, so mappings are for renaming or selecting a subset.
5. **Choose the sync mode.** In **Sync mode**:
   - **Full** — read and push the whole source on every run.
   - **Incremental** — push only rows changed since the last run using **Delta
     Change Data Feed**. This requires `delta.enableChangeDataFeed` on the source
     table. The last synced Delta version is displayed once a run has completed.
6. **Save, then run.** **Save** persists the spec. **Run full** or **Run
   incremental** persists the latest config first, then executes; the result
   toast reports upserts, deletes, and errors, and the view switches to **Runs**.
7. **Schedule it by data change, not by clock.** Activation syncs deliberately
   have **no separate scheduler**. Click **Bind data-change trigger** to bind an
   activation-sync materializer to the source software-defined asset — a new
   Delta commit on the source then runs this sync incrementally, automatically.
   **Open Assets** jumps to the Assets canvas. A failed run raises an alert
   through the platform alert convention.
8. **Read the run history.** The **Runs** tab is a real, persisted table: started,
   mode, status, rows read, upserts, deletes, errors, the Delta version range
   (`from→to`), and a detail column.

## The Azure backend it rides on

- **Source read:** your own **ADLS Gen2** Delta tables, read on the in-boundary
  **DuckDB** tier; browsing uses the shared dataset browse route.
- **Dataverse destination:** the estate's already-wired **S2S app** against the
  Power Platform / Dataverse Web API (`/api/powerplatform/environments`,
  `/api/powerplatform/tables`).
- **Other destinations:** **Azure Event Grid** custom topic, **Azure Service
  Bus** queue/topic, or an HTTPS webhook.
- **Incremental engine:** **Delta Change Data Feed** on the source table.
- **Scheduling:** Loom's software-defined-asset triggers (the Assets canvas).
- **Persistence:** the item's own state, including the run history and the last
  synced Delta version.

## Honest gates

| Condition | What you see | Exact remediation |
|---|---|---|
| Lake not reachable | Warning MessageBar *"Lake not reachable"* carrying the browse route's remediation text | Apply the remediation the gate names (storage env var / data-plane grant) |
| Dataverse not reachable | Warning MessageBar *"Dataverse not reachable"* naming the missing variable (for example `LOOM_UAMI_CLIENT_ID`) | Set the named variable / complete the Dataverse S2S app-user grant |
| Source or destination incomplete | **Run full** / **Run incremental** stay disabled with the tooltip *"Pick a source and destination first"* | Finish Source + Destination (Dataverse also needs environment + table) |
| Incremental on a table without CDF | The run reports the error honestly | Set `delta.enableChangeDataFeed = true` on the source Delta table |
| Public SaaS webhook in IL5 | Honest-gated by reachability; in-boundary endpoints run air-gapped | Use an in-boundary endpoint, or open the egress path deliberately |
| `n7c-activation-sync` flag off | Warning MessageBar; the API routes, existing items, and the asset-trigger binding keep working | Re-enable the flag in **Admin → Runtime flags** |

## No Fabric required

ADLS Gen2 + DuckDB + Dataverse/Event Grid/Service Bus. No Fabric capacity,
workspace, OneLake path, or Power BI workspace is used on any path.

## Learn more

- Assets canvas / software-defined assets and their triggers
- Dataverse table editor tutorial: `editor-dataverse-table.md`
- Parity source: `docs/fiab/parity/activation-sync.md`
- Delta Change Data Feed:
  <https://learn.microsoft.com/azure/databricks/delta/delta-change-data-feed>
- Dataverse Web API upsert:
  <https://learn.microsoft.com/power-apps/developer/data-platform/webapi/update-delete-entities-using-web-api#upsert-a-record>

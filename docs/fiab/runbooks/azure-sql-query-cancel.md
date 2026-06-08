# Runbook — Azure SQL query cancel / background continuation

How the Loom Azure SQL Query editor cancels a running query and lets a query
keep running after the tab is switched/closed, plus the one infra knob that
matters in a scaled-out console.

## What the feature does

The **Run** button in the Azure SQL / SQL MI / PostgreSQL Query tab now runs the
query through the module-scope `jobsStore.startSqlQuery()` action instead of an
inline `await fetch`. Because the fetch lives outside the React component:

- **Background continuation** — closing or switching away from the editor tab
  does **not** abort the query. When it finishes, `GlobalJobToaster` (mounted in
  AppShell) raises a Fluent toast naming the database and the row count / exec-ms
  (or the error). Returning to the editor recovers the result from the store.
- **Cancel** — a **Cancel** button appears while a query is in flight. It POSTs
  `{ requestId }` to `/api/items/azure-sql-database/[id]/query/cancel`.

## How cancel reaches the server (TDS ATTENTION)

1. The client generates `requestId = crypto.randomUUID()` and sends it in the
   `/query` POST body.
2. `executeQuery(server, db, sql, { requestId })` registers the live
   `mssql.Request` in the module-scope `liveRequests` map **before** calling
   `request.query()`.
3. The cancel route calls `liveRequests.get(requestId).cancel()`. `mssql`
   (tedious) issues `connection.cancel()`, which sends a **TDS ATTENTION**
   packet on the same connection.
4. SQL Server acknowledges (error **3617** / `SYS_ATTN`) and the in-flight
   `.query()` promise rejects with `RequestError('Canceled.', 'ECANCEL')`. The
   `/query` route's catch block surfaces this as
   `{ ok: false, error: 'Canceled.', code: 'ECANCEL' }` — that response is the
   "TDS reports cancellation" receipt.

## Verify (real-data receipt)

```sql
-- In the Query tab, run:
WAITFOR DELAY '00:00:30';
SELECT 1 AS after_wait;
```

- After ~5 s click **Cancel**. The grid shows the error `Canceled. · ECANCEL`
  within a second — the server stopped the query (it did not wait the full 30 s).
- Run the same query again, then switch to a different item tab. After 30 s a
  bottom-right toast fires: *"Query complete — &lt;server&gt; / &lt;db&gt; — 1 rows · ~30000 ms"*.

## Scaling note — the only infra knob

`liveRequests` is **in-process Node.js state on one Container App replica**, and
the `mssql` TDS connection is per-replica. With more than one console replica a
cancel POST must reach the **same** replica that started the query.

- **Default (single replica / dev / test):** nothing to do.
- **Scaled out:** enable ingress **sticky sessions** on the console Container App
  so the cancel POST is routed to the originating replica:

  ```bicep
  // platform/fiab/bicep/modules/container-apps/console.bicep
  // (or wherever the console containerApp resource is defined)
  properties: {
    configuration: {
      ingress: {
        // ...existing ingress config...
        stickySessions: {
          affinity: 'sticky'
        }
      }
    }
  }
  ```

There is **no new Azure resource, env var, role assignment, or Cosmos
container** for this feature — the cancel registry is purely in-process. The
cancel never reaches `api.fabric.microsoft.com` / `api.powerbi.com`; it is a
pure Azure SQL TDS protocol primitive and works identically in Commercial, GCC,
GCC-High, and DoD (only the SQL host suffix / ARM endpoint differ, set via
`LOOM_AZURE_SQL_HOST_SUFFIX` + `LOOM_ARM_ENDPOINT`).

## If cancel returns `{ cancelled: false }`

The route is idempotent: an unknown `requestId` returns
`{ ok: true, cancelled: false, reason: 'not found — already completed or on another replica' }`.
Causes:

- The query already finished (the `finally` in `executeQuery` removed the entry).
- A scaled-out console without sticky sessions routed the cancel to a different
  replica — enable `stickySessions.affinity: 'sticky'` (see above).

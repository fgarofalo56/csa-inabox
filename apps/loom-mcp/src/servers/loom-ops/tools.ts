/**
 * M4 `loom-ops` tools — the run/logs surface (PRP §4.2, §5.1). MIXED blast
 * radius: three read tools and two WRITE tools, on one server that opts into
 * mutations (`allowMutations: true`). The write path is the point of M4 — it
 * proves the shared core's non-`readOnly` gate:
 *
 *   • read  tools are `readOnly:true`, `minScope:'read-only'`;
 *   • write tools are `readOnly:false`, `minScope:'read-write'` — a `read-only`
 *     PAT is REFUSED by the core scope gate (§5.1 M4: "PAT read-only for
 *     run_start / run_cancel" is Never accepted), and per-item authorization is
 *     the BFF's job (the SDK calls the same route the browser does).
 *
 * Every tool keeps the core scrub (run input/output can carry connection
 * details) and the hashed-args audit.
 *
 * | tool             | SDK call                            | endpoint (via SDK)                                  | auth        |
 * |------------------|-------------------------------------|-----------------------------------------------------|-------------|
 * | loom.run.list    | client.runs.list(id, opts)          | GET  /api/items/{type}/{id}/runs                    | read-only   |
 * | loom.run.get     | client.runs.get(id, runId, opts)    | GET  /api/items/{type}/{id}/runs?runId=             | read-only   |
 * | loom.run.logs    | client.runs.logs(id, runId, opts)   | GET  /api/items/{type}/{id}/runs/{runId}/log        | read-only   |
 * | loom.run.start   | client.runs.start(id, opts)         | POST /api/items/{type}/{id}/run          (WRITE)    | read-write  |
 * | loom.run.cancel  | client.runs.cancel(id, runId, opts) | POST /api/items/{type}/{id}/runs/{runId}/cancel (W) | read-write  |
 */
import { z } from 'zod';
import type { ToolSpec } from '../../core/types.js';

/** The five M4 ops tools — three read, two write. */
export function opsTools(): ToolSpec[] {
  return [
    {
      name: 'loom.run.list',
      title: 'List runs for an item',
      description:
        'List recent runs/executions for a schedulable Loom item (pipeline, job, notebook, …), filtered to the bound ' +
        'target. Optional ISO window + status filter. Read-only; returns run summaries (status, timing) — no secrets.',
      inputSchema: {
        id: z.string().describe('Item id (GUID) of the schedulable item.'),
        type: z.string().optional().describe('Item type route (default adf-pipeline; also accepts data-pipeline, copy-job, dbt-job, databricks-job, …).'),
        after: z.string().optional().describe('ISO lower bound for the run window (default: last 7 days).'),
        before: z.string().optional().describe('ISO upper bound for the run window.'),
        status: z.string().optional().describe('Status filter, e.g. Succeeded | Failed | InProgress | Cancelled.'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const res = await auth.client.runs.list(String(args.id), {
          type: args.type as string | undefined,
          after: args.after as string | undefined,
          before: args.before as string | undefined,
          status: args.status as string | undefined,
        });
        return { data: res, count: Array.isArray(res.runs) ? res.runs.length : undefined };
      },
    },
    {
      name: 'loom.run.get',
      title: 'Get one run’s detail',
      description:
        'Fetch the per-activity receipts (status, timing, and owner-scoped input/output) for a single run id. ' +
        'Read-only. Ownership is enforced by the BFF; secrets in any receipt are scrubbed.',
      inputSchema: {
        id: z.string().describe('Item id (GUID) that owns the run.'),
        runId: z.string().describe('The run id to inspect.'),
        type: z.string().optional().describe('Item type route (default adf-pipeline).'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const res = await auth.client.runs.get(String(args.id), String(args.runId), { type: args.type as string | undefined });
        return { data: res, count: Array.isArray(res.activities) ? res.activities.length : undefined };
      },
    },
    {
      name: 'loom.run.logs',
      title: 'Read a run’s driver log',
      description:
        'Read a slice of a run’s driver log (Spark/AML stdout+stderr). Tail by advancing `from`. Read-only. ' +
        'Defaults to the notebook route; requires the owning workspaceId for the driver-log backends.',
      inputSchema: {
        id: z.string().describe('Item id (GUID) that owns the run.'),
        runId: z.string().describe('The run id whose driver log to read (e.g. spark:<pool>:<sessionId>).'),
        workspaceId: z.string().optional().describe('Owning workspace id (required by the notebook/spark driver-log route).'),
        type: z.string().optional().describe('Item type route (default notebook; also spark-job-definition, synapse-notebook).'),
        from: z.number().int().min(0).optional().describe('Line/byte offset to start from (tailing).'),
        size: z.number().int().min(1).max(1000).optional().describe('Max lines to return (route caps at 1000).'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const res = await auth.client.runs.logs(String(args.id), String(args.runId), {
          type: args.type as string | undefined,
          workspaceId: args.workspaceId as string | undefined,
          from: args.from as number | undefined,
          size: args.size as number | undefined,
        });
        return { data: res, count: Array.isArray(res.lines) ? res.lines.length : undefined };
      },
    },
    {
      name: 'loom.run.start',
      title: 'Start a run (WRITE)',
      description:
        'Trigger a run/execution of a schedulable Loom item. WRITE operation — requires a read-write scope; a ' +
        'read-only token is refused. The caller is authorized against the item by the Loom BFF (you may only ' +
        'start what you can already run interactively). Returns the bound target + backend run handle.',
      inputSchema: {
        id: z.string().describe('Item id (GUID) of the schedulable item to run.'),
        type: z.string().optional().describe('Item type route (default adf-pipeline; also data-pipeline, copy-job, dbt-job, …).'),
        params: z.record(z.unknown()).optional().describe('Optional run parameters passed to the backend pipeline/job.'),
      },
      readOnly: false,
      minScope: 'read-write',
      async run({ auth, args }) {
        const res = await auth.client.runs.start(String(args.id), {
          type: args.type as string | undefined,
          params: args.params as Record<string, unknown> | undefined,
        });
        return { data: res };
      },
    },
    {
      name: 'loom.run.cancel',
      title: 'Cancel an in-flight run (WRITE)',
      description:
        'Cancel an in-flight run/execution. WRITE operation — requires a read-write scope; a read-only token is ' +
        'refused. The caller is authorized against the item by the Loom BFF.',
      inputSchema: {
        id: z.string().describe('Item id (GUID) that owns the run.'),
        runId: z.string().describe('The in-flight run id to cancel.'),
        type: z.string().optional().describe('Item type route (default spark-job-definition; per-run cancel).'),
      },
      readOnly: false,
      minScope: 'read-write',
      async run({ auth, args }) {
        const res = await auth.client.runs.cancel(String(args.id), String(args.runId), { type: args.type as string | undefined });
        return { data: res };
      },
    },
  ];
}

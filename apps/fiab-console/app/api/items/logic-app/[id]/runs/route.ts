/**
 * GET /api/items/logic-app/[id]/runs?workspaceId=...[&runName=...][&top=N]
 *
 * Real workflow run history from the backing `Microsoft.Logic/workflows`
 * resource — the Loom equivalent of the Azure portal's "Runs history" blade.
 *
 *   without `runName` → the run LIST: id, status, start/end, duration, trigger,
 *                       error, and the correlation id.
 *   with    `runName` → that run's per-ACTION detail: every action's status,
 *                       timing, retry history and error, which is what makes a
 *                       failed run diagnosable rather than just red.
 *
 * AUTO-BIND: resolves/creates the backing workflow first, so history works on a
 * freshly created item (it simply comes back empty until the first run).
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/logic/workflow-runs/list
 *   https://learn.microsoft.com/rest/api/logic/workflow-run-actions/list
 *   https://learn.microsoft.com/azure/logic-apps/view-workflow-status-run-history
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { callLogicArm, LOGIC_API } from '@/lib/install/provisioners/logic-app';
import { ensureLogicAppBinding, workflowUrlFor } from '@/lib/logic-app/auto-bind';
import type { WdlDefinition } from '@/lib/logic-app/wdl-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RunRow {
  name?: string;
  properties?: {
    status?: string;
    startTime?: string;
    endTime?: string;
    correlation?: { clientTrackingId?: string };
    trigger?: { name?: string; status?: string };
    error?: { code?: string; message?: string };
  };
}

interface ActionRow {
  name?: string;
  properties?: {
    status?: string;
    startTime?: string;
    endTime?: string;
    code?: string;
    retryHistory?: unknown[];
    error?: { code?: string; message?: string };
  };
}

function durationMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.max(0, b - a);
}

function seedDefinition(state: any): WdlDefinition | null {
  if (state?.definition && typeof state.definition === 'object') return state.definition as WdlDefinition;
  const c = state?.content;
  if (c?.kind === 'logic-app' && c?.definition) return c.definition as WdlDefinition;
  return null;
}

export const GET = withWorkspaceOwner('logic-app', { allowReadRoles: true }, async (req: NextRequest, { item }) => {
  const state = (item.state as any) || {};
  const bind = await ensureLogicAppBinding(item, seedDefinition(state));
  if (!bind.ok) {
    return NextResponse.json({ ok: false, error: bind.gate.reason, gate: bind.gate }, { status: 503 });
  }

  const url = workflowUrlFor(bind.binding);
  const runName = req.nextUrl.searchParams.get('runName');
  const topRaw = Number(req.nextUrl.searchParams.get('top') || 25);
  const top = Number.isFinite(topRaw) ? Math.min(Math.max(Math.trunc(topRaw), 1), 100) : 25;

  // ── Per-run action detail ────────────────────────────────────────────────
  if (runName) {
    const r = await callLogicArm(
      `${url}/runs/${encodeURIComponent(runName)}/actions?api-version=${LOGIC_API}`,
    );
    if (!r.ok) {
      if (r.status === 404) return apiOk({ runName, actions: [], notFound: true });
      if (r.status === 401 || r.status === 403) {
        return NextResponse.json(
          {
            ok: false,
            error: `Not authorized to read run history (${r.status}).`,
            gate: {
              code: 'not-authorized' as const,
              reason: `Azure returned ${r.status} reading run actions.`,
              remediation: `Grant the Console UAMI "Logic App Operator" on resource group ${bind.binding.resourceGroup}.`,
              link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-operator',
            },
          },
          { status: 403 },
        );
      }
      return NextResponse.json({ ok: false, error: `Azure returned ${r.status} reading run actions.` }, { status: 502 });
    }
    const bodyJson = await r.json().catch(() => ({} as any));
    const rows: ActionRow[] = Array.isArray(bodyJson?.value) ? bodyJson.value : [];
    return apiOk({
      runName,
      actions: rows.map((a) => ({
        name: a.name,
        status: a.properties?.status,
        startTime: a.properties?.startTime,
        endTime: a.properties?.endTime,
        durationMs: durationMs(a.properties?.startTime, a.properties?.endTime),
        code: a.properties?.code,
        retryCount: Array.isArray(a.properties?.retryHistory) ? a.properties!.retryHistory!.length : 0,
        error: a.properties?.error?.message || a.properties?.error?.code,
      })),
    });
  }

  // ── Run list ─────────────────────────────────────────────────────────────
  const r = await callLogicArm(`${url}/runs?api-version=${LOGIC_API}&$top=${top}`);
  if (!r.ok) {
    // A workflow that has never run returns an empty list, not a 404 — but a
    // just-created one can 404 briefly while ARM settles. Report it as empty
    // history rather than an error the user has to interpret.
    if (r.status === 404) return apiOk({ runs: [], logicAppName: bind.binding.workflowName });
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          error: `Not authorized to read run history (${r.status}).`,
          gate: {
            code: 'not-authorized' as const,
            reason: `Azure returned ${r.status} listing workflow runs.`,
            remediation: `Grant the Console UAMI "Logic App Operator" on resource group ${bind.binding.resourceGroup}.`,
            link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-operator',
          },
        },
        { status: 403 },
      );
    }
    return NextResponse.json({ ok: false, error: `Azure returned ${r.status} listing workflow runs.` }, { status: 502 });
  }

  const bodyJson = await r.json().catch(() => ({} as any));
  const rows: RunRow[] = Array.isArray(bodyJson?.value) ? bodyJson.value : [];
  return apiOk({
    logicAppName: bind.binding.workflowName,
    runs: rows.map((run) => ({
      name: run.name,
      status: run.properties?.status,
      startTime: run.properties?.startTime,
      endTime: run.properties?.endTime,
      durationMs: durationMs(run.properties?.startTime, run.properties?.endTime),
      trigger: run.properties?.trigger?.name,
      triggerStatus: run.properties?.trigger?.status,
      clientTrackingId: run.properties?.correlation?.clientTrackingId,
      error: run.properties?.error?.message || run.properties?.error?.code,
    })),
  });
});

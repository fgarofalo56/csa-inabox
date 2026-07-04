/**
 * lib/semantic-model/plan-metrics.ts
 *
 * Plan-metrics writeback (audit-T13), extracted verbatim from
 * app/api/items/semantic-model/[id]/model/route.ts (rel-T64) — behaviour-
 * preserving. An approved plan pushes its task status + approval outcome into the
 * model as a `_PlanTasks` calculated table + a `_PlanMetrics` measures table. The
 * DEFAULT (no-fabric, no-AAS) path persists to the model's Cosmos content; when
 * LOOM_AAS_XMLA_ENDPOINT is configured the createOrReplace scripts run live over
 * XMLA. An unconfigured endpoint returns 200 { xmlaUnavailable } (honest gate).
 */

import { NextResponse } from 'next/server';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { cosmosIdFromLoomId, loadContentBackedItem } from '@/app/api/items/_lib/pbi-content-fallback';
import {
  executeAasXmla, aasConfig, aasDefaultDatabase, buildPlanStatusMeasuresTmsl,
  type PlanMetricTask, type PlanApprovalStatus,
} from '@/lib/azure/aas-client';

export interface PlanMetricsBody {
  planMetrics?: {
    tasks?: Array<{ title?: string; owner?: string; due?: string; status?: string }>;
    approvalStatus?: string;
  };
}

const PLAN_APPROVAL_STATES = new Set<PlanApprovalStatus>(['none', 'pending', 'approved', 'rejected']);

function normalizePlanTasks(raw: unknown): PlanMetricTask[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => {
    const status = String((t as any)?.status || 'todo');
    return {
      title: String((t as any)?.title || ''),
      owner: String((t as any)?.owner || ''),
      due: String((t as any)?.due || ''),
      status: (status === 'doing' || status === 'done') ? status : 'todo',
    } as PlanMetricTask;
  });
}

async function persistPlanMetricsToCosmos(
  id: string,
  tenantId: string,
  tasks: PlanMetricTask[],
  approvalStatus: PlanApprovalStatus,
  steps: string[],
): Promise<void> {
  const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
  if (!item) {
    steps.push('No Cosmos-backed semantic-model item resolved for this id; plan metrics not persisted to content (a live-only model id was supplied).');
    return;
  }
  const existingContent = (item.state as any)?.content || { kind: 'semantic-model' };
  const next: WorkspaceItem = {
    ...item,
    state: {
      ...(item.state || {}),
      content: {
        ...existingContent,
        kind: 'semantic-model',
        planMetrics: { tasks, approvalStatus, updatedAt: new Date().toISOString() },
      },
    },
    updatedAt: new Date().toISOString(),
  } as WorkspaceItem;
  const items = await itemsContainer();
  await items.item(item.id, item.workspaceId).replace(next);
  steps.push(`Saved plan metrics (${tasks.length} task(s), approval=${approvalStatus}) to this model's content.`);
}

export async function handlePlanMetricsPost(
  id: string, tenantId: string, body: PlanMetricsBody['planMetrics'],
): Promise<NextResponse> {
  const tasks = normalizePlanTasks(body?.tasks);
  const rawStatus = String(body?.approvalStatus || 'none') as PlanApprovalStatus;
  const approvalStatus: PlanApprovalStatus = PLAN_APPROVAL_STATES.has(rawStatus) ? rawStatus : 'none';
  const steps: string[] = [];

  // Always persist to Cosmos content first (source of truth + provision-time TMSL).
  await persistPlanMetricsToCosmos(id, tenantId, tasks, approvalStatus, steps);

  const database = aasDefaultDatabase();
  const { tasksTmsl, metricsTmsl } = buildPlanStatusMeasuresTmsl(database || 'model', tasks, approvalStatus);

  // Azure-native opt-in XMLA write. aasConfig().available is true only when
  // LOOM_AAS_XMLA_ENDPOINT is set — otherwise honest-gate (200, not 5xx).
  if (!aasConfig().available) {
    return NextResponse.json({
      ok: false,
      xmlaUnavailable: true,
      backend: 'loom-native',
      steps,
      missing: 'LOOM_AAS_XMLA_ENDPOINT',
      detail:
        'Plan metrics were saved to the model content and will be written into the model.bim at provision time. ' +
        'To push them to a live Azure Analysis Services model now, set LOOM_AAS_XMLA_ENDPOINT (the XMLA HTTP URL) ' +
        'and LOOM_AAS_DATABASE (the model database name) on the Console container app — no Microsoft Fabric / Power BI workspace required.',
    });
  }
  if (!database) {
    return NextResponse.json({
      ok: false,
      xmlaUnavailable: true,
      backend: 'loom-native',
      steps,
      missing: 'LOOM_AAS_DATABASE',
      detail: 'LOOM_AAS_XMLA_ENDPOINT is set but LOOM_AAS_DATABASE (the model database name) is not. Plan metrics were saved to content; set LOOM_AAS_DATABASE to write them to the live model.',
    });
  }

  // _PlanTasks first (the measures reference it), then _PlanMetrics.
  const tasksResult = await executeAasXmla(tasksTmsl, database);
  if (!tasksResult.ok) {
    return NextResponse.json({ ok: false, backend: 'aas-xmla', steps, error: `Writing _PlanTasks failed: ${tasksResult.error}` }, { status: 502 });
  }
  steps.push(`Created/replaced _PlanTasks (${tasks.length} row(s)) on AAS model ${database}.`);
  const metricsResult = await executeAasXmla(metricsTmsl, database);
  if (!metricsResult.ok) {
    return NextResponse.json({ ok: false, backend: 'aas-xmla', steps, error: `Writing _PlanMetrics failed: ${metricsResult.error}` }, { status: 502 });
  }
  steps.push(`Created/replaced _PlanMetrics (PlanDone%, PlanOverdue, ApprovalStatus) on AAS model ${database}.`);

  return NextResponse.json({ ok: true, backend: 'aas-xmla', applied: true, database, tasks: tasks.length, approvalStatus, steps });
}

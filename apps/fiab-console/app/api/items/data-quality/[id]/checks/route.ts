/**
 * /api/items/data-quality/[id]/checks   (N7d — fold a)
 *
 * POST  → run the item's rule-builder checks on the N4 transform runner, score
 *         each against its anomaly baseline, persist the run + rolling history to
 *         item.state, and EMIT findings for N17's incident console.
 *         body { checks?: DqCheck[], target?: DqCheckTarget, environment?, gateway? }
 *         (falls back to item.state.n7dChecks / item.state.n7dTarget)
 * GET   → readiness: runner config gate, the FLAG0 state, and the last run.
 *
 * Real backend on every run (transform-runner-client → the loom-transform-runner
 * Container App; DuckDB/Synapse/Databricks engines) — no Fabric dependency,
 * no fabricated scores. N7d PRODUCES findings; N17 OWNS the incident UX.
 */
import type { NextRequest } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { QUALITY_RULE_VALUES } from '@/lib/dataproducts/contract';
import {
  runTransformChecks,
  transformRunnerConfigGate,
  mergeCheckHistory,
  type CheckHistory,
} from '@/lib/azure/dq-transform-checks';
import type { DqCheck, DqCheckTarget } from '@/lib/azure/dq-check-compile';
import type { TransformEngine } from '@/lib/transform/transform-project-model';
import { writeDqFindings } from '@/lib/azure/dq-finding-store';
import { updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-quality';
const FLAG = 'n7d-data-quality-diff';
const ENGINES: TransformEngine[] = ['synapse', 'databricks', 'duckdb', 'fabric'];

function sanitizeChecks(raw: unknown): DqCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: DqCheck[] = [];
  for (const r of raw.slice(0, 500)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const rule = typeof o.rule === 'string' ? o.rule : '';
    if (!QUALITY_RULE_VALUES.includes(rule)) continue;
    const table = typeof o.table === 'string' ? o.table.trim() : '';
    if (!table) continue;
    out.push({
      id: (typeof o.id === 'string' && o.id.trim()) ? o.id.trim().slice(0, 60) : crypto.randomUUID(),
      table: table.slice(0, 200),
      column: typeof o.column === 'string' ? o.column.trim().slice(0, 200) : undefined,
      rule,
      value: typeof o.value === 'string' ? o.value.slice(0, 400) : undefined,
      severity: o.severity === 'warning' ? 'warning' : 'error',
    });
  }
  return out;
}

function sanitizeTarget(raw: unknown, fallback?: unknown): DqCheckTarget {
  const o = (raw && typeof raw === 'object' ? raw : (fallback && typeof fallback === 'object' ? fallback : {})) as Record<string, unknown>;
  const engineIn = typeof o.engine === 'string' ? o.engine : '';
  const engine = (ENGINES as string[]).includes(engineIn) ? (engineIn as TransformEngine) : 'synapse';
  const pick = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  return {
    engine,
    synapseServer: pick('synapseServer'),
    databricksHost: pick('databricksHost'),
    databricksHttpPath: pick('databricksHttpPath'),
    catalog: pick('catalog'),
    database: pick('database'),
    duckdbPath: pick('duckdbPath'),
    fabricEndpoint: pick('fabricEndpoint'),
    schema: pick('schema') || 'analytics',
  };
}

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req: NextRequest, { item }) => {
  const state = (item.state || {}) as Record<string, unknown>;
  const gate = transformRunnerConfigGate();
  const enabled = await runtimeFlag(FLAG, { default: true });
  const runs = Array.isArray(state.n7dCheckRuns) ? state.n7dCheckRuns : [];
  return apiOk({
    enabled,
    gate: gate ? { missing: gate.missing } : null,
    checks: Array.isArray(state.n7dChecks) ? state.n7dChecks : [],
    target: (state.n7dTarget as Record<string, unknown>) || { engine: 'synapse', schema: 'analytics' },
    lastRun: runs[0] || null,
    runCount: runs.length,
  });
});

export const POST = withWorkspaceOwner(ITEM_TYPE, async (req: NextRequest, { session, item }) => {
  const enabled = await runtimeFlag(FLAG, { default: true });
  if (!enabled) {
    return apiOk({ disabled: true, note: 'The N7d data-quality depth surface is turned off (runtime flag n7d-data-quality-diff).' });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const state = (item.state || {}) as Record<string, unknown>;

  const checks = sanitizeChecks(body.checks ?? state.n7dChecks);
  if (checks.length === 0) {
    return apiError('Add at least one rule-builder check (a rule + table) before running.', 400);
  }
  const target = sanitizeTarget(body.target, state.n7dTarget);

  const gate = transformRunnerConfigGate();
  if (gate) {
    return apiError(`The transform runner is not configured: set ${gate.missing}.`, 503, {
      code: 'not_configured',
      gated: true,
      missing: gate.missing,
      hint: `Set ${gate.missing} on the loom-console env. N7d checks run on the real N4 transform runner — no fabricated results.`,
    });
  }

  const history = (state.n7dCheckHistory as CheckHistory) || {};
  const runner = {
    environment: typeof body.environment === 'string' ? body.environment : undefined,
    gateway: typeof body.gateway === 'string' ? body.gateway : undefined,
  };

  try {
    const result = await runTransformChecks({
      checks,
      target,
      history,
      context: {
        tenantId: session.claims.oid,
        itemId: item.id,
        itemType: ITEM_TYPE,
        workspaceId: item.workspaceId,
        createdBy: session.claims.upn || session.claims.email || session.claims.oid,
      },
      runner,
    });

    // Emit findings for N17 (idempotent by deterministic id).
    const emitted = await writeDqFindings(result.findings, {
      oid: session.claims.oid,
      upn: session.claims.upn || session.claims.email || session.claims.oid,
      tenantId: session.claims.oid,
    });

    // Persist the run summary + rolling history + last-used config on the item.
    const runRecord = {
      runId: result.runId,
      ranAt: result.ranAt,
      engine: result.engine,
      summary: result.summary,
      items: result.items,
      findingsEmitted: emitted.written,
      ranBy: session.claims.upn || session.claims.email || session.claims.oid,
    };
    const priorRuns = Array.isArray(state.n7dCheckRuns) ? (state.n7dCheckRuns as unknown[]) : [];
    const nextState = {
      ...state,
      n7dChecks: checks,
      n7dTarget: target,
      n7dCheckHistory: mergeCheckHistory(history, result.observations),
      n7dCheckRuns: [runRecord, ...priorRuns].slice(0, 20),
    };
    await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, { state: nextState }).catch(() => {});

    return apiOk({ run: runRecord, findingsEmitted: emitted, log: result.log });
  } catch (e) {
    const err = e as Error & { code?: string; missing?: string };
    if (err.code === 'not_configured' && err.missing) {
      return apiError(err.message, 503, { code: 'not_configured', gated: true, missing: err.missing });
    }
    return apiError(err.message || String(e), 502);
  }
});

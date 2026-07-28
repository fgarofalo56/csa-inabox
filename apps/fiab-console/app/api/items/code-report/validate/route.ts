/**
 * POST /api/items/code-report/validate — parse + DRY-COMPILE a Code report (N16).
 *
 * This is the server behind the CI hook `loom report validate <file>`: it runs
 * the REAL pure parser (lib/code-report/parse) over the submitted source AND
 * dry-compiles every governed-metric block through N15's compileGovernedMetric
 * (lib/metrics/consumers) against the CALLER's own governed spec — the exact
 * compile the renderer uses, minus execution. A fake pass is impossible: an
 * unknown metric / undeclared dimension / bad grain throws a real
 * MetricCompileError that becomes a validation error, and a raw block that isn't
 * a single read-only statement fails the read-only guard.
 *
 * No `[id]` — it validates arbitrary source for the SIGNED-IN caller (spec +
 * registry are owner-scoped by session.claims.oid), so `withSession` is the
 * correct guard (there is no per-item resource to authorize). Returns structured
 * `{ ok, errors, warnings, queries }`; the CLI maps `ok:false` to a non-zero exit.
 *
 * When the caller has NO governed spec yet, metric blocks can't be compiled —
 * that is an honest WARNING (not an error); structural validation still runs, so
 * malformed reports still fail. Azure-native, IL5-safe (pure in-process work).
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  parseCodeReport,
  assertReadOnlyQuery,
  engineDialect,
  CodeReportParseError,
  RawQueryUnsafeError,
  type CodeReportEngine,
} from '@/lib/code-report/parse';
import { compileGovernedMetric } from '@/lib/metrics/consumers';
import { MetricCompileError } from '@/lib/metrics/metric-compiler';
import { normalizeSpec, type MetricFlowSpec } from '@/lib/metrics/metricflow-spec';
import { getSemanticSpec } from '@/lib/azure/semantic-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FLAG_ID = 'n16-code-report';

interface ValidationIssue {
  message: string;
  line?: number;
  query?: string;
}

export const POST = withSession(async (req: NextRequest, { session }) => {
  if (!(await runtimeFlag(FLAG_ID, { default: true }))) {
    return apiError('Code reports are turned off (admin → runtime flags).', 503, { code: 'code_report_off' });
  }

  const body = (await req.json().catch(() => ({}))) as { source?: unknown; engine?: unknown };
  if (typeof body.source !== 'string') return apiError('source is required (a string)', 400);
  const source = body.source;
  const defaultEngine: CodeReportEngine = body.engine === 'adx' ? 'adx' : body.engine === 'lakehouse' ? 'lakehouse' : 'synapse';

  // 1) Structural parse — a CodeReportParseError is a hard, single error.
  let ast;
  try {
    ast = parseCodeReport(source);
  } catch (e) {
    if (e instanceof CodeReportParseError) {
      return apiOk({
        ok: false,
        valid: false,
        errors: [{ message: e.message, line: e.line || undefined }] as ValidationIssue[],
        warnings: [],
        queries: [],
      });
    }
    return apiServerError(e);
  }

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // 2) Governed spec (owner-scoped). Absent ⇒ metric blocks can't be compiled.
  let spec: MetricFlowSpec | null = null;
  try {
    const raw = await getSemanticSpec(session.claims.oid);
    spec = raw ? normalizeSpec(raw) : null;
  } catch {
    spec = null;
  }
  const metricBlocks = ast.queries.filter((q) => q.kind === 'metric');
  if (metricBlocks.length > 0 && !spec) {
    warnings.push({
      message:
        'No governed metrics spec is defined for you, so `sql loom` metric blocks were not compiled. ' +
        'Import a MetricFlow spec on the semantic-model editor to fully validate them.',
    });
  }

  // 3) Per-query checks: dry-compile metrics; read-only-guard raw blocks.
  for (const q of ast.queries) {
    if (q.kind === 'metric') {
      if (!spec) continue; // warned above
      try {
        compileGovernedMetric({
          spec,
          metric: q.metric,
          dimensions: q.dimensions,
          filters: q.filters,
          grain: q.grain,
          engine: q.engine ?? defaultEngine,
        });
      } catch (e) {
        if (e instanceof MetricCompileError) {
          errors.push({ message: e.message, query: q.name });
        } else {
          return apiServerError(e);
        }
      }
    } else {
      try {
        assertReadOnlyQuery(q.sql, engineDialect(defaultEngine));
      } catch (e) {
        if (e instanceof RawQueryUnsafeError) {
          errors.push({ message: e.message, query: q.name });
        } else {
          return apiServerError(e);
        }
      }
    }
  }

  const visualCount = ast.nodes.filter((n) => n.kind === 'visual').length;
  return apiOk({
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
    warnings,
    queries: ast.queries.map((q) =>
      q.kind === 'metric'
        ? { name: q.name, kind: 'metric', metric: q.metric, dimensions: q.dimensions }
        : { name: q.name, kind: 'raw' },
    ),
    visualCount,
  });
});

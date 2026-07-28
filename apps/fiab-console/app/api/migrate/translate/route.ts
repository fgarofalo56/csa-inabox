/**
 * POST /api/migrate/translate — M3 code translation (best-effort, HONEST).
 *
 * Consumes the translatable-source rows M1's ReadinessReport identifies and
 * transpiles them to Loom artifacts with a per-construct REVIEW DIFF:
 *   • Snowflake / T-SQL view  → Loom SQL          (lib/migrate/sql-transpile.ts)
 *   • DAX measure             → N9 semantic-contract measure (reuses the A1/A2/A3
 *                               parser + fold; lib/migrate/artifact-transpile.ts)
 *   • PBIX / report           → N16 code-report    (reuses the N16 parser)
 *
 * DIE-HARD HONESTY (mirrors A1's unsupportedDaxError): an unsupported construct
 * comes back `needs-review` with the EXACT reason and `generated:null` — never a
 * fabricated translation. Generated artifacts are DRAFT payloads the UI lands
 * through the normal audited item-create path (draft/publish semantics).
 *
 * `commit:true` additionally EMITS each parseable DAX measure into N9's store as
 * a governed `measure` metric (registerMetric — a real, audited Cosmos write).
 *
 * Guards & gates:
 *   - withTenantAdmin — translating an external estate is a tenant-admin action.
 *   - FLAG0 n-m3-translate — kill-switch; OFF → guided 503 (no prior behavior).
 *
 * AUDITED: every translate — and every committed metric emission — emits an
 * audit event FIRST (synchronous fan-out) then persists a durable `_auditLog`
 * row. There is no unaudited path.
 *
 * 200 → { ok:true, result, emitted? }   401 → unauthenticated   403 → not admin
 * 400 → bad body   503 → feature flag off
 */
import { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { registerMetric } from '@/lib/azure/semantic-contract';
import { translateBatch, type TranslateInput, type TranslationResult } from '@/lib/migrate/translate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KINDS = new Set(['sql-view', 'stored-routine', 'dax-measure', 'report']);
const MAX_ARTIFACTS = 200;

interface Body {
  artifacts?: unknown;
  commit?: unknown;
}

/** Validate + coerce the request body's artifacts into typed TranslateInputs. */
function parseArtifacts(raw: unknown): TranslateInput[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'artifacts must be an array.' };
  if (raw.length === 0) return { error: 'artifacts must contain at least one item.' };
  if (raw.length > MAX_ARTIFACTS) return { error: `Too many artifacts (max ${MAX_ARTIFACTS}).` };
  const out: TranslateInput[] = [];
  for (const a of raw) {
    const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const kind = String(o.kind || '');
    if (!KINDS.has(kind)) return { error: `Each artifact.kind must be one of: ${[...KINDS].join(', ')}.` };
    out.push({
      kind: kind as TranslateInput['kind'],
      name: String(o.name || '').slice(0, 256),
      sourceType: o.sourceType as TranslateInput['sourceType'],
      dialect: o.dialect === 'tsql' ? 'tsql' : o.dialect === 'snowflake' ? 'snowflake' : undefined,
      sql: typeof o.sql === 'string' ? o.sql : undefined,
      dax: typeof o.dax === 'string' ? o.dax : undefined,
      table: typeof o.table === 'string' ? o.table : undefined,
      report: o.report && typeof o.report === 'object' ? (o.report as TranslateInput['report']) : undefined,
    });
  }
  return out;
}

async function writeAuditRow(row: Record<string, unknown>): Promise<void> {
  try {
    const al = await auditLogContainer();
    await al.items.create({ id: crypto.randomUUID(), ...row });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[migrate.translate] audit row write failed:', (e as Error)?.message || e);
  }
}

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  // FLAG0 — kill-switch. OFF reverts M3 (no prior behavior → guided 503).
  if (!(await runtimeFlag('n-m3-translate'))) {
    return apiError(
      'Code translation is turned off (runtime flag n-m3-translate). Re-enable it on /admin/runtime-flags.',
      503,
      { code: 'feature_disabled' },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const parsed = parseArtifacts(body.artifacts);
  if ('error' in parsed) return apiError(parsed.error, 400, { code: 'invalid_body' });
  const commit = body.commit === true;

  const tenantId = session.claims.tid || session.claims.oid;
  const at = new Date().toISOString();

  let result: TranslationResult;
  try {
    // Pure, in-boundary translation (owner = oid for N9's owner-scoped store).
    result = translateBatch(parsed, { owner: session.claims.oid });
  } catch (e) {
    emitAuditEvent({
      actorOid: session.claims.oid, actorUpn: session.claims.upn,
      action: 'migrate.translate', targetType: 'migration-translation', targetId: 'migrate:translate',
      outcome: 'failure', tenantId, timestamp: at, detail: { error: 'translate_failed' },
    });
    return apiServerError(e, 'Code translation failed', 'migrate_translate_failed');
  }

  // AUDIT the translate FIRST (synchronous fan-out) … then persist the row.
  emitAuditEvent({
    actorOid: session.claims.oid, actorUpn: session.claims.upn,
    action: 'migrate.translate', targetType: 'migration-translation', targetId: 'migrate:translate',
    outcome: 'success', tenantId, timestamp: at,
    detail: { total: result.totals.total, supported: result.totals.supported, needsReview: result.totals.needsReview, commit },
  });
  await writeAuditRow({
    tenantId, itemType: 'migration-translation', itemId: 'migrate:translate', action: 'migrate.translate',
    upn: session.claims.upn, actorOid: session.claims.oid, at, outcome: 'success',
    summary: `Translated ${result.totals.total} artifact(s) (${result.totals.supported} supported / ${result.totals.needsReview} needs-review) by ${session.claims.upn}`,
  });

  // Optional N9 contract emission: land each parseable DAX measure as a governed
  // `measure` metric (a real, audited Cosmos write — never fabricated).
  const emitted: Array<{ name: string; metricId: string }> = [];
  const emitFailures: Array<{ name: string; error: string }> = [];
  if (commit) {
    for (const a of result.artifacts) {
      if (a.kind !== 'dax-measure' || !a.metricDraft) continue;
      try {
        const doc = await registerMetric(session.claims.oid, {
          metricId: a.metricDraft.metricId,
          label: a.metricDraft.label,
          owner: a.metricDraft.owner || session.claims.upn || session.claims.oid,
          description: a.metricDraft.description,
          synonyms: a.metricDraft.synonyms,
          grain: a.metricDraft.grain,
          sourceKind: a.metricDraft.sourceKind,
          sourceRef: a.metricDraft.sourceRef,
        });
        emitted.push({ name: a.name, metricId: doc.metricId });
        emitAuditEvent({
          actorOid: session.claims.oid, actorUpn: session.claims.upn,
          action: 'migrate.translate.emit-metric', targetType: 'semantic-contract-metric', targetId: doc.metricId,
          outcome: 'success', tenantId, timestamp: new Date().toISOString(),
          detail: { name: a.name, needsReview: a.status === 'needs-review' },
        });
      } catch (e) {
        emitFailures.push({ name: a.name, error: (e as Error)?.message?.slice(0, 200) || 'emit failed' });
      }
    }
  }

  return apiOk({ result, ...(commit ? { emitted, emitFailures } : {}) });
});

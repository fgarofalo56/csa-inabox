/**
 * GET /api/admin/diagnostics/bundle — the DIAG1 one-click support bundle.
 *
 * Assembles {version + ACA revision, gate-registry state, MASKED env posture,
 * live health probes, last synthetic-journey run, recent audit rows} into a
 * single JSON document for attaching to an incident. REAL registries/backends
 * only (no-vaporware.md); the assembler + scrubber (lib/admin/support-bundle)
 * mask env secrets at source AND run a defence-in-depth secret scrub over every
 * field, so the bundle carries ZERO secrets / tokens / connection strings.
 *
 * Session-gated + tenant-admin (withTenantAdmin — R1 route-toolkit).
 *   ?download=1 → streams as an attachment (loom-support-bundle-<ts>.json).
 *   (default)   → returns the same JSON inline for the /admin/diagnostics
 *                 preview pane.
 *
 * Runbook: docs/fiab/runbooks/support-bundle.md.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { withTenantAdmin, type SessionContext } from '@/lib/api/route-toolkit';
import { apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import { allGateStatuses } from '@/lib/gates/registry';
import { ENV_CHECKS } from '@/lib/admin/env-checks';
import { resolveCurrentVersion, readBuildMarker } from '@/lib/updates/current-version';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import { probeCosmosReachable, auditLogContainer } from '@/lib/azure/cosmos-client';
import { readSyntheticRuns } from '@/lib/admin/synthetic-runs-reader';
import {
  assembleSupportBundle, buildEnvPosture, supportBundleFilename,
  type GatePosture, type ProbeResult, type AuditRowLite, type SyntheticRunLite,
} from '@/lib/admin/support-bundle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Rows of recent audit history to include (bounded). */
const AUDIT_ROWS = 25;

/** Run a named async probe under a wall-clock budget → a ProbeResult. */
async function probe(name: string, budgetMs: number, fn: () => Promise<void>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${budgetMs}ms`)), budgetMs);
      fn().then(
        () => { clearTimeout(t); resolve(); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
    return { name, ok: true, ms: Date.now() - started };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, error: ((e as Error)?.message ?? String(e)).slice(0, 160) };
  }
}

async function recentAudit(tenantId: string): Promise<{ rows: AuditRowLite[]; note?: string }> {
  try {
    const c = await auditLogContainer();
    const { resources } = await c.items
      .query<{ at?: string; who?: string; kind?: string; target?: string }>({
        query:
          'SELECT TOP @n c.at, c.who, c.kind, c.target FROM c WHERE c.tenantId = @t ORDER BY c.at DESC',
        parameters: [
          { name: '@n', value: AUDIT_ROWS },
          { name: '@t', value: tenantId },
        ],
      })
      .fetchAll();
    return {
      rows: resources.map((r) => ({
        at: String(r.at ?? ''),
        who: String(r.who ?? ''),
        kind: String(r.kind ?? ''),
        target: r.target ? String(r.target) : undefined,
      })),
    };
  } catch (e) {
    return { rows: [], note: `Recent audit rows unavailable: ${((e as Error)?.message ?? String(e)).slice(0, 120)}` };
  }
}

async function buildBundle(session: SessionContext<Record<string, string>>['session']) {
  const now = new Date();
  const notes: string[] = [];

  // Version + running image fingerprint.
  const marker = readBuildMarker();
  const version = {
    version: resolveCurrentVersion(marker),
    sha: marker.sha,
    stamp: marker.stamp,
    revision: (process.env.CONTAINER_APP_REVISION || '').trim() || undefined,
    app: (process.env.CONTAINER_APP_NAME || '').trim() || undefined,
    cloud: detectLoomCloud(),
  };

  // Gate registry — one cheap in-process pass (no network).
  const gates: GatePosture[] = allGateStatuses().map((g) => ({
    id: g.id,
    status: g.status,
    missing: g.missing ?? [],
    availability: g.availability,
  }));

  // Masked env posture over every ENV_CHECKS-referenced var.
  const env = buildEnvPosture(ENV_CHECKS, process.env);

  // Live probes (bounded, best-effort).
  const probes = await Promise.all([
    probe('cosmos-reachable', 2500, () => probeCosmosReachable(2500)),
  ]);

  // Last synthetic-journey run (honest note when the store is unwired).
  let lastSyntheticRun: SyntheticRunLite | undefined;
  try {
    const synthetic = await readSyntheticRuns({ n: 1 });
    if (!synthetic.configured) {
      notes.push(
        `Synthetic-journey store not wired${synthetic.missing ? ` (set ${synthetic.missing})` : ''} — no last-run summary in this bundle.`,
      );
    } else if (synthetic.runs[0]) {
      const r = synthetic.runs[0];
      lastSyntheticRun = { runId: r.runId, ts: r.ts, pass: r.pass, fail: r.fail, skip: r.skip };
    } else {
      notes.push('Synthetic-journey store wired but has no runs yet.');
    }
  } catch (e) {
    notes.push(`Synthetic-journey read failed: ${((e as Error)?.message ?? String(e)).slice(0, 120)}`);
  }

  // Recent audit rows.
  const audit = await recentAudit(tenantScopeId(session));
  if (audit.note) notes.push(audit.note);

  // DR-drill summary is out of scope for this bundle until DR4's summary store
  // lands — declared honestly rather than silently omitted.
  notes.push('DR-drill summaries are not included (DR4 summary store); see /admin/health DR tab when available.');

  const generatedBy =
    session.claims.upn || session.claims.email || session.claims.name || session.claims.oid;

  return assembleSupportBundle({
    now, generatedBy, version, gates, env, probes,
    lastSyntheticRun, recentAudit: audit.rows, notes,
  });
}

export const GET = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const bundle = await buildBundle(session);
    const download = req.nextUrl.searchParams.get('download') === '1';
    const body = JSON.stringify(download ? bundle : { ok: true, bundle }, null, 2);
    if (download) {
      return new NextResponse(body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${supportBundleFilename(new Date(bundle.generatedAt), bundle.version.sha)}"`,
          'cache-control': 'no-store',
        },
      });
    }
    return new NextResponse(body, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return apiServerError(e, 'Failed to assemble the support bundle');
  }
});

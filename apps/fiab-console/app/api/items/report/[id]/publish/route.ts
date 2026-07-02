/**
 * POST / DELETE /api/items/report/[id]/publish — report-designer-v2 publish.
 *
 * Publishes the Loom report authored in the designer so colleagues can consume
 * it, then unpublishes it. Two targets, Azure-native DEFAULT:
 *
 *   • org-gallery (DEFAULT, Azure-native — no Fabric / Power BI required)
 *     Persists a published SNAPSHOT — the resolved `ReportContent` + the report's
 *     data-source ref + author/timestamp — as a `kind:'loom-report'` document in
 *     the existing `coe-templates` Cosmos container (PK /tenantId), the same
 *     container + partition pattern the CoE clone (`setClonePublished`) and the
 *     Loom-native dashboard (`setDashboardPublished`) stores use. Because
 *     `listPublishedReports()` already returns every published doc in that
 *     container that is NOT a `loom-dashboard`, the snapshot surfaces in
 *     **Organization reports** (`GET /api/org-reports`) immediately — no edit to
 *     that route required. The consumer view re-runs the report against the
 *     snapshot's data source via `POST …/query` (real backend, not a thumbnail).
 *     This is the same Cosmos org store every Loom deployment ships, so it is
 *     always reachable; if Cosmos itself is unreachable we return an honest gate.
 *
 *   • powerbi (OPT-IN ONLY — Fabric-family)
 *     Reached only when the deployment selected the Power BI BI backend
 *     (`NEXT_PUBLIC_LOOM_BI_BACKEND` / `LOOM_BI_BACKEND` = "powerbi") AND a Fabric
 *     workspace resolves (item `state.fabricWorkspaceId`, else
 *     `LOOM_DEFAULT_FABRIC_WORKSPACE`), OR the caller explicitly asks for
 *     `target:'powerbi'`. We REUSE the shipped `reportProvisioner`
 *     (lib/install/provisioners/report.ts) — which builds the PBIR definition
 *     (`buildReportDefinitionParts`) and calls the real Fabric REST
 *     `POST /v1/workspaces/{ws}/reports` — rather than reinventing it. Its
 *     `remediation`/`failed` outcomes are surfaced as honest gates.
 *
 * Honest gate (no-vaporware.md): when the chosen target is not configured —
 * Power BI explicitly requested but no workspace bound, or the Cosmos org store
 * is unreachable — we return `{ ok:false, gate }` naming the exact env var /
 * resource, never a silent no-op.
 *
 * Rules:
 *  - no-fabric-dependency.md — the DEFAULT publish target is the Azure-native
 *    Cosmos org gallery; Power BI is strictly opt-in and NEVER required. When
 *    the deployment auto-selects Power BI but no workspace is bound, publish
 *    silently falls back to the org gallery (Fabric is never a hard gate). We
 *    only call api.fabric.microsoft.com on the opt-in path (inside the reused
 *    provisioner), never on the default path.
 *  - no-vaporware.md — a real `ReportContent` snapshot + a real Cosmos write (or
 *    the real Fabric REST create), with honest gates; no mock.
 *  - no-freeform-config.md — the publish target is a picker choice; the snapshot
 *    is derived from the persisted designer model. No free text.
 *
 * POST   → { ok:true, target:'org-gallery'|'powerbi', link, ... }
 *          | { ok:false, gate } (412, honest) | { ok:false, error } (4xx)
 * DELETE → { ok:true, target:'org-gallery' }  (unpublish — published=false)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import {
  publishLoomReport,
  unpublishLoomReport,
} from '@/lib/coe-library/loom-report-store';
import { reportProvisioner } from '@/lib/install/provisioners/report';
import { readReportDataSource } from '@/lib/azure/report-model-resolver';
import type { ReportContent } from '@/lib/apps/content-bundles/types';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Power BI is opt-in only — read both the public + server BI-backend toggles. */
const BI_BACKEND = (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || process.env.LOOM_BI_BACKEND || '')
  .trim()
  .toLowerCase();
const PBI_OPT_IN = BI_BACKEND === 'powerbi';

function jerr(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

function jgate(gate: { reason: string; remediation: string; link?: string }, status = 412) {
  return NextResponse.json({ ok: false, gate }, { status });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Extract the persisted ReportContent (the designer's saved definition). */
function reportContentOf(item: WorkspaceItem): ReportContent | null {
  const c = (item.state as Record<string, unknown> | undefined)?.content as
    | { kind?: string }
    | undefined;
  return c && c.kind === 'report' ? (c as unknown as ReportContent) : null;
}

/** Resolve the opt-in Fabric workspace: item binding first, then platform env. */
function resolveWorkspace(item: WorkspaceItem): string | undefined {
  const state = (item.state || {}) as Record<string, unknown>;
  return str(state.fabricWorkspaceId) || str(process.env.LOOM_DEFAULT_FABRIC_WORKSPACE);
}

// The Azure-native org-gallery snapshot store (publish / unpublish / list) is the
// SHARED module `@/lib/coe-library/loom-report-store` — `publishLoomReport` and
// `unpublishLoomReport`, imported above. It writes a `kind:'loom-report'` doc
// (id = the report item id) to the `coe-templates` Cosmos container, the same
// container + PK + publish-flag pattern as dashboard-store / coe-library-client,
// so `GET /api/org-reports` picks the docs up. The store also backs the
// org-reports read path, so both surfaces share ONE doc shape + id scheme.

// ── opt-in Power BI publish (reuses the shipped reportProvisioner) ────────────

async function publishToPowerBi(
  session: SessionPayload,
  item: WorkspaceItem,
  reportId: string,
  ws: string,
  content: ReportContent | null,
) {
  const result = await reportProvisioner({
    session,
    target: { mode: 'shared', fabricWorkspaceId: ws, semanticBackend: 'powerbi' },
    cosmosItemId: reportId,
    workspaceId: item.workspaceId,
    displayName: item.displayName,
    content,
    appId: 'report-designer',
  });

  if (result.status === 'created' || result.status === 'exists') {
    const fabricReportId = result.resourceId;
    const link =
      fabricReportId && !fabricReportId.includes('/')
        ? `https://app.fabric.microsoft.com/groups/${ws}/reports/${fabricReportId}`
        : `https://app.fabric.microsoft.com/groups/${ws}/list`;
    return NextResponse.json({
      ok: true,
      target: 'powerbi' as const,
      link,
      workspaceId: ws,
      reportId: fabricReportId,
      steps: result.steps,
    });
  }

  // remediation / failed → honest gate (never a silent no-op).
  if (result.status === 'remediation' && result.gate) {
    return jgate({
      reason: result.gate.reason,
      remediation: result.gate.remediation,
      ...(result.gate.link ? { link: result.gate.link } : {}),
    });
  }
  return jerr(result.error || 'Power BI publish failed.', 502);
}

// ── handlers ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || session.claims.name || tenantId;

  const rawId = (await ctx.params).id;
  const reportId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: { target?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → default target */
  }
  const requested =
    body.target === 'powerbi' ? 'powerbi' : body.target === 'org-gallery' ? 'org-gallery' : undefined;

  // Owner-checked load (loom: content id OR plain Cosmos id), same as …/definition.
  const item = await loadContentBackedItem(reportId, 'report', tenantId);
  if (!item) return jerr('report item not found or not owned by you', 404);

  const content = reportContentOf(item);
  if (!content || !Array.isArray(content.pages) || content.pages.length === 0) {
    return jerr(
      'This report has no saved definition to publish yet — open it in the designer, add at least ' +
        'one page/visual, and Save first.',
      400,
    );
  }
  const dataSource = readReportDataSource(item);

  // Decide the target. Power BI is reached only when explicitly requested, or
  // auto-selected by the opt-in BI backend; otherwise the Azure-native gallery.
  const wantPbi = requested === 'powerbi' || (requested === undefined && PBI_OPT_IN);
  if (wantPbi) {
    const ws = resolveWorkspace(item);
    if (ws) {
      try {
        return await publishToPowerBi(session, item, reportId, ws, content);
      } catch (e: any) {
        return jerr(e?.message || String(e), 502);
      }
    }
    // Explicit Power BI request but no workspace → honest gate (no-vaporware).
    if (requested === 'powerbi') {
      return jgate({
        reason: 'Power BI was selected as the publish target but no Fabric workspace is bound.',
        remediation:
          'Bind a Fabric workspace to this report (state.fabricWorkspaceId) or set the ' +
          'LOOM_DEFAULT_FABRIC_WORKSPACE environment variable, then publish again. Power BI is ' +
          'opt-in — the Azure-native Organization gallery (target:"org-gallery") needs no workspace.',
      });
    }
    // Auto-selected Power BI but no workspace → fall through to the Azure-native
    // gallery. Fabric is NEVER a hard requirement (no-fabric-dependency.md).
  }

  // Default, Azure-native: publish a snapshot to the Organization gallery.
  const category =
    str((item.state as Record<string, unknown>)?.category) ||
    str(item.description) ||
    'Reports';
  try {
    const doc = await publishLoomReport(tenantId, who, reportId, {
      name: item.displayName,
      category,
      content,
      dataSource,
    });
    // Doc-id contract (guards the published card → consumer re-render path):
    // the shared store writes `doc.id === doc.reportId === reportId`, the PLAIN
    // report item id — NEVER a prefixed id like `loom-report:<id>`. The org
    // gallery surfaces that id as the card id, and the consumer re-renders by
    // POSTing it back to `/api/items/report/<id>/query`, whose `isLoomContentId`
    // only strips the `loom:` prefix — any OTHER prefix would 404. We therefore
    // surface `reportId` explicitly alongside `id` (the same field the opt-in
    // Power BI path returns) so the consumer always has the directly-queryable
    // report item id even if the gallery card id scheme ever changes.
    return NextResponse.json({
      ok: true,
      target: 'org-gallery' as const,
      link: '/org-reports',
      id: doc.id,
      reportId: doc.reportId,
      publishedAt: doc.publishedAt,
    });
  } catch (e: any) {
    return jgate({
      reason: 'The Organization report gallery store is not reachable.',
      remediation:
        'The published-report snapshot is written to the Cosmos `coe-templates` container ' +
        '(the same store that backs the CoE library + Organization reports). Ensure Cosmos DB is ' +
        `provisioned and the Console UAMI has data-plane access. (underlying error: ${
          (e?.message || String(e)).slice(0, 200)
        })`,
    });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const tenantId = session.claims.oid;

  const rawId = (await ctx.params).id;
  const reportId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  // Owner-check before mutating the snapshot.
  const item = await loadContentBackedItem(reportId, 'report', tenantId);
  if (!item) return jerr('report item not found or not owned by you', 404);

  try {
    // Idempotent: a never-published report is already "unpublished" (returns false).
    await unpublishLoomReport(tenantId, reportId);
    return NextResponse.json({ ok: true, target: 'org-gallery' as const });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}

/**
 * GET /api/admin/audit-logs — F19 Audit logs.
 *   ?q=      free-text search (who / kind / itemId / key)
 *   &type=   event kind / operationType filter
 *   &since=  ISO start time (lower bound)
 *   &until=  ISO end time (upper bound, optional)
 *   &user=   UPN substring filter
 *   &itemId= itemId / asset GUID filter
 *   &top=    max rows (default 200, max 1000)
 *
 * Sources (all three run in parallel; secondary failures degrade gracefully
 * into honest gates instead of failing the whole request):
 *   1. Cosmos audit-log container — Loom-native events, always attempted
 *      (primary — its failure is fatal).
 *   2. Purview Data Map /datamap/api/audit/query — governance events,
 *      honest-gated when LOOM_PURVIEW_ACCOUNT is unset or the UAMI lacks a
 *      Data Map role.
 *   3. Log Analytics AppTraces — Loom-app events, honest-gated when
 *      LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset.
 *
 * Response: { ok, total, rows, kinds, gates: { purview?, la? } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  queryAuditLog,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import {
  queryLoomAppEvents,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Shared AuditRow shape (page.tsx mirrors this).
interface AuditRow {
  id: string;
  itemId: string;
  tenantId: string;
  who: string;
  at: string;
  kind: string;
  key?: string;
  from?: unknown;
  to?: unknown;
  source: 'cosmos' | 'purview' | 'loganalytics';
  category?: string;
  message?: string;
  [k: string]: unknown;
}

// Detect an azure-identity credential-acquisition failure (the MI/dev chain
// could not produce a token) so the route can render an honest gate instead of
// leaking a raw `ChainedTokenCredential authentication failed …` stack trace.
function isCredentialError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  const name = e?.name || '';
  if (name === 'AggregateAuthenticationError' || name === 'CredentialUnavailableError' || name === 'AuthenticationError') {
    return true;
  }
  const msg = e?.message || '';
  return /ChainedTokenCredential|DefaultAzureCredential|ManagedIdentityCredential|EnvironmentCredential|authentication failed/i.test(msg);
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid; // scopes Cosmos to this user's OID (existing design)

  const p = req.nextUrl.searchParams;
  const q      = (p.get('q')      || '').toLowerCase().trim();
  const type   = (p.get('type')   || '').trim();
  const since  = (p.get('since')  || '').trim();
  const until  = (p.get('until')  || '').trim();
  const user   = (p.get('user')   || '').trim();
  const itemId = (p.get('itemId') || '').trim();
  const top    = Math.min(1000, Math.max(1, Number(p.get('top') || 200)));

  const gates: { purview?: string; purviewInfo?: string; la?: string } = {};

  // ── 1. Cosmos (primary) ────────────────────────────────────────────────────
  async function fetchCosmos(): Promise<AuditRow[]> {
    const c = await auditLogContainer();
    const where: string[] = ['c.tenantId = @tenant'];
    const params: { name: string; value: unknown }[] = [{ name: '@tenant', value: tenantId }];
    if (type)  { where.push('c.kind = @kind'); params.push({ name: '@kind',  value: type  }); }
    if (since) { where.push('c.at >= @since'); params.push({ name: '@since', value: since }); }
    if (until) { where.push('c.at <= @until'); params.push({ name: '@until', value: until }); }
    const { resources } = await c.items.query({
      query: `SELECT TOP @top * FROM c WHERE ${where.join(' AND ')} ORDER BY c.at DESC`,
      parameters: [...params, { name: '@top', value: top }],
    }).fetchAll();
    let rows = resources as any[];
    if (q)      rows = rows.filter((r: any) => [r.who, r.kind, r.key, r.itemId].some((v) => (v || '').toLowerCase().includes(q)));
    if (itemId) rows = rows.filter((r: any) => (r.itemId || '').toLowerCase().includes(itemId.toLowerCase()));
    if (user)   rows = rows.filter((r: any) => (r.who    || '').toLowerCase().includes(user.toLowerCase()));
    return rows.map((r: any): AuditRow => ({ ...r, source: 'cosmos' }));
  }

  // ── 2. Purview governance events ───────────────────────────────────────────
  // The classic Data Map audit/query endpoint is per-asset: it needs a GUID (or
  // qualifiedName). When the operator hasn't entered an Item ID filter,
  // queryAuditLog short-circuits and returns `needsAsset` — we surface that as
  // an informational gate (not an error), so the page no longer shows the raw
  // "Illegal argument: Either guid or typeName/qualifiedName not provided"
  // banner. An asset GUID typed into the Item ID filter loads its real history.
  async function fetchPurview(): Promise<AuditRow[]> {
    const page = await queryAuditLog({
      startTime:     since  || undefined,
      endTime:       until  || undefined,
      userId:        user   || undefined,
      operationType: type   || undefined,
      guid:          itemId || undefined,
      keywords:      q      || undefined,
      pageSize:      top,
    });
    if (page.needsAsset) gates.purviewInfo = page.needsAsset;
    return page.events.map((e): AuditRow => ({
      id:       e.id,
      itemId:   e.itemId,
      tenantId: '', // Purview events are not tenant-scoped the same way
      who:      e.who,
      at:       e.at,
      kind:     e.kind,
      source:   'purview',
      category: e.category,
    }));
  }

  // ── 3. Log Analytics app events ────────────────────────────────────────────
  async function fetchLA(): Promise<AuditRow[]> {
    const events = await queryLoomAppEvents({
      startTime: since  || undefined,
      endTime:   until  || undefined,
      user:      user   || undefined,
      eventType: type   || undefined,
      itemId:    itemId || undefined,
      limit:     top,
    });
    return events.map((e): AuditRow => ({
      id:       `la-${e.at}-${e.who}-${e.kind}`,
      itemId:   e.itemId,
      tenantId: '',
      who:      e.who,
      at:       e.at,
      kind:     e.kind,
      source:   'loganalytics',
      message:  e.message,
    }));
  }

  try {
    const [cosmosRes, purviewRes, laRes] = await Promise.allSettled([
      fetchCosmos(),
      fetchPurview(),
      fetchLA(),
    ]);

    // Cosmos failure is fatal (primary source) — propagate.
    if (cosmosRes.status === 'rejected') throw cosmosRes.reason;
    const cosmosRows: AuditRow[] = cosmosRes.value;

    const purviewRows: AuditRow[] = [];
    if (purviewRes.status === 'fulfilled') {
      purviewRows.push(...purviewRes.value);
    } else {
      const err = purviewRes.reason;
      if (err instanceof PurviewNotConfiguredError) {
        gates.purview = `Purview audit unavailable: ${err.message}`;
      } else if (err instanceof PurviewError && (err.status === 401 || err.status === 403)) {
        gates.purview = `Purview audit: the Loom UAMI lacks a Data Map role (${err.status}). Grant "Data Reader" on the root collection via scripts/csa-loom/grant-purview-datamap-role.sh.`;
      } else if (isCredentialError(err)) {
        gates.purview = 'Purview audit: the Console managed identity could not authenticate. Confirm LOOM_UAMI_CLIENT_ID is set in admin-plane/main.bicep apps[] env and the user-assigned identity is attached to the Console Container App.';
      } else {
        gates.purview = `Purview audit: ${(err as Error)?.message || String(err)}`;
      }
    }

    const laRows: AuditRow[] = [];
    if (laRes.status === 'fulfilled') {
      laRows.push(...laRes.value);
    } else {
      const err = laRes.reason;
      if (err instanceof MonitorNotConfiguredError) {
        gates.la = 'Log Analytics unavailable: LOOM_LOG_ANALYTICS_WORKSPACE_ID is derived by modules/admin-plane/main.bicep (monitoring.outputs.lawCustomerId) on a push-button deploy — set it there (apps[] env) or via /admin/env-config if unset. Cosmos + Purview audit rows still show without it.';
      } else if (err instanceof MonitorError && (err.status === 401 || err.status === 403)) {
        // Token acquired but the workspace rejected the read — the UAMI lacks
        // a read role on the LA workspace. Bootstrap grants Monitoring
        // Contributor on the Loom RGs (which cascades read to the LAW).
        gates.la = `Log Analytics: the Loom Console managed identity lacks read on the workspace (${err.status}). Grant "Monitoring Reader" (or "Log Analytics Reader") on LOOM_LOG_ANALYTICS_WORKSPACE_ID — the csa-loom-post-deploy-bootstrap workflow grants Monitoring Contributor on the Loom resource groups.`;
      } else if (isCredentialError(err)) {
        // azure-identity ChainedTokenCredential/DefaultAzureCredential failed
        // to acquire a token at all — the Console managed identity could not
        // authenticate. Never leak the raw credential stack trace.
        gates.la = 'Log Analytics: the Console managed identity could not authenticate. Confirm LOOM_UAMI_CLIENT_ID is set in admin-plane/main.bicep apps[] env and the user-assigned identity is attached to the Console Container App.';
      } else {
        gates.la = `Log Analytics: ${(err as Error)?.message || String(err)}`;
      }
    }

    // Merge + deduplicate, sort DESC by `at`, cap to `top`.
    const all: AuditRow[] = [...cosmosRows, ...purviewRows, ...laRows];
    const seen = new Set<string>();
    const rows = all
      .filter((r) => { const k = `${r.source}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, top);

    const kinds = Array.from(new Set(rows.map((r) => r.kind).filter(Boolean))).sort();

    return NextResponse.json({ ok: true, total: rows.length, rows, kinds, gates });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

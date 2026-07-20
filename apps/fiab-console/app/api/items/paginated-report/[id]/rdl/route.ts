/**
 * GET /api/items/paginated-report/[id]/rdl
 * PUT /api/items/paginated-report/[id]/rdl   body: { rdl: string }
 *
 * Persists a raw RDL definition onto the item's `state.rdlXml` — the EXACT slot
 * `/api/items/paginated-report/[id]/render` reads as its Azure-native default
 * source (`storedRdl = item.state.rdlXml`). Until now an imported .rdl could be
 * rendered transiently (POST /render { rdl }) but there was NO way to PERSIST it,
 * so a freshly-created paginated-report item always re-gated with "No RDL
 * definition available" on reload. This route makes an imported RDL survive.
 *
 * (The structured `RdlReportDefinition` designer model has its own store via
 * /definition; this route owns the raw-RDL import/render seam specifically.)
 *
 * Body: { rdl: string }   — a non-empty RDL XML document (<= 4 MB).
 * 200 → { ok:true, bytes }        400 → missing / non-XML / too large
 * 404 → item not found / not owned
 *
 * Azure-native: the RDL datasets execute against Synapse serverless at render
 * time — no Fabric / Power BI (no-fabric-dependency). Real Cosmos write (no
 * mocks, no-vaporware).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'paginated-report';
const MAX_RDL_BYTES = 4 * 1024 * 1024; // 4 MB

/** A minimal structural check that the payload is an RDL document, not garbage. */
function looksLikeRdl(xml: string): boolean {
  const head = xml.slice(0, 4096);
  // Must contain a <Report ...> root (optionally after an <?xml ...?> prolog).
  return /<Report[\s>]/.test(head);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('paginated report not found or not owned by you');
    const rdl = typeof (item.state as any)?.rdlXml === 'string' ? (item.state as any).rdlXml as string : '';
    return apiOk({ rdl, bytes: Buffer.byteLength(rdl, 'utf-8') });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const rdl = typeof body.rdl === 'string' ? body.rdl.trim() : '';
    if (!rdl) return apiError('rdl is required (a non-empty RDL XML string).', 400);
    if (Buffer.byteLength(rdl, 'utf-8') > MAX_RDL_BYTES) return apiError('RDL exceeds the 4 MB limit.', 413);
    if (!looksLikeRdl(rdl)) return apiError('payload does not look like an RDL document (no <Report> root element).', 400);

    // Load first (404 before write) and MERGE onto existing state (updateOwnedItem
    // replaces state wholesale — preserve sibling keys).
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('paginated report not found or not owned by you');

    const nextState = { ...(item.state as Record<string, unknown> | undefined), rdlXml: rdl };
    const saved = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!saved) return apiNotFound('paginated report not found or not owned by you');

    return apiOk({ bytes: Buffer.byteLength(rdl, 'utf-8') });
  } catch (e) {
    return apiServerError(e);
  }
}

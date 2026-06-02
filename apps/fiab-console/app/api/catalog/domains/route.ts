/**
 * /api/catalog/domains — the catalog "Domains" surface.
 *
 * IMPORTANT — classic Data Map vs. unified-catalog business domains
 * ----------------------------------------------------------------------------
 * The account provisioned for CSA Loom (`purview-csa-loom-eastus2`) is a
 * CLASSIC Microsoft.Purview/accounts (Data Map) account. The NEW unified-catalog
 * concept of "business / governance domains" (`/datagovernance`) is ONLY exposed
 * by a Purview account onboarded in the new experience (purview.microsoft.com)
 * — see lib/azure/purview-client.ts and docs/fiab/purview-setup.md.
 *
 * So instead of throwing a hard 501 (which made the whole tab a dead error
 * banner), GET returns the governance surface the classic Data Map DOES expose
 * and which actually works on this account:
 *
 *   - collections   — the classic Data Map's organizational + security boundary
 *                     (the closest classic equivalent of a domain). Real REST:
 *                     GET {account}.purview.azure.com/collections
 *                     https://learn.microsoft.com/rest/api/purview/accountdataplane/collections/list-collections
 *   - glossaryTerms — the business glossary (Apache Atlas 2.2). Real REST:
 *                     GET {account}.purview.azure.com/datamap/api/atlas/v2/glossary/{guid}/terms
 *                     https://learn.microsoft.com/purview/data-gov-api-atlas-2-2
 *
 * GET also returns `unifiedCatalog: { available:false, hint }` describing — as an
 * honest INFO note, not an error — that unified-catalog business domains require
 * the new experience. The page renders that as a single info MessageBar while the
 * classic surface below stays fully usable.
 *
 * POST / DELETE map to unified-catalog business-domain CRUD, which a classic
 * account cannot perform. They stay honestly gated (PurviewUnifiedCatalogGateError
 * → 501 + hint) per .claude/rules/no-vaporware.md — no fabricated success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listCollections, listGlossaryTerms,
  createBusinessDomain, deleteBusinessDomain,
  PurviewNotConfiguredError, PurviewError,
  type PurviewUnifiedCatalogGateError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Honest INFO note (not an error): unified-catalog business domains require a
 * Purview account in the new experience. Mirrors the typed gate hint from
 * purview-client so the copy stays consistent with the rest of the console.
 */
const UNIFIED_CATALOG_NOTE = {
  available: false as const,
  title: 'Business domains live in the new Purview experience',
  detail:
    'Unified Catalog "business / governance domains" are only exposed by a ' +
    'Microsoft Purview account onboarded in the new experience (purview.microsoft.com). ' +
    'The account wired into this deployment is a classic Data Map account ' +
    '(Microsoft.Purview/accounts), which does not expose the /datagovernance ' +
    'business-domains surface. The classic Data Map catalog below — collections ' +
    'and glossary terms — is fully usable on this account.',
  portal: 'https://purview.microsoft.com/',
  doc: 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/purview-setup.md',
};

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    // Both calls hit the CLASSIC Data Map data plane that this account exposes.
    const [collections, glossaryTerms] = await Promise.all([
      listCollections(),
      listGlossaryTerms(),
    ]);
    return NextResponse.json({
      ok: true,
      collections,
      glossaryTerms,
      // Unified-catalog business domains: empty on a classic Data Map account
      // (honest, not fabricated). Kept for back-compat with other consumers
      // (e.g. lib/editors/apim-editors.tsx) that read `domains`.
      domains: [] as { id: string; name: string }[],
      unifiedCatalog: UNIFIED_CATALOG_NOTE,
    });
  } catch (e: any) {
    // Only an *unset* account (or an actual data-plane failure) reaches here —
    // the classic calls don't throw the unified-catalog gate.
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof PurviewError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
    // Honestly gated on a classic account (throws PurviewUnifiedCatalogGateError).
    const domain = await createBusinessDomain(body);
    return NextResponse.json({ ok: true, domain });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      const gate = e as PurviewUnifiedCatalogGateError;
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, gate: gate.gate }, { status: 501 });
    }
    const status = e instanceof PurviewError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });
  try {
    await deleteBusinessDomain(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      const gate = e as PurviewUnifiedCatalogGateError;
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, gate: gate.gate }, { status: 501 });
    }
    const status = e instanceof PurviewError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

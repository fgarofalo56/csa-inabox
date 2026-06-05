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
  listCollections, listGlossaryTerms, listBusinessDomains,
  createBusinessDomain, deleteBusinessDomain,
  PurviewNotConfiguredError, PurviewError,
  type PurviewUnifiedCatalogGateError,
} from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Neutral INFO note (not an error): on the classic Data Map account a Loom
 * domain maps to a Purview COLLECTION (the closest 1:1 governance grouping the
 * classic data plane exposes). Business domains are fully usable here — they
 * are just backed by collections, not the new-experience /datagovernance API.
 */
const CLASSIC_DOMAIN_NOTE = {
  available: true as const,
  title: 'Domains mirror to Purview collections',
  detail:
    'This deployment uses a classic Microsoft Purview Data Map account. A Loom ' +
    'domain mirrors 1:1 to a Purview collection (the classic equivalent of a ' +
    'business domain) — create, list, and delete all work here. The new-' +
    'experience unified catalog (purview.microsoft.com) additionally exposes ' +
    'data products + governance domains, but is not required.',
  portal: 'https://purview.microsoft.com/',
  doc: 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/purview-setup.md',
};

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    // Classic Data Map data plane. listBusinessDomains() returns the account's
    // collections projected as domains (purview-client maps domain ⇄ collection).
    const [domains, collections, glossaryTerms] = await Promise.all([
      listBusinessDomains(),
      listCollections(),
      listGlossaryTerms(),
    ]);
    return NextResponse.json({
      ok: true,
      collections,
      glossaryTerms,
      // Domains = collections on classic Data Map (real, not fabricated).
      domains: domains.map((d) => ({ id: d.id, name: d.name, description: d.description })),
      unifiedCatalog: CLASSIC_DOMAIN_NOTE,
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

/**
 * /api/admin/classifications
 *
 * Custom CLASSIFICATION rules — name + match strategy (column-name-regex | data-regex | dictionary)
 * + the classification it applies (PII/PHI/PCI/Confidential/etc.).
 *
 * GET  /api/admin/classifications — list tenant classification rules + Purview sync state
 * POST /api/admin/classifications   body: { name, matchStrategy, matchValue, classification }
 * POST /api/admin/classifications   body: { syncOnly: true }  → re-push the taxonomy to Purview
 * DELETE /api/admin/classifications?id=...
 *
 * Backed by Cosmos tenant-settings container under id="classifications:<tenantId>".
 *
 * Purview deepening (audit-t104): on every mutation the tenant taxonomy is
 * best-effort pushed to Microsoft Purview as REAL custom classification rules +
 * CUSTOM scan rule sets (syncClassificationTaxonomyToPurview). This makes the
 * taxonomy actually classify data on a scan rather than only living in Cosmos.
 * The push is best-effort: a missing LOOM_PURVIEW_ACCOUNT or a role/upstream
 * error is surfaced in the `purview` field of the response (honest gate) but
 * NEVER fails the Cosmos write — per .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { isPurviewConfigured, getPurviewAccountName } from '@/lib/azure/purview-client';
import {
  syncClassificationTaxonomyToPurview,
  removeClassificationRuleFromPurview,
  type LoomClassificationRule,
} from '@/lib/azure/purview-classification-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ClassificationRule {
  id: string;
  name: string;
  matchStrategy: 'column-name-regex' | 'data-regex' | 'dictionary';
  matchValue: string;
  classification: string;
  createdAt: string;
  createdBy: string;
}

interface ClassificationsDoc {
  id: string;
  tenantId: string;
  kind: 'classifications';
  rules: ClassificationRule[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string, _who: string): Promise<ClassificationsDoc> {
  const c = await tenantSettingsContainer();
  const docId = `classifications:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<ClassificationsDoc>();
    if (resource) return resource;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  // Deploy-readiness (#229): a brand-new tenant inherits the GLOBAL default
  // classification taxonomy seeded at deploy time by
  // scripts/csa-loom/seed-governance.sh, so the surface is POPULATED on first
  // login instead of empty (mirrors app/api/apps-catalog copy-defaults). Cloned
  // ONLY at doc-creation (this 404 path), so a user who later deletes rules is
  // not re-seeded. Best-effort: an absent GLOBAL doc falls back to [].
  let seededRules: ClassificationRule[] = [];
  try {
    const { resource: global } = await c
      .item('classifications:GLOBAL', 'GLOBAL')
      .read<ClassificationsDoc>();
    if (global?.rules?.length) {
      seededRules = global.rules.map((r) => ({
        ...r,
        createdAt: new Date().toISOString(),
        createdBy: 'csa-loom-default',
      }));
    }
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  const seed: ClassificationsDoc = {
    id: docId,
    tenantId,
    kind: 'classifications',
    rules: seededRules,
    updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

/** Best-effort taxonomy push — never throws (errors are returned to surface). */
async function pushTaxonomy(tenantId: string, rules: ClassificationRule[]) {
  try {
    return await syncClassificationTaxonomyToPurview(
      rules as LoomClassificationRule[],
      tenantId,
    );
  } catch (e: any) {
    // syncClassificationTaxonomyToPurview already catches; this is belt-and-braces.
    return {
      purviewConfigured: isPurviewConfigured(),
      account: getPurviewAccountName(),
      synced: false,
      ruleCount: 0,
      syncedRules: [],
      scanRulesets: [],
      error: e?.message || String(e),
    };
  }
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    return NextResponse.json({
      ok: true,
      rules: doc.rules,
      updatedAt: doc.updatedAt,
      // Lightweight, no-network Purview state so the UI shows the right banner
      // (live sync vs. honest gate) without probing the data plane on every GET.
      purview: { configured: isPurviewConfigured(), account: getPurviewAccountName() },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));

  // syncOnly: re-push the existing taxonomy to Purview without adding a rule.
  if (body?.syncOnly) {
    try {
      const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
      const purview = await pushTaxonomy(tenantId, doc.rules);
      return NextResponse.json({ ok: true, rules: doc.rules, purview });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

  const name = (body?.name || '').toString().trim();
  const matchStrategy = (body?.matchStrategy || '').toString().trim();
  const matchValue = (body?.matchValue || '').toString().trim();
  const classification = (body?.classification || '').toString().trim();

  if (!name || !matchStrategy || !matchValue || !classification) {
    return NextResponse.json(
      { ok: false, error: 'name, matchStrategy, matchValue, and classification required' },
      { status: 400 }
    );
  }

  const validStrategies = ['column-name-regex', 'data-regex', 'dictionary'];
  if (!validStrategies.includes(matchStrategy)) {
    return NextResponse.json(
      { ok: false, error: `invalid matchStrategy; must be one of: ${validStrategies.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const c = await tenantSettingsContainer();
    const docId = `classifications:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);

    const id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    doc.rules.push({
      id,
      name,
      matchStrategy: matchStrategy as ClassificationRule['matchStrategy'],
      matchValue,
      classification,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);

    // Generate Purview classification definitions + scan rule sets from the
    // updated taxonomy (best-effort; never fails the Cosmos write).
    const purview = await pushTaxonomy(tenantId, doc.rules);

    return NextResponse.json({ ok: true, rule: doc.rules[doc.rules.length - 1], rules: doc.rules, purview });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });

  try {
    const c = await tenantSettingsContainer();
    const docId = `classifications:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const before = doc.rules.length;
    const removed = doc.rules.find((r) => r.id === id);
    doc.rules = doc.rules.filter((r) => r.id !== id);
    if (doc.rules.length === before) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);

    // Best-effort: delete the removed rule's Purview custom classification rule,
    // then re-sync the remaining taxonomy so the scan rule sets stay accurate.
    if (removed) await removeClassificationRuleFromPurview(tenantId, removed.name);
    const purview = await pushTaxonomy(tenantId, doc.rules);

    return NextResponse.json({ ok: true, rules: doc.rules, purview });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

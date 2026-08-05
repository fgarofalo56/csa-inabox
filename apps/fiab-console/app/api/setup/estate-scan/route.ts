/**
 * POST /api/setup/estate-scan
 * ---------------------------
 * The deployment wizard's multi-subscription adoption scan.
 *
 * Takes the subscriptions the operator EXPLICITLY consented to on the scope
 * step and returns, per Loom backing service, what already exists that Loom
 * could adopt — plus a per-subscription COVERAGE LEDGER so the UI can tell the
 * difference between "there is no Purview" and "I could not read 4 of the 12
 * subscriptions you selected".
 *
 * This is a POST, not a GET, because the consented subscription list is an
 * INPUT: a GET that scans "everything visible" is the behaviour R5.1 forbids
 * ("offer a multi-subscription analysis" — offer, not just run).
 *
 * Read-only: Resource Graph queries plus one `GET /subscriptions/{id}`
 * readability probe per subscription. It writes nothing to Azure.
 *
 * Honest failure states (no-vaporware.md, R7):
 *   - no credential at all      → 200 with `fatal.code:'no_credential'` and a
 *                                 ledger of `no-access` rows. NOT an empty
 *                                 success — "nothing found" is never returned
 *                                 for something that was never read.
 *   - Graph unreachable         → 200 with `fatal.code:'graph_unreachable'`;
 *                                 subscriptions that WERE readable are marked
 *                                 `timed-out`, not `scanned`.
 *   - a subscription unreadable → that ledger row is `no-access` with the exact
 *                                 HTTP status Azure returned.
 *
 * Full ARM ids are carried in the payload (the deploy needs them to address a
 * resource exactly) but are never logged, and the UI renders name / resource
 * group / subscription display name instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { scanEstate, MAX_SCAN_SUBSCRIPTIONS } from '@/lib/setup/estate-scan';
import { decidableServices } from '@/lib/deploy/adoption-catalog';
import type { AdoptableServiceView, ServiceScanRow } from '@/lib/deploy/plan-builder';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function toView(d: ReturnType<typeof decidableServices>[number]): AdoptableServiceView {
  return {
    key: d.key,
    label: d.label,
    class: d.class,
    ...(d.createOnlyReason ? { createOnlyReason: d.createOnlyReason } : {}),
    ...(d.singleton ? { singleton: d.singleton } : {}),
    usedFor: d.usedFor,
    mutations: d.mutations,
    ...(d.roleName ? { roleName: d.roleName } : {}),
  };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Same gate as POST /api/setup/deploy — this builds a subscription-scoped
  // deployment plan, so it is an admin-tier action.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const subscriptions: string[] = Array.isArray(body?.subscriptions)
    ? body.subscriptions.filter((s: unknown) => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (subscriptions.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Select at least one subscription to scan.',
        code: 'no_scope',
      },
      { status: 400 },
    );
  }
  if (subscriptions.length > MAX_SCAN_SUBSCRIPTIONS) {
    return NextResponse.json(
      {
        ok: false,
        code: 'scope_too_large',
        error: `You selected ${subscriptions.length} subscriptions; one scan probes at most ${MAX_SCAN_SUBSCRIPTIONS}. Narrow the selection and run it again — Loom will not silently scan a subset.`,
      },
      { status: 400 },
    );
  }

  const names: Record<string, string> =
    body?.subscriptionNames && typeof body.subscriptionNames === 'object' ? body.subscriptionNames : {};

  const result = await scanEstate({
    subscriptions,
    subscriptionNames: names,
    operatorOid: session.claims?.oid,
  });

  // Fold candidates onto the catalog so every decidable service gets a row —
  // including the ones with nothing found. A service missing from the response
  // would render as "not applicable" rather than "nothing found", which is a
  // different (and unestablished) claim.
  const byKey = new Map<string, ServiceScanRow>();
  for (const def of decidableServices()) {
    byKey.set(def.key, { service: toView(def), candidates: [] });
  }
  for (const c of result.candidates) {
    byKey.get(c.serviceKey)?.candidates.push(c);
  }

  return NextResponse.json({
    ok: true,
    ledger: result.ledger,
    queryTier: result.queryTier,
    rows: Array.from(byKey.values()),
    ...(result.fatal ? { fatal: result.fatal } : {}),
  });
}

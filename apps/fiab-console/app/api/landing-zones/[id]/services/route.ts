/**
 * GET /api/landing-zones/[id]/services
 * ------------------------------------
 * List the EXISTING Azure services attached to a landing zone (§2.3) — the data
 * for the "Attached services" section on the LZ detail drawer. Real Cosmos read
 * of the Landing-Zone Service Registry (no mocks — no-vaporware.md).
 *
 * On read it also runs the day-0 BYO → registry seed reconcile (§2.6),
 * best-effort: any service reused at deploy time via `EXISTING_*` env is
 * upserted as an `origin:'day0-byo'` registry doc bound to the hub, so day-0 BYO
 * and day-2 attach converge in one registry. Idempotent.
 *
 * Pass the literal id `all` (or `hub`) to scope; any other `[id]` is a decoded
 * `${subscriptionId}/${resourceGroup}` landing-zone id. Gated to
 * `admin.attach-service` (Reader — viewing is delegable below Admin).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { listAttachedServices, reconcileDay0Byo } from '@/lib/azure/attached-services-store';
import { decodeLandingZoneId } from '@/lib/azure/landing-zone-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CAP = 'admin.attach-service';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = getSession();
  const gate = await enforceCapability(session, CAP, 'Reader');
  if (gate) return gate;

  const raw = decodeLandingZoneId(params.id);
  // `all` lists the whole tenant registry; a concrete id scopes to one LZ.
  const landingZoneId = raw === 'all' ? undefined : raw;

  // Day-0 convergence — best-effort, never blocks the read (§2.6).
  let seed: { seeded: number; skippedExisting: number } | undefined;
  try {
    const r = await reconcileDay0Byo(session!);
    seed = { seeded: r.seeded, skippedExisting: r.skippedExisting };
  } catch { /* seed is best-effort */ }

  try {
    const services = await listAttachedServices(session!, landingZoneId);
    return NextResponse.json({ ok: true, landingZoneId: landingZoneId ?? 'all', services, seed });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

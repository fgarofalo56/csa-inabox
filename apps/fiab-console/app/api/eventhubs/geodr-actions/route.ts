/**
 * Geo-DR pairing actions on the Event Hubs namespace (the namespace navigator →
 * Geo-recovery group actions). Create / break / failover via the real
 * Microsoft.EventHub/namespaces/{ns}/disasterRecoveryConfigs ARM REST.
 *
 *   POST /api/eventhubs/geodr-actions  body { action:'create', alias, partnerNamespaceId } → { ok, config }
 *   POST /api/eventhubs/geodr-actions  body { action:'delete', alias }                     → { ok }
 *   POST /api/eventhubs/geodr-actions  body { action:'failover', alias }                   → { ok, warn }
 *
 * Failover is one-way and non-reversible — surfaced via the `warn` field.
 * Honest 503 gate when the namespace env is unset. Real ARM REST. No mocks.
 * The Console UAMI's Contributor on the namespace covers pairing/break/failover.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  eventhubsConfigGate, createDisasterRecoveryConfig,
  deleteDisasterRecoveryConfig, initiateGeoDrFailover,
} from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = eventhubsConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Event Hubs namespace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const action: string = typeof body?.action === 'string' ? body.action : '';
  const alias: string = typeof body?.alias === 'string' ? body.alias.trim() : '';
  if (!alias) return NextResponse.json({ ok: false, error: 'alias is required' }, { status: 400 });

  try {
    if (action === 'create') {
      const partnerNamespaceId: string = typeof body?.partnerNamespaceId === 'string' ? body.partnerNamespaceId.trim() : '';
      if (!partnerNamespaceId) return NextResponse.json({ ok: false, error: 'partnerNamespaceId is required' }, { status: 400 });
      const config = await createDisasterRecoveryConfig(alias, partnerNamespaceId);
      return NextResponse.json({ ok: true, config });
    }
    if (action === 'delete') {
      await deleteDisasterRecoveryConfig(alias);
      return NextResponse.json({ ok: true });
    }
    if (action === 'failover') {
      await initiateGeoDrFailover(alias);
      return NextResponse.json({
        ok: true,
        warn: 'Failover is one-way and non-reversible. The original primary namespace is removed from the pairing. Event data is not replicated — only metadata. Re-pair after failover to restore geo-DR protection.',
      });
    }
    return NextResponse.json({ ok: false, error: `unknown action '${action}' (expected create|delete|failover)` }, { status: 400 });
  } catch (e: any) {
    const status = e?.status === 400 ? 400 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/**
 * HYP-9 — Loom Capacity Broker /admit proxy.
 *
 * POST /api/capacity/admit — proxies a job's requested LCU to the
 * loom-capacity-broker ACA service and returns its allow/delay/reject decision.
 *
 * Choke-point wiring into the engine job-submit paths (Synapse Spark, Databricks,
 * ADX, AML, Loom Direct Lake framing) is HYP-11 and is NOT done here — this route
 * is the admin/testing surface + the contract the choke-points will reuse.
 *
 * Session gating (copied from the sibling app/api/admin/capacity/guardrails
 * route — NOT getSession-only): this administers an ORG-WIDE capacity control,
 * so it is tenant-admin gated. Honest 503 (no-vaporware.md) when the broker is
 * not deployed, naming LOOM_CAPACITY_BROKER_URL + the bicep module.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiUnauthorized, apiHonestError } from '@/lib/api/respond';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import {
  admit,
  capacityBrokerConfigured,
  BrokerNotConfiguredError,
  type AdmitRequest,
} from '@/lib/azure/capacity-broker-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  // Honest infra gate — the broker constrains but never blocks the platform from
  // running if it isn't deployed (default-ON posture, PRP §7.3).
  if (!capacityBrokerConfigured()) {
    return apiHonestError(
      'Loom Capacity Broker not deployed. Set LOOM_CAPACITY_BROKER_URL (deploy ' +
        'platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep, minReplicas 2). ' +
        'Job submission proceeds unthrottled until the broker is wired.',
      503,
    );
  }

  const body = (await req.json().catch(() => null)) as Partial<AdmitRequest> | null;
  if (!body || typeof body !== 'object') return apiError('request body required', 400);
  if (!body.engine || typeof body.engine !== 'string') return apiError('engine required', 400);
  const requestedUnits = Number(body.requestedUnits);
  if (!Number.isFinite(requestedUnits) || requestedUnits < 0) {
    return apiError('requestedUnits must be a number >= 0', 400);
  }

  try {
    const result = await admit({
      // Tenant is server-derived from the session — never trusted from the body.
      tenantId: tenantScopeId(s),
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : undefined,
      engine: body.engine,
      requestedUnits,
      class: body.class === 'background' ? 'background' : 'interactive',
    });
    return apiOk({ result });
  } catch (e) {
    if (e instanceof BrokerNotConfiguredError) {
      return apiHonestError(e.message, 503);
    }
    return apiServerError(e, 'Capacity admission failed');
  }
}

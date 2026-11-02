/**
 * API Gateway hub - pure model helpers (W1-5). No React, no fetch: node-testable.
 *
 * The hub consumes the registry (W1-2) and the gate family (W1-6); it does not
 * redefine either. Everything here only maps a registered gateway record onto
 * the inputs those modules already specify.
 */
import type { GatewayCloud, GatewayDoc } from '@/lib/api-gateway/registry/types';
import {
  evaluateApiGatewayGates,
  readinessGapsFor,
  type ApiGatewayBoundary,
  type ApiGatewayGateInstance,
  type ApiGatewayReadinessGap,
} from '@/lib/gates/registry/api-gateway';

/** Gateway cloud -> the boundary the plane declares gaps for. */
export function boundaryOf(cloud: GatewayCloud): ApiGatewayBoundary {
  switch (cloud) {
    case 'AzureUSGovernment': return 'GCC-High';
    case 'AzureDOD': return 'IL5';
    default: return 'Commercial';
  }
}

/**
 * Whether the boundary offers the GatewayLlmLogs diagnostic category, per the
 * W0 measurement (W0-RECEIPT.md section 1): offered on Commercial, absent on
 * GCC-High, not measured on IL5 (and never claimed as offered).
 */
export function llmLogsFor(boundary: ApiGatewayBoundary): 'offered' | 'rejected' | 'not-measured' {
  if (boundary === 'Commercial') return 'offered';
  if (boundary === 'GCC-High') return 'rejected';
  return 'not-measured';
}

/** Evaluate the family gates for one registered gateway. No telemetry probe runs today, so it is 'unprobed' (unknown is not a finding). */
export function gatesFor(gw: GatewayDoc): ApiGatewayGateInstance[] {
  const boundary = boundaryOf(gw.cloud);
  return evaluateApiGatewayGates({
    boundary,
    resourceId: gw.resourceId,
    access: gw.access,
    managementMode: gw.managementMode,
    telemetryProbe: 'unprobed',
    llmLogs: llmLogsFor(boundary),
  });
}

/** Readiness gaps declared for this gateway's boundary (owner + substitute + review date). */
export function gapsFor(gw: GatewayDoc): ApiGatewayReadinessGap[] {
  return readinessGapsFor(boundaryOf(gw.cloud));
}

/**
 * The query value the Manage panes pass as `gatewayId`. The deploy-owned gateway
 * IS the default target of /api/apim/*, so it carries NO `?gateway=` (the routes
 * run untouched); a registered gateway carries its id.
 */
export function paneGatewayId(gw: Pick<GatewayDoc, 'id' | 'ownedBy'>): string | undefined {
  return gw.ownedBy === 'deploy' ? undefined : gw.id;
}

/** The three read-only checks that actually run today, derived from the stored access record. */
export interface TelemetryCheck {
  id: 'read-access';
  label: string;
  state: 'pass' | 'fail';
  detail: string;
}

/**
 * The Telemetry card shows ONLY checks that run today. The W1-2 preflight records
 * read/write access at registration; no logger or diagnostic-routing check exists
 * in the codebase yet (W0-RECEIPT.md: `logger` 0 lines), so none is invented here.
 */
export function telemetryChecks(gw: GatewayDoc): TelemetryCheck[] {
  const a = gw.access;
  return [
    {
      id: 'read-access',
      label: 'Read access',
      state: a.canRead ? 'pass' : 'fail',
      detail: a.canRead
        ? `Console identity can read this service (${a.source === 'permissions' ? 'effective permissions' : 'service probe'}, checked ${a.checkedAt}).`
        : `Console identity cannot read this service (checked ${a.checkedAt}).`,
    },
  ];
}

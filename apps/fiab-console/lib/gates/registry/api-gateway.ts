/**
 * R30 fragment - the `api-gateway.*` gate family (API Gateway Plane, W1-6).
 *
 * WHY THIS IS NOT A GATE_META FRAGMENT. Every other fragment enriches an
 * ENV_CHECKS spec: its state is "is this env var set". These three gates are
 * per-gateway STATE (what the host identity can do at ONE APIM scope, what a
 * telemetry probe returned, which diagnostic category a boundary offers), so
 * they have no env var and no ENV_CHECKS spec. Adding them to GATE_META would
 * make them orphans and fail the registry census (GATES === ENV_CHECKS);
 * adding fake specs would invent env vars. They are therefore a separate,
 * pure family: static definitions + `evaluateApiGatewayGates()` over observed
 * state. LOOM-INTEGRATION.md section 8 is the spec.
 *
 * Import ONLY from './types' (and the pure W1-2 preflight leaf) - never
 * './index' (barrel-cycle rule). Role ids and the az command are REUSED from
 * lib/api-gateway/registry/preflight.ts, not retyped.
 */
import type { GatewayAccess, MissingRole } from '@/lib/api-gateway/registry/types';
import {
  ROLE_APIM_CONTRIBUTOR,
  ROLE_MONITORING_READER,
  ROLE_READER,
  buildMissingRole,
} from '@/lib/api-gateway/registry/preflight';
import type { GateDef, GateFixit } from './types';

export const API_GATEWAY_GATE_IDS = {
  gatewayRole: 'api-gateway.gateway-role',
  monitoringReader: 'api-gateway.monitoring-reader',
  llmLogsUnavailable: 'api-gateway.llm-logs-unavailable',
} as const;

/** Boundaries the plane declares gaps for (cloud-parity.md). */
export type ApiGatewayBoundary = 'Commercial' | 'GCC-High' | 'IL5' | 'GCC';

/**
 * A family gate. Same shape as GateDef except `fixit` may be null: the
 * llm-logs gate is a DECLARED GAP (LOOM-INTEGRATION.md section 8: FixitKind
 * "none") - there is no action the platform or the operator can take, so a
 * fabricated Fix-it would be a button that does nothing (no-vaporware.md).
 * It carries `declaredGap` instead, naming the substitute.
 */
export type ApiGatewayGateDef = Omit<GateDef, 'fixit'> & { fixit: GateFixit | null };

const SURFACES = [
  { path: '/admin/api-gateway', label: 'API Gateway - registry' },
  { path: '/admin/readiness', label: 'Readiness - API Gateway Plane' },
];

export const API_GATEWAY_GATES: ApiGatewayGateDef[] = [
  {
    id: API_GATEWAY_GATE_IDS.gatewayRole,
    title: 'API gateway: host identity lacks access at the service scope',
    category: 'permissions',
    severity: 'critical',
    surfaces: SURFACES,
    requiredSettings: [],
    role: `${ROLE_READER.name} (observe) / ${ROLE_APIM_CONTRIBUTOR.name} (manage)`,
    remediation:
      'Grant the Console identity Reader (observe) or API Management Service Contributor (manage) at the APIM service scope.',
    canAutoResolve: false,
    fixit: { kind: 'role-grant' },
    legacyCodes: [],
  },
  {
    id: API_GATEWAY_GATE_IDS.monitoringReader,
    title: 'API gateway: telemetry probe denied (Monitoring Reader missing)',
    category: 'permissions',
    severity: 'recommended',
    surfaces: SURFACES,
    requiredSettings: [],
    role: ROLE_MONITORING_READER.name,
    remediation: 'Grant the Console identity Monitoring Reader at the APIM service scope.',
    canAutoResolve: false,
    fixit: { kind: 'role-grant' },
    legacyCodes: [],
  },
  {
    id: API_GATEWAY_GATE_IDS.llmLogsUnavailable,
    title: 'API gateway: LLM logs (GatewayLlmLogs) unavailable in this boundary',
    category: 'observability',
    severity: 'recommended',
    surfaces: SURFACES,
    requiredSettings: [],
    remediation:
      'Declared gap, not an operator action: this boundary does not offer the GatewayLlmLogs diagnostic category. See the readiness row for the substitute and owner (#4460).',
    canAutoResolve: false,
    fixit: null,
    legacyCodes: [],
  },
];

export function getApiGatewayGate(id: string): ApiGatewayGateDef | undefined {
  return API_GATEWAY_GATES.find((g) => g.id === id);
}

// ── readiness rows: declared gaps (W0-RECEIPT.md section 9.5) ────────────────

export interface ApiGatewayReadinessGap {
  gap: string;
  boundary: ApiGatewayBoundary;
  /** Owner and next step, verbatim from W0-RECEIPT.md 9.5. */
  owner: string;
  /** What is used instead meanwhile; null = nothing is substituted (refuse). */
  substitute: string | null;
  /** Review date (ISO) or the condition that triggers re-measurement. */
  review: string;
  /** True when the boundary was measured; false = supported-in-code, never exercised / not measured. */
  measured: boolean;
}

export const API_GATEWAY_READINESS_GAPS: ApiGatewayReadinessGap[] = [
  {
    gap: 'GatewayLlmLogs absent',
    boundary: 'GCC-High',
    owner: 'W4: meter from llm-emit-token-metric and GatewayLogs; re-read the category list at each Government registration',
    substitute: 'llm-emit-token-metric and GatewayLogs',
    review: '2026-12-01',
    measured: true,
  },
  {
    gap: 'MCP API type (api-version 2025-09-01-preview not registered)',
    boundary: 'GCC-High',
    owner: 'W6: console-hosted MCP behind the gateway as a plain API (D15); re-run the mcp family when a newer version registers',
    substitute: 'console-hosted MCP behind the gateway as a plain API (D15)',
    review: '2026-12-01',
    measured: true,
  },
  {
    gap: 'Agent ID, UAMI roles, sign-in app',
    boundary: 'GCC-High',
    owner: 'operator: grant Application.Read.All (Q19), then re-run identity',
    substitute: null,
    review: 'on grant',
    measured: true,
  },
  {
    gap: 'Named-value latency and runtime enforcement',
    boundary: 'GCC-High',
    owner: 'W1 Government verifier from an in-boundary runner (Q18)',
    substitute: null,
    review: 'W1 merge',
    measured: true,
  },
  {
    gap: 'services.ai.azure.com VNet resolution',
    boundary: 'GCC-High',
    owner: 'same in-boundary runner (Q18)',
    substitute: null,
    review: 'W1 merge',
    measured: true,
  },
  {
    gap: 'Everything (LLM logs, token limits, MCP type not measured)',
    boundary: 'IL5',
    owner: 'measured when an IL5 deploy run exists; token limits are refused where unavailable, never substituted silently',
    substitute: null,
    review: 'on first receipt',
    measured: false,
  },
  {
    gap: 'Everything (supported-in-code, never exercised)',
    boundary: 'GCC',
    owner: 'measured when a GCC tenant exists',
    substitute: null,
    review: 'on first receipt',
    measured: false,
  },
];

/** The declared gaps for one boundary (the readiness page lists these). */
export function readinessGapsFor(boundary: ApiGatewayBoundary): ApiGatewayReadinessGap[] {
  return API_GATEWAY_READINESS_GAPS.filter((g) => g.boundary === boundary);
}

// ── evaluation ───────────────────────────────────────────────────────────────

export interface ApiGatewayGateInput {
  boundary: ApiGatewayBoundary;
  /** Service scope (the APIM ARM resource id). */
  resourceId: string;
  /** What W1-2 preflight reported for the host identity. */
  access: GatewayAccess;
  /** Management mode requested for this gateway. */
  managementMode: 'observe' | 'manage';
  /**
   * Telemetry probe outcome. 'denied' = the probe was refused for lack of
   * Monitoring Reader; 'unprobed' = nothing was probed (no gate: unknown is
   * not a finding).
   */
  telemetryProbe: 'ok' | 'denied' | 'unprobed';
  /** Whether the boundary offers the GatewayLlmLogs diagnostic category. */
  llmLogs: 'offered' | 'rejected' | 'not-measured';
}

export interface ApiGatewayGateInstance {
  gate: ApiGatewayGateDef;
  /** The Fix-it to render; null for a declared gap. */
  fixit: GateFixit | null;
  /** role-grant gates: the exact role, scope and az command. */
  roleGrant?: MissingRole;
  /** llm-logs gate: the readiness rows (owner, date, substitute) for the boundary. */
  gaps?: ApiGatewayReadinessGap[];
}

function gateOrThrow(id: string): ApiGatewayGateDef {
  const g = getApiGatewayGate(id);
  if (!g) throw new Error(`api-gateway gate ${id} is not defined`);
  return g;
}

function roleGrantInstance(id: string, role: MissingRole): ApiGatewayGateInstance {
  return {
    gate: gateOrThrow(id),
    fixit: {
      kind: 'role-grant',
      grantNote: `Grant ${role.roleName} (${role.roleDefinitionId}) at ${role.scope}: ${role.azCommand}`,
    },
    roleGrant: role,
  };
}

/** Evaluate which family gates fire for one gateway's observed state. Pure. */
export function evaluateApiGatewayGates(input: ApiGatewayGateInput): ApiGatewayGateInstance[] {
  const out: ApiGatewayGateInstance[] = [];
  const { access, resourceId } = input;
  const needsWrite = input.managementMode === 'manage' && !access.canWrite;
  if (!access.canRead || needsWrite) {
    const role =
      access.missingRole ??
      buildMissingRole(!access.canRead ? ROLE_READER : ROLE_APIM_CONTRIBUTOR, resourceId, access.principalId);
    out.push(roleGrantInstance(API_GATEWAY_GATE_IDS.gatewayRole, role));
  }
  if (input.telemetryProbe === 'denied') {
    out.push(
      roleGrantInstance(
        API_GATEWAY_GATE_IDS.monitoringReader,
        buildMissingRole(ROLE_MONITORING_READER, resourceId, access.principalId),
      ),
    );
  }
  // Not-measured is NOT treated as offered: missing telemetry is never healthy.
  if (input.llmLogs !== 'offered') {
    out.push({
      gate: gateOrThrow(API_GATEWAY_GATE_IDS.llmLogsUnavailable),
      fixit: null,
      gaps: readinessGapsFor(input.boundary),
    });
  }
  return out;
}

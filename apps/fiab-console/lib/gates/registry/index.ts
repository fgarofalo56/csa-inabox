/**
 * CSA Loom gate registry (G2) — the complete, typed manifest of every
 * day-one configuration gate in the console.
 *
 * DERIVED, not duplicated: the backbone is `lib/admin/self-audit.ts:ENV_CHECKS`
 * (the single declarative source of every runtime LOOM_ var — title, category,
 * severity, required/anyOf keys, remediation, provisionedBy bicep module, RBAC
 * role). This module ENRICHES each spec with the gate-specific metadata the
 * registry surfaces need:
 *   - `surfaces`   — where the gate fires (pages / editors / API routes),
 *   - `fixit`      — how the inline "Fix it" wizard resolves it (env-picker /
 *                    resource-picker with a REAL ARM options-loader / role-grant
 *                    / wizard),
 *   - `legacyCodes`— the bespoke `*_not_configured` error codes routes return
 *                    today, mapped to their canonical gate id,
 *   - `canAutoResolve` — true when a push-button deploy fills the values with
 *                    zero operator input (spec.derived / spec.optionalDefault).
 *
 * A unit test (lib/gates/__tests__/registry.test.ts) asserts GATE_META covers
 * EVERY ENV_CHECKS id and carries no orphans — the two can never drift.
 *
 * Resolution goes through the ONE shared write path (lib/admin/env-apply.ts →
 * the same ACA-revision / AKS-rolling-update + Cosmos + audit machinery as
 * PUT /api/admin/env-config). No second write path (no-vaporware.md).
 */
// IMPORTANT: import from the PURE declarative layer (env-checks), NOT
// self-audit — this module is consumed by client components (HonestGate,
// /admin/gates) and self-audit's probe section lazy-imports the Azure clients
// + copilot orchestrator, which reach next/headers and must never enter a
// client bundle.
import {
  ENV_CHECKS,
  VALUE_HINT,
  evalEnv,
  type Avail,
  type EnvSpec,
  type ServiceAvailability,
} from '@/lib/admin/env-checks';
// Pure host/cloud resolver (zero server-only imports) — safe in client bundles.
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';

export type { Avail, ServiceAvailability } from '@/lib/admin/env-checks';

export * from './types';
import {
  type GateDef,
  type GateMeta,
  type GateRequiredSetting,
  type GateStatus,
} from './types';
import { IDENTITY_GATE_META } from './identity';
import { DATA_PLANE_GATE_META } from './data-plane';
import { PERMISSIONS_GATE_META } from './permissions';
import { AZURE_SERVICES_GATE_META } from './azure-services';
import { ENRICHMENT_GATE_META } from './enrichment';
import { BUILDERS_GATE_META } from './builders';
import { CATALOG_GOVERNANCE_GATE_META } from './catalog-governance';
import { AI_COPILOT_GATE_META } from './ai-copilot';
import { SECURITY_GATE_META } from './security';

// ── the merged per-gate enrichment (R30: per-domain fragments, same shape) ──
// Every ENV_CHECKS id MUST have an entry in exactly one domain fragment
// (enforced by the registry test over the merged whole).
export const GATE_META: Record<string, GateMeta> = {
  ...IDENTITY_GATE_META,
  ...DATA_PLANE_GATE_META,
  ...PERMISSIONS_GATE_META,
  ...AZURE_SERVICES_GATE_META,
  ...ENRICHMENT_GATE_META,
  ...BUILDERS_GATE_META,
  ...CATALOG_GOVERNANCE_GATE_META,
  ...AI_COPILOT_GATE_META,
  ...SECURITY_GATE_META,
};

// ── registry composition ─────────────────────────────────────────────────────

function settingsFor(spec: EnvSpec, meta: GateMeta | undefined): GateRequiredSetting[] {
  const out: GateRequiredSetting[] = [];
  const seen = new Set<string>();
  const add = (key: string, required: boolean, aliasOf?: string[]) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      envVar: key,
      description: spec.title,
      valueHint: VALUE_HINT[key] || '',
      aliasOf: aliasOf && aliasOf.length > 1 ? aliasOf : undefined,
      required,
      loader: meta?.loaders?.[key],
    });
  };
  for (const k of spec.required || []) add(k, true);
  for (const group of spec.anyOf || []) for (const k of group) add(k, false, group);
  return out;
}

/** The complete gate registry — one entry per ENV_CHECKS spec, enriched. */
export const GATES: GateDef[] = ENV_CHECKS.map((spec) => {
  const meta = GATE_META[spec.id];
  return {
    id: spec.id,
    title: spec.title,
    category: spec.category,
    severity: spec.severity,
    surfaces: meta?.surfaces || [],
    requiredSettings: settingsFor(spec, meta),
    role: spec.role,
    provisionedBy: spec.provisionedBy,
    remediation: spec.remediation,
    docs: spec.docs,
    canAutoResolve: !!(spec.derived || spec.optionalDefault),
    autoResolveNote: meta?.autoResolveNote,
    fixit: meta?.fixit || { kind: 'env-picker' },
    legacyCodes: meta?.legacyCodes || [],
    availability: spec.availability,
  };
});

const GATES_BY_ID = new Map(GATES.map((g) => [g.id, g]));

export function getGate(id: string): GateDef | undefined {
  return GATES_BY_ID.get(id);
}

/** Map a bespoke legacy error code (e.g. 'adls_not_configured') to its gate. */
export function gateForLegacyCode(code: string): GateDef | undefined {
  return GATES.find((g) => g.legacyCodes.includes(code));
}

// ── X2 — availability-gate convention ────────────────────────────────────────

/** The ServiceAvailability key for the active sovereign boundary. Commercial +
 * GCC read `commercial` (GCC runs on Commercial Azure endpoints); GCC-High
 * reads `gccHigh`; DoD deployments carry the IL5 air-gap posture → `il5`. */
export function activeCloudAvailabilityKey(): keyof Pick<ServiceAvailability, 'commercial' | 'gccHigh' | 'il5'> {
  switch (detectLoomCloud()) {
    case 'GCC-High':
      return 'gccHigh';
    case 'DoD':
      return 'il5';
    default:
      return 'commercial';
  }
}

/** The structured per-cloud availability declared on the gate's ENV_CHECKS
 * spec (X-MATRIX as data). Undefined = no declaration = GA everywhere. */
export function availabilityFor(id: string): ServiceAvailability | undefined {
  return ENV_CHECKS.find((s) => s.id === id)?.availability;
}

/** The service's availability in the ACTIVE cloud ('ga' when undeclared). */
export function availabilityInActiveCloud(id: string): Avail {
  return availabilityFor(id)?.[activeCloudAvailabilityKey()] ?? 'ga';
}

/** False ONLY when the backing service is structurally 'unavailable' in the
 * active cloud — 'limited' still counts as available (round-3 clarification:
 * 'limited' renders the surface normally + a non-blocking info note; only
 * 'unavailable' produces the cloud-unavailable gate). */
export function isAvailableInActiveCloud(id: string): boolean {
  return availabilityInActiveCloud(id) !== 'unavailable';
}

/**
 * Evaluate the LIVE status of one gate — the same env-presence evaluation the
 * self-audit runs (evalEnv), reduced to configured/blocked for the registry UI.
 * Real check: the per-client *ConfigGate() helpers gate on exactly these vars.
 */
export function gateStatus(id: string): GateStatus | undefined {
  const spec = ENV_CHECKS.find((s) => s.id === id);
  if (!spec) return undefined;
  const check = evalEnv(spec);
  const missing = check.status === 'pass'
    ? []
    : (check.detail.match(/Missing: (.+)\.$/)?.[1]?.split(', ') || []).map((m) =>
        m.includes(' | ') ? m.split(' | ')[0].trim() : m.trim());
  // X2 — cloud availability overlay. A PASSING check always stays 'configured'
  // (e.g. the ADX graph-twin satisfying svc-digital-twins in Gov). A FAILING
  // check in a cloud where the backing service is 'unavailable' becomes the
  // distinct 'cloud-unavailable' state (fallbackNote, no Fix-it) — telling the
  // operator to set an env var for a service that does not exist in their cloud
  // would be dishonest. 'limited' never changes the state: it only attaches the
  // non-blocking info note.
  const avail = spec.availability ? availabilityInActiveCloud(id) : 'ga';
  const fallbackNote = avail !== 'ga' ? spec.availability?.fallbackNote : undefined;
  const status: GateStatus['status'] = check.status === 'pass'
    ? 'configured'
    : avail === 'unavailable' ? 'cloud-unavailable' : 'blocked';
  return {
    id,
    status,
    check,
    missing,
    availability: spec.availability ? avail : undefined,
    fallbackNote,
  };
}

/** Evaluate every gate (one cheap in-process pass — no network). */
export function allGateStatuses(): GateStatus[] {
  return GATES.map((g) => gateStatus(g.id)!).filter(Boolean);
}

/**
 * #4776 — normalise a route's gate-shaped error body into the props a surface
 * hands to `<HonestGate>`, so every gated response renders through the ONE
 * registry-driven bar with a Fix-it (ux-baseline.md G2) instead of a bare
 * MessageBar or a flattened `setError(j.error)`.
 *
 * Three body shapes are recognised; anything else returns null and the caller
 * keeps its ordinary error path:
 *   1. a CLASSIFIED failure (`warehouseErrorBody`: `gateId` + `kind` other than
 *      'not-configured') — carries the route's own cause, remediation and
 *      entitlement;
 *   2. a classified 'not-configured' — the gate plus its missing var;
 *   3. a legacy `{ code:'not_configured', missing }` with no `gateId` — the
 *      gate is looked up by the missing env var in the registry. If no gate
 *      requires that var, `gateId` is '' and HonestGate renders its honest
 *      "not in the registry" bar with the route's error text.
 *
 * Client-safe: imports only the pure registry layer.
 */
import { GATES } from '@/lib/gates/registry';
import type { ClassifiedGateFailure } from '@/lib/components/shared/honest-gate';

export interface SurfaceGate {
  gateId: string;
  missing?: string;
  /** The route's own error text (used as the bar detail when not classified). */
  error?: string;
  classified?: ClassifiedGateFailure;
}

/** The first registry gate whose required settings include `envVar`, or ''. */
export function gateIdForEnvVar(envVar: string): string {
  const v = (envVar || '').trim();
  if (!v) return '';
  return GATES.find((g) => g.requiredSettings.some((s) => s.envVar === v))?.id || '';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function surfaceGateFrom(body: unknown): SurfaceGate | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== false) return null;
  const gateId = str(b.gateId);
  const kind = str(b.kind);
  const missing = str(b.missing);
  const error = str(b.error);
  if (gateId && kind && kind !== 'not-configured') {
    return {
      gateId,
      missing,
      error,
      classified: {
        kind,
        error,
        remediation: str(b.remediation),
        entitlement: str(b.entitlement),
      },
    };
  }
  if (gateId && kind === 'not-configured') return { gateId, missing, error };
  if (b.code === 'not_configured' && missing) return { gateId: gateIdForEnvVar(missing), missing, error };
  return null;
}

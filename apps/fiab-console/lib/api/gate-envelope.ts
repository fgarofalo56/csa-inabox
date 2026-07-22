/**
 * WS-D2 — the ONE normalized backend-gate envelope.
 *
 * Before this, gated routes hand-rolled slightly different not-configured
 * payloads (`{ ok:false, code:'not_configured', missing:'LOOM_X' }` here,
 * `{ ok:false, error, hint }` there, `{ status:'remediation', … }` elsewhere).
 * The editor-side {@link ../components/shared/honest-gate} renderer had to guess
 * the shape. This module gives every gated route a SINGLE shape aligned with the
 * central gate registry (lib/gates/registry.ts):
 *
 *   { ok:false, gated:true, gate:{ id, title, remediation, fixItHref, missing } }
 *
 * It is ADDITIVE, not a breaking rename: the top-level back-compat fields
 * (`code`, `error`, `missing`) that routes returned before are preserved next to
 * the new `gated`/`gate` block, so existing clients keep working while new
 * clients read the normalized `gate` block + drive the inline Fix-it wizard from
 * `gate.id` / `gate.fixItHref`.
 *
 * REAL check, no vaporware: `backendGateResponse` evaluates the gate through the
 * registry's `gateStatus(id)` — the SAME env-presence evaluation
 * (self-audit `evalEnv` over `ENV_CHECKS`) the per-client `*ConfigGate()` helpers
 * gate on — so a route that adopts this gates on exactly the vars it did before.
 */
import { NextResponse } from 'next/server';
import { getGate, gateStatus } from '@/lib/gates/registry';

/** Default HTTP status for a backend infra gate (honest "not configured"). */
export const GATE_HTTP_STATUS = 503;

/** The normalized gate block every gated route surfaces. */
export interface GateEnvelopeGate {
  /** Stable gate id == the registry / ENV_CHECKS spec id (e.g. 'svc-aisearch'). */
  id: string;
  /** Human title from the registry (e.g. 'Azure AI Search (RAG indexes)'). */
  title: string;
  /** Exact operator remediation (verbatim from the self-audit spec). */
  remediation: string;
  /** Deep link to the Admin gate registry + inline Fix-it wizard for this gate. */
  fixItHref: string;
  /** The unmet env var(s) (preferred member of each unsatisfied anyOf group). */
  missing: string[];
  /** X2 — 'cloud-unavailable' when the backing service is structurally
   * unavailable in the active cloud (vs a plain config miss = 'blocked'). The
   * HonestGate renderer drops the Fix-it and shows the fallback CTA instead. */
  state?: 'blocked' | 'cloud-unavailable';
  /** X2 — the Azure-native / OSS / Loom-native fallback for the active cloud. */
  fallbackNote?: string;
}

/**
 * The full response body. `gated:true` is the single discriminant a client
 * checks; the top-level `code`/`error`/`missing` are back-compat mirrors.
 */
export interface GateEnvelope {
  ok: false;
  gated: true;
  /** Back-compat: the bespoke code routes returned before (default 'not_configured'). */
  code: string;
  /** Back-compat: a human-readable message (defaults to the gate remediation). */
  error: string;
  /** Back-compat: the unmet env var(s), mirrored from `gate.missing`. */
  missing: string[];
  gate: GateEnvelopeGate;
}

export interface GateEnvelopeOpts {
  /** Override the unmet vars (defaults to the live `gateStatus(id).missing`). */
  missing?: string[];
  /** Override the human message (defaults to the gate remediation). */
  message?: string;
  /** Override the back-compat `code` (defaults to 'not_configured'). */
  code?: string;
  /** Override the HTTP status (defaults to 503). */
  status?: number;
}

/** The Admin gate-registry deep link (opens the inline Fix-it wizard for `id`). */
export function gateFixItHref(gateId: string): string {
  return `/admin/gates?gate=${encodeURIComponent(gateId)}`;
}

/**
 * Build the normalized gate envelope for `gateId`. Pulls title/remediation from
 * the registry and the unmet vars from the live `gateStatus` (overridable). When
 * the id is unknown to the registry it still returns an honest generic block so
 * the caller never leaks a raw backend error.
 */
export function buildGateEnvelope(gateId: string, opts: GateEnvelopeOpts = {}): GateEnvelope {
  const gate = getGate(gateId);
  const st = gateStatus(gateId);
  const missing = opts.missing ?? st?.missing ?? [];
  const title = gate?.title ?? gateId;
  const remediation = gate?.remediation ?? `Configure ${gateId} for this deployment (see /admin/gates).`;
  // X2 — surface the cloud-unavailable state + fallback so the shared
  // HonestGate renderer suppresses the Fix-it and names the Loom-native
  // equivalent instead of prompting for an impossible resource.
  const cloudUnavailable = st?.status === 'cloud-unavailable';
  return {
    ok: false,
    gated: true,
    code: opts.code ?? (cloudUnavailable ? 'cloud_unavailable' : 'not_configured'),
    error: opts.message ?? (cloudUnavailable && st?.fallbackNote ? st.fallbackNote : remediation),
    missing,
    gate: {
      id: gateId,
      title,
      remediation,
      fixItHref: gateFixItHref(gateId),
      missing,
      // Additive: the X2 fields appear ONLY on cloud-unavailable gates so the
      // plain blocked envelope shape stays byte-identical for existing clients.
      ...(cloudUnavailable
        ? { state: 'cloud-unavailable' as const, fallbackNote: st?.fallbackNote }
        : {}),
    },
  };
}

/**
 * WS-D1/D2 — the standard honest-gate error response. Use from any gated route
 * to return the normalized 503 envelope. Composes with `apiOk`/`apiError` in
 * ./respond (this is the gate-flavoured sibling of `apiHonestError`).
 */
export function apiHonestGateError(gateId: string, opts: GateEnvelopeOpts = {}): NextResponse {
  return NextResponse.json(buildGateEnvelope(gateId, opts), { status: opts.status ?? GATE_HTTP_STATUS });
}

/**
 * Evaluate a backend gate: `null` when configured (caller proceeds), or the 503
 * gate envelope when blocked. This is the primitive `withBackendGate` wraps —
 * exposed directly for routes that must run the check inside an existing context
 * (e.g. after establishing a selected-factory scope) rather than up front.
 */
export function backendGateResponse(gateId: string, opts: GateEnvelopeOpts = {}): NextResponse | null {
  const status = gateStatus(gateId);
  // X2: 'cloud-unavailable' gates too — the route must not proceed to a
  // backend that does not exist in this cloud; the envelope carries the
  // fallbackNote so the surface renders the honest no-Fix-it bar.
  if (status && status.status !== 'configured') {
    return apiHonestGateError(gateId, { missing: status.missing, ...opts });
  }
  return null;
}

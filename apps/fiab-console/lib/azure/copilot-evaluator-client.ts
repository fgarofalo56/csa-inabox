/**
 * E5 — "Run now" proxy to the copilot-evaluator Function (E2 HTTP trigger).
 *
 * The admin /admin/copilot-quality page's "Run now" button POSTs here; this
 * module fires the REAL E2 HTTP trigger
 * (`POST {LOOM_COPILOT_EVALUATOR_URL}/api/copilotEvaluatorHttp`) with the
 * requested surfaces. The Function is authLevel 'function', so the host key is
 * supplied either as a `?code=` already baked into LOOM_COPILOT_EVALUATOR_URL
 * or via the optional secret LOOM_COPILOT_EVALUATOR_KEY (x-functions-key).
 *
 * Honest-gate (no-vaporware.md): when the URL is unset OR the Function is
 * unreachable / rejects the key, this returns a structured gate/error the route
 * surfaces verbatim — NEVER a fabricated "run started". Per the 2026-07-23
 * estate note the evaluator Function fleet decision is pending, so an unreachable
 * Function is the expected default and must degrade to an honest gate, not a
 * crash. Azure-native, no Fabric dependency.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

/** The Function base URL (may already carry a `?code=` host key). */
export function evaluatorUrl(): string {
  return (process.env.LOOM_COPILOT_EVALUATOR_URL || '').trim();
}

/** Optional host key (x-functions-key) — a KV secretRef, never in EDITABLE_ENV. */
function evaluatorKey(): string {
  return (process.env.LOOM_COPILOT_EVALUATOR_KEY || '').trim();
}

export interface EvaluatorGate {
  gated: true;
  gateId: 'svc-copilot-evaluator';
  missing: string[];
  remediation: string;
}

/** Honest config gate — null when the Function URL is present, else the gate. */
export function evaluatorRunGate(): EvaluatorGate | null {
  if (evaluatorUrl()) return null;
  return {
    gated: true,
    gateId: 'svc-copilot-evaluator',
    missing: ['LOOM_COPILOT_EVALUATOR_URL'],
    remediation:
      'Deploy the copilot-evaluator Function (modules/admin-plane/copilot-evaluator-function.bicep, default-ON) and set LOOM_COPILOT_EVALUATOR_URL. "Run now" then fires the E2 HTTP trigger. Nightly + per-roll runs happen automatically regardless of this button.',
  };
}

export interface TriggerRunInput {
  surfaces?: string[];
  trigger?: 'manual' | 'corpus';
}

export interface TriggerRunResult {
  ok: boolean;
  status: number;
  /** The E2 HTTP response body (`{ok, reason, trigger, surfaces:[...]}`) when JSON. */
  body: unknown;
  error?: string;
}

/**
 * Fire the E2 on-demand run. Returns the parsed HTTP response; never throws —
 * a network failure / timeout / non-2xx becomes `{ ok:false, status, error }`
 * so the route surfaces an honest message. `surfaces` empty ⇒ the Function runs
 * every eval set.
 */
export async function triggerEvaluatorRun(input: TriggerRunInput): Promise<TriggerRunResult> {
  const base = evaluatorUrl();
  if (!base) return { ok: false, status: 503, body: null, error: 'LOOM_COPILOT_EVALUATOR_URL not set' };

  // Preserve an existing ?code= in the URL; otherwise append the header key.
  const hasInlineCode = /[?&]code=/.test(base);
  const url = `${base.replace(/\/+$/, '').replace(/\?.*$/, '')}/api/copilotEvaluatorHttp${
    hasInlineCode ? base.slice(base.indexOf('?')) : ''
  }`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = evaluatorKey();
  if (!hasInlineCode && key) headers['x-functions-key'] = key;

  const payload = {
    surfaces: Array.isArray(input.surfaces) && input.surfaces.length ? input.surfaces : undefined,
    trigger: input.trigger === 'corpus' ? 'corpus' : 'manual',
  };

  try {
    // The evaluator run is long — a per-surface judge pass can take minutes.
    // Bound at 60s: we only need to confirm the trigger was ACCEPTED (the
    // Function keeps running server-side; the page re-reads Cosmos on refresh).
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, 60_000);
    const text = (await res.text()).slice(0, 4096);
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* non-JSON — keep raw text */ }
    if (!res.ok) {
      return { ok: false, status: res.status, body, error: `evaluator returned ${res.status}` };
    }
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 502, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

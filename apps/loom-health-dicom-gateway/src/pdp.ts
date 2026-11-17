// PDP client. Contract: CONTRACT-FREEZE-W2.md section 1 and
// apps/loom-health-pdp/README.md "Decision API". Only `result.allow === true`
// permits. A missing `result` (OPA returns {} for undefined), a timeout, a non-2xx,
// a malformed body or a connection error is `unavailable` and the gateway answers
// 503. This function never throws and never returns allow on any error path.

export interface PdpRequest {
  service: 'dicom';
  interaction: 'wado' | 'qido' | 'stow';
  /** From the route, never from the body. */
  tenant: string;
  /** Base URL as the client addressed it; must be in data.lhds.stamp. */
  base: string;
}

export type PdpDecision =
  | { kind: 'allow'; reason: string; policyVersion: string }
  | { kind: 'deny'; reason: string; policyVersion: string }
  | { kind: 'unavailable'; cause: string };

export type Pdp = (token: string, request: PdpRequest) => Promise<PdpDecision>;

const MAX_PDP_BODY = 64 * 1024;

export function httpPdp(pdpUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Pdp {
  return async (token, request) => {
    try {
      const res = await fetchImpl(`${pdpUrl}/v1/data/lhds/authz/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { access_token: token, request } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { kind: 'unavailable', cause: `pdp-http-${res.status}` };
      const text = await res.text();
      if (text.length > MAX_PDP_BODY) return { kind: 'unavailable', cause: 'pdp-body-too-large' };
      const body: unknown = JSON.parse(text);
      const result = (body as { result?: unknown } | null)?.result;
      if (typeof result !== 'object' || result === null) {
        return { kind: 'unavailable', cause: 'pdp-no-result' };
      }
      const r = result as { allow?: unknown; reason?: unknown; policy_version?: unknown };
      const reason = typeof r.reason === 'string' ? r.reason : 'unspecified';
      const policyVersion = typeof r.policy_version === 'string' ? r.policy_version : 'unknown';
      if (r.allow === true) return { kind: 'allow', reason, policyVersion };
      if (r.allow === false) return { kind: 'deny', reason, policyVersion };
      return { kind: 'unavailable', cause: 'pdp-allow-not-boolean' };
    } catch (e) {
      const name = e instanceof Error ? e.name : 'error';
      return { kind: 'unavailable', cause: name === 'TimeoutError' || name === 'AbortError' ? 'pdp-timeout' : 'pdp-error' };
    }
  };
}

/** PDP reasons that mean "the credential is bad" (401), as opposed to "not permitted" (403). */
export const UNAUTHENTICATED_REASONS = new Set(['invalid-input', 'token-invalid', 'claims-invalid', 'version-unsupported', 'reserved-claim', 'issuer-mismatch', 'token-time-invalid']);

/**
 * Internal service-to-service trust token for VNet-internal callbacks.
 *
 * The MAF orchestration tier (`loom-copilot-maf`) runs the Gov-AOAI agent loop
 * but delegates tool DISPATCH back into the Console's `/api/internal/copilot/*`
 * endpoints so the exact same tool handlers (and per-user ownership) execute.
 * Those internal endpoints are NOT cookie-authenticated — the MAF app has no
 * MSAL session — so they are gated by this shared secret instead.
 *
 * `LOOM_INTERNAL_TOKEN` is wired to BOTH apps by Bicep (a deterministic
 * `guid(resourceGroup().id, …)` so the two values match) and the apps only reach
 * each other over the Container Apps Environment internal network. When the env
 * var is unset the gate FAILS CLOSED (every internal request is rejected) so the
 * endpoints are inert in deployments that didn't opt into the MAF tier.
 */
import crypto from 'node:crypto';

export const INTERNAL_TOKEN_HEADER = 'x-loom-internal-token';
export const INTERNAL_USER_OID_HEADER = 'x-user-oid';

/**
 * Constant-time check that the presented token matches the expected internal
 * trust secret.
 *
 * When `preferEnv` names a SET (non-empty) env var, ONLY that dedicated value
 * is accepted — the shared `LOOM_INTERNAL_TOKEN` is NOT consulted. This is the
 * per-service isolation the externally-handed Bearer paths rely on (rel-T10/B3):
 * the IQ MCP path (`LOOM_IQ_MCP_TOKEN`) and the deployment-pipeline CI path
 * (`LOOM_CI_TOKEN`) each get their OWN deterministic secret, so a leak of one
 * does NOT open the internal MAF callback or the other external path. When
 * `preferEnv` is omitted (or its var is unset) the shared `LOOM_INTERNAL_TOKEN`
 * is used — the VNet-internal trust token for the MAF / setup-orchestrator /
 * topology callbacks.
 *
 * Returns false when the resolved secret is missing/empty (fail closed) or the
 * values differ. Length is compared via SHA-256 digests so `timingSafeEqual`
 * always sees equal-length buffers (and never leaks the secret length).
 */
export function isValidInternalToken(
  presented: string | null | undefined,
  preferEnv?: string,
): boolean {
  const dedicated = preferEnv ? (process.env[preferEnv] || '').trim() : '';
  const expected = dedicated || process.env.LOOM_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf-8').digest();
  const b = crypto.createHash('sha256').update(presented, 'utf-8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Entra object-id (oid) shape — a lowercase GUID. */
const OID_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate an `x-user-oid` presented on a token-authenticated internal call and
 * return the normalized (lowercased) oid, or null when it must be rejected.
 *
 * Defense-in-depth ON TOP OF the trust-token gate (rel-T10/B3): even a leaked
 * token must not let a caller act as an arbitrary or malformed identity — the
 * oid is the tenant partition key + the OBO ownership identity, so a garbage
 * value would write into an attacker-chosen partition.
 *   1. The oid MUST be a well-formed Entra object-id GUID (rejects header
 *      injection / non-GUID partition keys).
 *   2. When `LOOM_INTERNAL_ALLOWED_OIDS` is set (a comma/space-separated list of
 *      automation object-ids), the oid must be a member — lets an operator lock
 *      the internal surface down to known service principals. Unset (the
 *      default) → any well-formed GUID is accepted, because the MAF callback
 *      forwards real signed-in end-user oids that are not pre-enumerable.
 */
export function validateInternalOid(presented: string | null | undefined): string | null {
  const oid = (presented || '').trim().toLowerCase();
  if (!OID_GUID_RE.test(oid)) return null;
  const allow = (process.env.LOOM_INTERNAL_ALLOWED_OIDS || '')
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length > 0 && !allow.includes(oid)) return null;
  return oid;
}

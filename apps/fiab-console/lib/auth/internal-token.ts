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
 * Constant-time check that the presented token matches `LOOM_INTERNAL_TOKEN`.
 * Returns false when the env var is missing/empty (fail closed) or the values
 * differ. Length is compared via SHA-256 digests so `timingSafeEqual` always
 * sees equal-length buffers (and never leaks the secret length).
 */
export function isValidInternalToken(presented: string | null | undefined): boolean {
  const expected = process.env.LOOM_INTERNAL_TOKEN;
  if (!expected) return false;
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf-8').digest();
  const b = crypto.createHash('sha256').update(presented, 'utf-8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * LOOM BRAIN ACTIONS — the ARM DELETE primitive for the prune executor (#4242).
 *
 * This module exists so `lib/brain-actions` never hand-builds a credential
 * chain (`uamiArmCredential()` is the sanctioned factory — see the
 * ws-credential-adoption ratchet) and so the DELETE verb lives in exactly one
 * place in this package, where the perform route's guards are the only path to
 * it.
 *
 * Cloud parity: the host and scope come from `cloud-endpoints.ts`
 * (`armBase()` / `armScope()`), never a literal, so the same code runs in
 * Commercial, GCC, GCC-High, IL5 and DoD.
 *
 * R7: a failure carries the HTTP status and the response body verbatim. This
 * module never converts "I could not reach ARM" into "the resource does not
 * exist".
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

/** The Container Apps api-version, matching `container-apps-arm-client.ts`. */
export const BRAIN_ACTIONS_ACA_API = '2024-03-01';

export class BrainActionArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'BrainActionArmError';
    this.status = status;
    this.body = body;
  }
}

let _credential: ReturnType<typeof uamiArmCredential> | null = null;
function credential() {
  if (!_credential) _credential = uamiArmCredential();
  return _credential;
}

/** Test seam — drop the cached credential. */
export function resetBrainActionArmCredential(): void {
  _credential = null;
}

async function armToken(): Promise<string> {
  const t = await credential().getToken(armScope());
  if (!t?.token) {
    throw new BrainActionArmError(
      401,
      undefined,
      'Failed to acquire an ARM token for the perform executor. NOTHING was deleted.',
    );
  }
  return t.token;
}

/**
 * DELETE the resource with the given ARM id.
 *
 * The id arrives from the SERVER's own snapshot rebuild (see
 * `./executors.deriveArmResourceId`) — never from a client. NOT idempotent on
 * 404 on purpose: this executor runs only after a guard chain that just
 * CONFIRMED the resource exists via a fresh GET, so a 404 here means the world
 * changed underneath the perform and the honest answer is the error, not a
 * shrugging success.
 */
export async function armDeleteResource(
  resourceId: string,
  apiVersion: string,
): Promise<{ status: number }> {
  const id = String(resourceId || '').trim();
  if (!id.startsWith('/subscriptions/')) {
    throw new BrainActionArmError(
      400,
      undefined,
      `armDeleteResource: '${id}' is not an ARM resource id. Refusing.`,
    );
  }
  const token = await armToken();
  const r = await fetchWithTimeout(`${armBase()}${id}?api-version=${apiVersion}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new BrainActionArmError(
      r.status,
      await r.text().catch(() => undefined),
      `ARM DELETE of ${id} failed with status ${r.status}. The resource was NOT confirmed deleted.`,
    );
  }
  return { status: r.status };
}

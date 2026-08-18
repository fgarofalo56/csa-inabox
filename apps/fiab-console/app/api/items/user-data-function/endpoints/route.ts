/**
 * GET /api/items/user-data-function/endpoints
 *   The execution endpoints THIS DEPLOYMENT approves for User Data Functions,
 *   so the editor can offer a picker instead of a free-text box.
 *
 * ── WHY THIS ROUTE EXISTS ───────────────────────────────────────────────────
 * `lib/azure/udf-endpoint-policy.ts` made the endpoint and its function key
 * OPERATOR CONFIGURATION: an item's `state.azureFunctionUrl` may only SELECT a
 * configured endpoint and its `state.functionKeySecret` may only AGREE with
 * that endpoint's configured key — anything else is refused with a 409 by
 * `POST /api/items/user-data-function/[id]/invoke`.
 *
 * The editor had not caught up. It still asked the user to hand-type both, so
 * the only values a user could type were (a) one they had to already know, or
 * (b) one guaranteed to gate. That is the shape `.claude/rules/
 * auto-bind-by-default.md` §5 forbids and `scripts/ci/check-no-freeform.mjs`
 * ratchets: an infrastructure value asked of a user that the platform already
 * holds. This route hands the editor the list, so the ask becomes a selection.
 *
 * ── WHAT IS AND IS NOT RETURNED ─────────────────────────────────────────────
 * `keySecretName` is a Key Vault secret NAME, never its value — the same
 * name-only shape `GET /api/keyvault/secret-names` and `lib/azure/
 * kv-secrets-client.ts` already establish. The material is read server-side by
 * the invoke route with the Console's managed identity and never reaches a
 * browser. It is returned because the editor must be able to write an
 * AGREEING `state.functionKeySecret` (and to repair a stale disagreeing one)
 * without the user typing a name they would have to guess.
 *
 * Session-guarded only, deliberately: every value here originates in this
 * deployment's own env (`LOOM_UDF_FUNCTION_BASE`,
 * `LOOM_UDF_ALLOWED_FUNCTION_BASES`, `LOOM_UDF_FUNCTION_KEY_SECRET`), is
 * identical for every caller, and carries no tenant, workspace or item data —
 * so there is no per-caller authorization decision to make. It reads no Azure
 * data plane and returns no credential material.
 *
 * Response shape:
 *   { ok: true, endpoints: [{ base, keySecretName?, acceptsPushedSource, isDefault }] }
 *   { ok: true, endpoints: [], gate: { missing, detail } }   when none configured
 */

import { withSession } from '@/lib/api/route-toolkit';
import { apiOk } from '@/lib/api/respond';
import { configuredUdfEndpoints, udfEndpointGate } from '@/lib/azure/udf-endpoint-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async () => {
  const endpoints = configuredUdfEndpoints().map((e, i) => ({
    base: e.base,
    keySecretName: e.keySecretName,
    acceptsPushedSource: e.acceptsPushedSource,
    // The policy uses the FIRST configured entry when an item names no
    // override, so the editor labels that one rather than guessing.
    isDefault: i === 0,
  }));

  // An empty list is not an empty picker: it is the honest gate the invoke
  // route would raise, surfaced BEFORE the user presses Run.
  if (!endpoints.length) return apiOk({ endpoints, gate: udfEndpointGate(null) });
  return apiOk({ endpoints });
});

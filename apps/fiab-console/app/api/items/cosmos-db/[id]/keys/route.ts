/**
 * GET  /api/items/cosmos-db/[id]/keys
 * POST /api/items/cosmos-db/[id]/keys   { keyKind } — rotate one key
 *
 * The navigator Cosmos account's ARM-authoritative keys + connection strings,
 * for the cosmos-account-editor "Connect" card. `[id]` is the Loom catalog
 * item ID — it is NOT used to resolve the account (the account is env-pinned
 * via LOOM_COSMOS_ACCOUNT / LOOM_COSMOS_ACCOUNT_RG / LOOM_SUBSCRIPTION_ID,
 * exactly like every other /api/cosmos/* navigator route).
 *
 * Real backend (ARM api-version 2024-11-15, via cosmos-account-client):
 *   POST …/databaseAccounts/{acct}/listKeys              → 4 master keys
 *   POST …/databaseAccounts/{acct}/listConnectionStrings → per-API strings
 *   POST …/databaseAccounts/{acct}/regenerateKey         → rotate one key
 *
 * Required RBAC: "DocumentDB Account Contributor" (5bd9cd88-fe45-4216-938b-f97437e15450).
 *   "Cosmos DB Operator" is NOT sufficient — it explicitly blocks key access.
 *
 * Responses:
 *   503 { ok:false, code:'not_configured', missing, hint }     — env unset
 *   403 { ok:false, code:'keys_permission', role, roleId, hint } — UAMI lacks listKeys
 *   200 { ok:true, endpoint, disableLocalAuth, keys, connectionStrings }
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAccountInfo,
  listAccountKeys,
  listConnectionStrings,
  regenerateKey,
  accountEndpointFallback,
  CosmosArmError,
  type CosmosKeyKind,
} from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../../../../cosmos/_shared';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEYS_ROLE = 'DocumentDB Account Contributor';
const KEYS_ROLE_ID = '5bd9cd88-fe45-4216-938b-f97437e15450';
const KEYS_HINT =
  `Grant the Console UAMI the "${KEYS_ROLE}" role (role ID ${KEYS_ROLE_ID}) ` +
  'at the Cosmos DB account scope. "Cosmos DB Operator" is NOT sufficient — it ' +
  'explicitly blocks key access. Bicep: platform/fiab/bicep/modules/landing-zone/cosmos.bicep ' +
  '(DLZ account) or modules/admin-plane/cosmos-navigator-keys-rbac.bicep (external account).';

/** ARM 403 → the UAMI lacks listKeys/listConnectionStrings: name the exact role. */
function keysPermissionGate(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      code: 'keys_permission',
      error:
        'The Console UAMI lacks Microsoft.DocumentDB/databaseAccounts/listKeys/action ' +
        'on the navigator Cosmos account.',
      role: KEYS_ROLE,
      roleId: KEYS_ROLE_ID,
      hint: KEYS_HINT,
    },
    { status: 403 },
  );
}

/**
 * Authenticate AND authorize a key-bearing request.
 *
 * `requireSession()` from cosmos/_shared is AUTHENTICATION only — it 401s an
 * anonymous caller and returns null for every signed-in one. That is not enough
 * here: this route returns live master keys + connection strings for the
 * env-pinned navigator account (LOOM_COSMOS_ACCOUNT), which is SHARED
 * deployment infrastructure, not a per-user resource. `[id]` is decorative and
 * is NOT used to resolve the account, so there is no ownership to scope against.
 *
 * Gated at the same tier as /api/ai-search/service, whose comment states the
 * rule: a getSession-only gate would let any authenticated user read admin keys
 * for shared infrastructure.
 */
async function requireKeyAdmin(): Promise<NextResponse | null> {
  const unauth = requireSession();
  if (unauth) return unauth;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return denyIfNoDlzAccess(session, 'scaling');
}

export async function GET(_req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireKeyAdmin(); if (denied) return denied;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const [account, keys, connectionStrings] = await Promise.all([
      getAccountInfo(),
      listAccountKeys(),
      listConnectionStrings(),
    ]);
    return NextResponse.json({
      ok: true,
      endpoint: accountEndpointFallback(account?.documentEndpoint),
      account: account?.name,
      disableLocalAuth: account?.disableLocalAuth ?? false,
      keys,
      connectionStrings,
    });
  } catch (e) {
    if (e instanceof CosmosArmError && e.status === 403) return keysPermissionGate();
    return errorResponse(e);
  }
}

const VALID_KINDS: CosmosKeyKind[] = ['primary', 'secondary', 'primaryReadonly', 'secondaryReadonly'];

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireKeyAdmin(); if (denied) return denied;
  const gated = gateResponse(); if (gated) return gated;
  const body = await readBody<{ keyKind?: string }>(req);
  const keyKind = body.keyKind as CosmosKeyKind | undefined;
  if (!keyKind || !VALID_KINDS.includes(keyKind)) {
    return NextResponse.json(
      { ok: false, error: `keyKind must be one of: ${VALID_KINDS.join(', ')}` },
      { status: 400 },
    );
  }
  try {
    await regenerateKey(keyKind);
    // Return the freshly-rotated key set so the UI re-renders without a 2nd call.
    const keys = await listAccountKeys();
    return NextResponse.json({ ok: true, rotated: keyKind, keys });
  } catch (e) {
    if (e instanceof CosmosArmError && e.status === 403) return keysPermissionGate();
    return errorResponse(e);
  }
}

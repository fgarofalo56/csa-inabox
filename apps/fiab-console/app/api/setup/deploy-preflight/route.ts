/**
 * GET /api/setup/deploy-preflight?subscriptionId=<guid>
 *
 * ASYNC, poll-friendly cross-subscription deploy pre-flight for the "Add landing
 * zone" wizard. It answers "can a Data Landing Zone be deployed into this target
 * subscription?" WITHOUT the 6s cliff:
 *
 *   • The heavy work — the caller's effective ARM permissions on the target sub
 *     (Reader vs Contributor) + the DLZ resource-provider registration state — is
 *     wrapped in a stale-while-revalidate memo ({@link swr}). The FIRST poll on a
 *     cold subscription kicks the real ARM reads and returns `status:'checking'`
 *     immediately; the wizard long-polls and the NEXT poll is served from cache
 *     instantly. No single request blocks on a multi-second cross-sub round-trip.
 *
 *   • USER-PASSTHROUGH: the permission check runs under the SIGNED-IN USER'S ARM
 *     token ({@link getArmTokenPreferUser}) so it reflects what the operator can
 *     actually deploy — not the shared Console UAMI. When the user's ARM scope
 *     wasn't consented at login it degrades to the UAMI (today's behavior) and
 *     says so via `identity`.
 *
 * This runs BEFORE the deploy POST, so the operator sees an honest
 * "you have / don't have Contributor here" verdict (with the exact
 * `az role assignment create`) before committing — and it warms the same cache
 * the deploy route reads, so the subsequent deploy never re-pays the cross-sub
 * latency.
 *
 * Response:
 *   { ok:true, status:'checking' }                                  cold — poll again
 *   { ok:true, status:'ready', canDeploy:true,  identity, missingProviders:[] }
 *   { ok:true, status:'ready', canDeploy:false, identity, requiredRole, remediation, missingProviders }
 *   { ok:false, error }                                             validation / auth
 *
 * Admin-gated on the SAME capability as the deploy (admin.deploy-dlz). No Fabric
 * anywhere (no-fabric-dependency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { getArmTokenPreferUser, type ArmTokenIdentity } from '@/lib/auth/obo';
import { swr } from '@/lib/azure/cross-sub-cache';
import { getTenantTopologySafe } from '@/lib/setup/tenant-topology';
import {
  checkSubscriptionDeployPermission,
  checkProvidersRegistered,
  buildContributorGrantCommand,
  buildProviderRegisterCommands,
} from '@/lib/setup/deploy-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cached shape of the combined cross-sub pre-flight. */
interface PreflightData {
  canDeploy: boolean;
  permError?: string;
  missingProviders: string[];
  providersError?: string;
  identity: ArmTokenIdentity;
}

/** TTL: a Reader→Contributor grant is slow-changing; 60s fresh, ~10min stale window. */
const TTL_MS = 60_000;

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Same admin-tier gate as the deploy itself.
  const gate = await enforceCapability(session, 'admin.deploy-dlz', 'Admin');
  if (gate) return gate;

  const subscriptionId = (new URL(req.url).searchParams.get('subscriptionId') || '').trim();
  if (!subscriptionId || !GUID_RE.test(subscriptionId)) {
    return NextResponse.json(
      { ok: false, error: `subscriptionId is required and must be a GUID: ${subscriptionId || '(missing)'}` },
      { status: 400 },
    );
  }

  const oid = session.claims.oid;
  // The identity is part of the cache key so a UAMI-checked result never masks a
  // later user-token-checked one (and vice-versa) for the same subscription.
  const { key, run } = await buildPreflightRunner(session, subscriptionId);

  const result = await swr<PreflightData>(oid, key, { ttlMs: TTL_MS }, run);

  if (result.state === 'pending' || result.value === null) {
    // Cold — the real ARM reads are in flight; the wizard polls again.
    return NextResponse.json({ ok: true, status: 'checking', subscriptionId });
  }

  const data = result.value;
  const isGov = await govBoundary();

  if (data.canDeploy) {
    return NextResponse.json({
      ok: true,
      status: 'ready',
      subscriptionId,
      canDeploy: true,
      identity: data.identity,
      missingProviders: data.missingProviders,
      // Surface a provider hint even on the happy path so a half-registered sub
      // is visible before the deploy 409s mid-flight.
      providersHint:
        data.missingProviders.length > 0
          ? buildProviderRegisterCommands(data.missingProviders, subscriptionId)
          : undefined,
      servedStale: result.state === 'stale',
    });
  }

  // canDeploy=false → the honest, precise gate with the exact grant command.
  const principalObjectId =
    data.identity === 'user'
      ? undefined // grant the USER Contributor
      : process.env.LOOM_CONSOLE_PRINCIPAL_ID || (await consolePrincipalFromTopology());
  const grant = buildContributorGrantCommand({
    subscriptionId,
    principalObjectId,
    principalType: data.identity === 'user' ? 'User' : 'ServicePrincipal',
    isGov,
  });
  const rpLines =
    data.missingProviders.length > 0
      ? '\n\nAlso register the resource providers this DLZ needs on the target subscription:\n' +
        buildProviderRegisterCommands(data.missingProviders, subscriptionId).join('\n')
      : '';
  return NextResponse.json({
    ok: true,
    status: 'ready',
    subscriptionId,
    canDeploy: false,
    identity: data.identity,
    requiredRole: 'Contributor',
    missingProviders: data.missingProviders,
    remediation:
      `${data.identity === 'user' ? 'You do' : 'The Console identity does'} not have permission to ` +
      `deploy a Data Landing Zone into subscription ${subscriptionId}. A subscription-scoped ` +
      `deployment requires the Contributor role (at most Reader is present — enough to see it, not to ` +
      `deploy). Grant Contributor on the target subscription, then retry:\n\n${grant}${rpLines}`,
    servedStale: result.state === 'stale',
  });
}

/**
 * Build the cache key + the revalidate function for a (user, subscription)
 * pre-flight. The ARM token is resolved ONCE (user-passthrough preferred) and its
 * identity folded into the key so the two identities never share a slot.
 */
async function buildPreflightRunner(
  session: NonNullable<ReturnType<typeof getSession>>,
  subscriptionId: string,
): Promise<{ key: string; run: () => Promise<PreflightData> }> {
  const arm = await getArmTokenPreferUser(session).catch(() => null);
  const identity: ArmTokenIdentity = arm?.identity ?? 'uami';
  const key = `deploy-preflight:${subscriptionId}:${identity}`;
  const getToken = async (): Promise<string> => {
    if (arm?.token) return arm.token;
    // The token resolution failed outright — surface it so the check reports an
    // error (non-fatal) rather than a false "cannot deploy".
    throw new Error('could not acquire an ARM token for the pre-flight');
  };
  const run = async (): Promise<PreflightData> => {
    const [perm, providers] = await Promise.all([
      checkSubscriptionDeployPermission(subscriptionId, getToken),
      checkProvidersRegistered(subscriptionId, getToken),
    ]);
    return {
      // A check ERROR (token/network/403-on-read) is NOT a definitive deny — treat
      // it as "can deploy" so the deploy route's own hard gate decides, matching
      // the deploy route's non-fatal handling.
      canDeploy: perm.error ? true : perm.canDeploy,
      permError: perm.error,
      missingProviders: providers.missing,
      providersError: providers.error,
      identity,
    };
  };
  return { key, run };
}

/** Sovereign-cloud check for the grant command (`az cloud set`). */
async function govBoundary(): Promise<boolean> {
  try {
    const topo = await getTenantTopologySafe();
    const b = topo.topology?.boundary;
    return b === 'GCC-High' || b === 'IL5';
  } catch {
    return false;
  }
}

/** Console UAMI principal id from the tenant-topology doc (for the UAMI grant command). */
async function consolePrincipalFromTopology(): Promise<string | undefined> {
  try {
    const topo = await getTenantTopologySafe();
    return topo.topology?.hubConsolePrincipalId || undefined;
  } catch {
    return undefined;
  }
}

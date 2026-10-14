/**
 * /api/estate/power — drive estate pause / resume as the CI deploy service
 * principal (PRP-02 step 3, #4876). Contract: `lib/estate/estate-power-contract.ts`.
 *
 * WHY: the pause snapshot is in Cosmos (private-endpoint-only), unreachable from a
 * GitHub-hosted runner. The console is exempt from pause so it is always up; the
 * Actions/CLI lane calls it with an Entra access token for the deploy SP.
 *
 * AUTH: NO cookie, NO `withTenantAdmin`. The credential is an Entra bearer
 * verified by `verifyEstatePowerCaller` (signature, issuer on the active cloud's
 * authority, audience, expiry, tid == estate tenant, app role Estate.Power).
 * The authorization IS the `if (!auth.ok) return …` below, and it precedes every
 * read of the request body and every call into the orchestrator.
 *
 * SAME GATES AS THE COOKIE ROUTES, because it is the SAME code
 * (`estate-power-handlers.ts`): the LOOM_ESTATE_PAUSE_ENABLED arming switch, the
 * typed `confirm` (= estate id) and the drift `confirmToken` are all required for
 * `pause`, service principal or not. There is no dryRun-skips-confirm path: the
 * `dryRun` flag is derived from `action`, never read from the body.
 *
 * Every authenticated request writes an audit row with the caller appid
 * (`estate-power.request`), in addition to the per-action rows the handlers write.
 */
import type { NextRequest } from 'next/server';
import { apiError, apiForbidden } from '@/lib/api/respond';
import { logSafe } from '@/lib/util/log-safe';
import { verifyEstatePowerCaller } from '@/lib/estate/estate-sp-auth';
import {
  audit,
  handlePausePost,
  handleResumePost,
  handleStateRead,
  type EstateCaller,
} from '@/lib/estate/estate-power-handlers';
import { ESTATE_POWER_ACTIONS, type EstatePowerAction } from '@/lib/estate/estate-power-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isAction(v: unknown): v is EstatePowerAction {
  return typeof v === 'string' && (ESTATE_POWER_ACTIONS as readonly string[]).includes(v);
}

async function dispatch(
  caller: EstateCaller,
  action: EstatePowerAction,
  body: { confirm?: unknown; confirmToken?: unknown },
) {
  await audit(caller, 'estate-power.request', { action });
  switch (action) {
    case 'state':
      return handleStateRead(caller);
    case 'preview':
      return handlePausePost(caller, { dryRun: true });
    case 'pause':
      return handlePausePost(caller, {
        dryRun: false,
        confirm: typeof body.confirm === 'string' ? body.confirm : undefined,
        confirmToken: typeof body.confirmToken === 'string' ? body.confirmToken : undefined,
      });
    case 'resume':
      return handleResumePost(caller);
  }
}

async function authorize(req: NextRequest) {
  const auth = await verifyEstatePowerCaller(req.headers.get('authorization'));
  if (auth.ok) return { caller: auth.caller } as const;
  console.warn('[estate-power] refused:', logSafe(`${auth.status} ${auth.reason}`, 200));
  if (auth.status === 403 && auth.tenantId) {
    // A VALID principal asking for something it may not do: worth an audit row.
    await audit(
      {
        tenantId: auth.tenantId, who: `sp:${auth.appId ?? 'unknown'}`, actorOid: auth.appId ?? '',
        actorTid: auth.tenantId, auditExtra: { via: 'service-principal', appId: auth.appId },
      },
      'estate-power.denied',
      { reason: auth.reason },
    );
    return { denied: apiForbidden(auth.error) };
  }
  return { denied: apiError(auth.error, auth.status) };
}

export async function GET(req: NextRequest) {
  const a = await authorize(req);
  if ('denied' in a) return a.denied;
  return dispatch(a.caller, 'state', {});
}

export async function POST(req: NextRequest) {
  const a = await authorize(req);
  if ('denied' in a) return a.denied;
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || !isAction(raw.action)) {
    return apiError(
      `Body must be JSON with \`action\` one of: ${ESTATE_POWER_ACTIONS.join(', ')}.`,
      400,
    );
  }
  return dispatch(a.caller, raw.action, raw);
}

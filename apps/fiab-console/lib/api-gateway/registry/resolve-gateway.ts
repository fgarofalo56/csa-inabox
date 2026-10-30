/**
 * Resolve the `?gateway=<id>` parameter of the legacy `/api/apim/*` routes.
 *
 *  - absent/empty      -> the deploy-owned service named by env; the handler runs untouched;
 *  - a registered id   -> the handler runs with apim-client targeting that gateway's resource id;
 *  - an unknown id     -> 404, never a silent fall back to the default (that would show the wrong gateway's data).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { withApimGateway } from '@/lib/azure/apim-client';
import type { GatewayRepo } from './gateway-service';

export type ResolvedGateway =
  | { kind: 'default' }
  | { kind: 'gateway'; id: string; resourceId: string }
  | { kind: 'error'; status: number; error: string };

export async function resolveGateway(
  repo: Pick<GatewayRepo, 'get'>,
  tenantId: string,
  gatewayParam: string | null | undefined,
): Promise<ResolvedGateway> {
  const id = gatewayParam?.trim();
  if (!id) return { kind: 'default' };
  const gw = await repo.get(tenantId, id);
  if (!gw || gw.docType !== 'gateway') return { kind: 'error', status: 404, error: `Gateway ${id} is not registered.` };
  if (!gw.access.canRead) {
    return { kind: 'error', status: 403, error: `The Console identity cannot read ${gw.resourceId}; see the gateway record for the role to grant.` };
  }
  return { kind: 'gateway', id: gw.id, resourceId: gw.resourceId };
}

type AnyRoute = (req: NextRequest, ctx: any) => Promise<Response> | Response;

/**
 * Wrap a `/api/apim/*` route handler so `?gateway=<id>` retargets every apim-client call
 * inside it. With no `gateway` parameter the handler is returned-through untouched
 * (no repo access, no behaviour change). With no session the handler runs as-is so it
 * produces its own 401.
 */
export function scopeRoute<H extends AnyRoute>(handler: H, repo?: () => Promise<Pick<GatewayRepo, 'get'>>): H {
  const wrapped: AnyRoute = async (req, ctx) => {
    const param = req?.nextUrl?.searchParams?.get('gateway');
    if (!param || !param.trim()) return handler(req, ctx);
    const session = getSession();
    if (!session) return handler(req, ctx);
    const r = await (repo ? repo() : defaultRepo());
    const res = await resolveGateway(r, tenantScopeId(session), param);
    if (res.kind === 'error') return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
    if (res.kind === 'default') return handler(req, ctx);
    return withApimGateway(res.resourceId, async () => handler(req, ctx));
  };
  return wrapped as H;
}

async function defaultRepo(): Promise<Pick<GatewayRepo, 'get'>> {
  const m = await import('./deps');
  return m.cosmosGatewayRepo();
}

/**
 * API Gateway Plane - brownfield APIM discovery (W1-9, deploy-integrity R5).
 *
 * Lists the subscriptions the Console identity can read, then the
 * Microsoft.ApiManagement/service instances in each, and offers them as
 * candidates. READ ONLY: it only issues ARM GETs (via the injected ArmPort, whose
 * armBase() is the sovereign-aware ARM host) and one Cosmos list to mark already
 * registered gateways. It never registers, writes or adopts anything.
 *
 * R7: every read that fails is recorded with the real ARM status and the result
 * is partial:true. An empty `candidates` with partial:false means "scanned, none
 * found"; with partial:true it means nothing.
 */
import { preflightGateway, type ArmPort } from '../preflight';
import { parseApimResourceId } from '../resource-id';
import type { GatewayRepo } from '../gateway-service';
import type {
  ApimNetworkMode, DiscoveredAccess, DiscoveryCandidate, DiscoveryFailure, DiscoveryResult,
} from './types';

const SUBSCRIPTIONS_API = '2022-12-01';
const APIM_API = '2024-06-01-preview';
/** Bound on in-flight ARM calls so a large tenant is not N sequential round trips. */
export const DISCOVERY_CONCURRENCY = 6;
/** Hard stop on following nextLink so a looping server cannot spin the scan. */
const MAX_PAGES = 20;

export interface DiscoveryDeps {
  arm: ArmPort;
  repo: Pick<GatewayRepo, 'list'>;
  now?: () => Date;
}

function armReason(status: number, body: unknown): string {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code : '';
  const msg = typeof err?.message === 'string' ? err.message : '';
  const detail = [code, msg].filter(Boolean).join(': ');
  return detail || `ARM answered HTTP ${status}`;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface PagedResult<T> { items: T[]; failure?: { status: number; reason: string } }

/** Follow nextLink; a failing page keeps the items already read and reports the failure. */
async function listPaged<T>(arm: ArmPort, firstUrl: string, token: string): Promise<PagedResult<T>> {
  const items: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) {
      return { items, failure: { status: 200, reason: `Stopped after ${MAX_PAGES} pages; more results exist.` } };
    }
    let res: { status: number; body: unknown };
    try {
      res = await arm.get(url, token);
    } catch (e) {
      return { items, failure: { status: 0, reason: e instanceof Error ? e.message : 'ARM request failed' } };
    }
    if (res.status !== 200) return { items, failure: { status: res.status, reason: armReason(res.status, res.body) } };
    const b = res.body as { value?: unknown; nextLink?: unknown } | null;
    if (Array.isArray(b?.value)) items.push(...(b.value as T[]));
    url = typeof b?.nextLink === 'string' && b.nextLink ? b.nextLink : undefined;
  }
  return { items };
}

interface RawApim {
  id?: string; name?: string; location?: string;
  sku?: { name?: string };
  properties?: { virtualNetworkType?: string };
}

function networkMode(v: unknown): ApimNetworkMode {
  return v === 'None' || v === 'External' || v === 'Internal' ? v : 'unknown';
}

export function observeSummary(name: string, a: DiscoveredAccess, registered: boolean): string {
  if (registered) return `${name} is already registered; nothing to do.`;
  if (a.source === 'unavailable') {
    return `Loom could not check what the Console identity can do on ${name}, so it cannot say what observe mode would do. Registering runs the check again.`;
  }
  if (!a.canRead) {
    return `The Console identity cannot read ${name}. Registering will show the exact role to grant; nothing is changed in the service.`;
  }
  return (
    `Registering ${name} in observe mode reads its APIs, products, subscriptions, backends and named values into Loom. ` +
    (a.canWrite
      ? 'Nothing is changed in the service; the identity can also write, which Loom does not use in observe mode.'
      : a.source === 'probe'
        ? 'Nothing is changed in the service; write access could not be established and is not needed.'
        : 'Nothing is changed in the service; the identity is read-only, which is enough.')
  );
}

export async function discoverGateways(deps: DiscoveryDeps, tenantId: string): Promise<DiscoveryResult> {
  const { arm } = deps;
  const failures: DiscoveryFailure[] = [];
  const base = arm.armBase();
  const token = await arm.getToken();

  const registeredDocs = await deps.repo.list(tenantId, 'gateway');
  const registered = new Map(registeredDocs.map((d) => [d.resourceId.toLowerCase(), d.id]));

  const subs = await listPaged<{ subscriptionId?: string }>(
    arm, `${base}/subscriptions?api-version=${SUBSCRIPTIONS_API}`, token,
  );
  if (subs.failure) failures.push({ scope: 'subscriptions', kind: 'subscription-list', ...subs.failure });
  const subscriptionIds = [...new Set(subs.items.map((s) => s.subscriptionId?.toLowerCase()).filter((x): x is string => !!x))];

  const perSub = await mapPool(subscriptionIds, DISCOVERY_CONCURRENCY, async (sub) => ({
    sub,
    r: await listPaged<RawApim>(
      arm, `${base}/subscriptions/${sub}/providers/Microsoft.ApiManagement/service?api-version=${APIM_API}`, token,
    ),
  }));

  const raws: RawApim[] = [];
  for (const { sub, r } of perSub) {
    raws.push(...r.items);
    if (r.failure) failures.push({ scope: sub, kind: 'service-list', ...r.failure });
  }

  const seen = new Set<string>();
  const parsed = raws.flatMap((raw) => {
    const p = parseApimResourceId(raw.id);
    if (!p || seen.has(p.resourceId.toLowerCase())) return [];
    seen.add(p.resourceId.toLowerCase());
    return [{ raw, p }];
  });

  const candidates = await mapPool(parsed, DISCOVERY_CONCURRENCY, async ({ raw, p }): Promise<DiscoveryCandidate> => {
    let access: DiscoveredAccess;
    try {
      const a = await preflightGateway(p, arm);
      access = { canRead: a.canRead, canWrite: a.canWrite, source: a.source };
    } catch (e) {
      failures.push({
        scope: p.resourceId, kind: 'access-check', status: 0,
        reason: e instanceof Error ? e.message : 'Access check failed',
      });
      access = { canRead: false, canWrite: false, source: 'unavailable' };
    }
    const registeredGatewayId = registered.get(p.resourceId.toLowerCase());
    const alreadyRegistered = registeredGatewayId !== undefined;
    return {
      resourceId: p.resourceId,
      name: p.name,
      subscriptionId: p.subscriptionId,
      resourceGroup: p.resourceGroup,
      sku: raw.sku?.name ?? 'unknown',
      location: raw.location ?? 'unknown',
      networkMode: networkMode(raw.properties?.virtualNetworkType),
      access,
      alreadyRegistered,
      ...(registeredGatewayId ? { registeredGatewayId } : {}),
      observeSummary: observeSummary(p.name, access, alreadyRegistered),
    };
  });
  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.resourceId.localeCompare(b.resourceId));

  return {
    candidates,
    subscriptionsScanned: subscriptionIds.length,
    partial: failures.length > 0,
    failures,
    scannedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}

// HTTP surface. Plain node:http + a small route table: every route declares the
// permission it needs, and the dispatcher authenticates BEFORE any handler or
// body parse runs. Responses are {ok:true,data} or {ok:false,error:{code,message}};
// only HttpError text reaches the caller, every other fault is a generic 500.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { JobRunner } from '../jobs/runner.js';
import { SUBJECT_TYPES } from '../jobs/types.js';
import type { Authenticator, Caller, Permission } from '../middleware/auth.js';
import { bundleEtag, isGzip, type BundleSource } from '../pdp/bundles.js';
import type { Registry } from '../registry/registry.js';
import type { RoutingPublisher } from '../routing/publisher.js';
import type { SloService } from '../slo/aggregate.js';
import { HttpError, badRequest, notFound } from './errors.js';
import { authoredMessage, publicErrorMessage } from '../safe-error.js';

export const MAX_BODY_BYTES = 64 * 1024;

export interface AppDeps {
  authenticate: Authenticator;
  registry: Registry;
  jobs: JobRunner;
  routing: RoutingPublisher;
  slo: SloService;
  /** Absent = bundle serving not configured (503 on the bundle route). */
  bundles?: BundleSource;
  log: (event: string, fields: Record<string, string | number>) => void;
}

interface Reply {
  status: number;
  data: unknown;
  /** Non-JSON body (the PDP bundle). Bypasses the {ok,data} envelope. */
  raw?: { body: Buffer | undefined; headers: Record<string, string> };
}

interface Ctx {
  params: string[];
  body: unknown;
  caller: Caller;
  ifNoneMatch: string | undefined;
}

interface Route {
  method: string;
  pattern: RegExp;
  template: string;
  permission: Permission;
  hasBody: boolean;
  handle(ctx: Ctx): Promise<Reply>;
}

const ID = '([a-z0-9-]{2,40})';
const JOB_ID = '(job-[0-9a-f]{32})';

const JobSubmitSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9.-]{1,60}$/),
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  idempotencyKey: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export function buildRoutes(d: AppDeps): Route[] {
  const r = (
    method: string,
    path: string,
    permission: Permission,
    handle: Route['handle'],
    hasBody = false,
  ): Route => ({
    method,
    pattern: new RegExp(`^${path}$`),
    template: path,
    permission,
    hasBody,
    handle,
  });
  const ok = (data: unknown, status = 200): Reply => ({ status, data });

  return [
    r('GET', '/api/health/stamps', 'read', async () => ok({ stamps: await d.registry.listStamps() })),
    r('POST', '/api/health/stamps', 'write', async (c) => ok(await d.registry.createStamp(c.body, c.caller.id), 201), true),
    r('GET', `/api/health/stamps/${ID}`, 'read', async (c) => ok(await d.registry.getStamp(c.params[0] ?? ''))),
    r(
      'PATCH',
      `/api/health/stamps/${ID}`,
      'write',
      async (c) => ok(await d.registry.updateStamp(c.params[0] ?? '', c.body, c.caller.id)),
      true,
    ),
    r(
      'PUT',
      `/api/health/stamps/${ID}/slo`,
      'report',
      async (c) => ok(await d.slo.record(c.params[0] ?? '', c.body, c.caller.id)),
      true,
    ),

    r('GET', '/api/health/tenants', 'read', async () => ok({ tenants: await d.registry.listTenants() })),
    r('POST', '/api/health/tenants', 'write', async (c) => ok(await d.registry.createTenant(c.body, c.caller.id), 201), true),
    r('GET', `/api/health/tenants/${ID}`, 'read', async (c) => ok(await d.registry.getTenant(c.params[0] ?? ''))),
    r(
      'PATCH',
      `/api/health/tenants/${ID}`,
      'write',
      async (c) => ok(await d.registry.updateTenant(c.params[0] ?? '', c.body, c.caller.id)),
      true,
    ),

    r('GET', '/api/health/routing-map', 'read', async () => {
      const m = await d.routing.current();
      if (!m) throw notFound('routing map');
      return ok(m);
    }),
    r('POST', '/api/health/routing-map/publish', 'write', async () => ok(await d.routing.publish())),

    r('GET', `/api/health/pdp/stamps/${ID}/bundle\\.tar\\.gz`, 'read', async (c) => {
      if (!d.bundles) throw new HttpError(503, 'bundle_store_unconfigured', 'PDP bundle store is not configured');
      const stampId = c.params[0] ?? '';
      await d.registry.getStamp(stampId); // 404 for an unregistered stamp
      const bytes = await d.bundles.get(stampId);
      if (!bytes) throw notFound('bundle');
      // A non-gzip file is a pipeline fault: say so rather than hand OPA garbage.
      if (!isGzip(bytes)) throw new HttpError(502, 'bundle_invalid', 'published bundle is not a gzip tarball');
      const etag = bundleEtag(bytes);
      const headers = { etag, 'content-type': 'application/gzip' };
      if (c.ifNoneMatch === etag) return { status: 304, data: undefined, raw: { body: undefined, headers } };
      return { status: 200, data: undefined, raw: { body: bytes, headers } };
    }),

    r('GET', '/api/health/slo', 'read', async () => ok(await d.slo.report())),

    r('GET', '/api/health/jobs', 'read', async () => ok({ kinds: d.jobs.kinds(), jobs: await d.jobs.list() })),
    r('GET', `/api/health/jobs/${JOB_ID}`, 'read', async (c) => ok(await d.jobs.get(c.params[0] ?? ''))),
    r(
      'POST',
      '/api/health/jobs',
      'write',
      async (c) => {
        const p = JobSubmitSchema.safeParse(c.body);
        if (!p.success) throw badRequest(`${p.error.issues[0]?.path.join('.') || 'body'}: ${p.error.issues[0]?.message ?? 'invalid'}`);
        const { job, created } = await d.jobs.submit({ ...p.data, requestedBy: c.caller.id });
        return ok(job, created ? 202 : 200);
      },
      true,
    ),
    r('POST', `/api/health/jobs/${JOB_ID}/retry`, 'write', async (c) => ok(await d.jobs.retry(c.params[0] ?? ''), 202)),
    r('POST', `/api/health/jobs/${JOB_ID}/cancel`, 'write', async (c) => ok(await d.jobs.cancel(c.params[0] ?? ''))),
  ];
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (ct !== 'application/json') throw badRequest('content-type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'request body too large');
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(text);
}

export function createApp(deps: AppDeps) {
  const routes = buildRoutes(deps);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = randomUUID();
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    let routeTemplate = 'unmatched';
    let caller = 'anonymous';
    let status = 500;
    try {
      if (path === '/healthz' && method === 'GET') {
        routeTemplate = '/healthz';
        status = 200;
        send(res, 200, { ok: true, data: { status: 'live' } });
        return;
      }
      let matchedPath = false;
      let route: Route | undefined;
      let params: string[] = [];
      for (const cand of routes) {
        const m = cand.pattern.exec(path);
        if (!m) continue;
        matchedPath = true;
        if (cand.method === method) {
          route = cand;
          params = m.slice(1);
          break;
        }
      }
      if (!route) {
        throw matchedPath ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route');
      }
      routeTemplate = route.template;
      const who = await deps.authenticate(req.headers.authorization, route.permission);
      caller = who.id;
      const body = route.hasBody ? await readJson(req) : undefined;
      const inm = req.headers['if-none-match'];
      const reply = await route.handle({ params, body, caller: who, ifNoneMatch: typeof inm === 'string' ? inm : undefined });
      status = reply.status;
      if (reply.raw) {
        const { body: raw, headers } = reply.raw;
        res.writeHead(status, {
          'content-length': raw ? raw.length : 0,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          ...headers,
        });
        res.end(raw);
        return;
      }
      send(res, status, { ok: true, data: reply.data });
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        send(
          res,
          status,
          { ok: false, error: { code: e.code, message: authoredMessage(e) } },
          status === 401 ? { 'www-authenticate': 'Bearer' } : {},
        );
      } else {
        status = 500;
        // Log the error class only: SDK messages can carry endpoints or ids.
        deps.log('http.internal_error', { requestId, error: e instanceof Error ? e.name : 'unknown' });
        send(res, 500, { ok: false, error: { code: 'internal', message: publicErrorMessage(e, 'internal error') } });
      }
    } finally {
      deps.log('http.request', { requestId, method, route: routeTemplate, status, ms: Date.now() - started, caller });
    }
  };
}

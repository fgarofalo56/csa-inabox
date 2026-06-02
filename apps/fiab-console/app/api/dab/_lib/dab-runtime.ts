/**
 * DAB runtime bridge — talks to a deployed Data API builder engine (Container
 * App / App Service) over its real REST + GraphQL + OpenAPI surface.
 *
 * Honest infra-gate (no-vaporware.md): a runtime endpoint is only available
 * when `LOOM_DAB_PREVIEW_URL` is set on the Loom Console app. When it is unset
 * the builder still renders fully; preview/validate-against-runtime calls return
 * a structured 503 naming the exact env var to provision (the shared preview DAB
 * Container App from `platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep`).
 *
 * Endpoints exercised (per Learn — concept/rest, concept/graphql, openapi):
 *   GET  {base}/health
 *   GET  {base}{restPath}/{entity}            (+ $select/$filter/$orderby/$first)
 *   POST {base}{graphqlPath}
 *   GET  {base}{restPath}/openapi             (permission-aware OpenAPI v3 doc)
 */

export const DAB_RUNTIME_ENV = 'LOOM_DAB_PREVIEW_URL';

export interface DabRuntimeTarget {
  baseUrl: string;
}

/** Honest gate — null when a runtime is configured, else the missing env var. */
export function dabRuntimeGate(): { missing: string } | null {
  const url = process.env[DAB_RUNTIME_ENV];
  if (!url || url.trim() === '') return { missing: DAB_RUNTIME_ENV };
  return null;
}

export function dabRuntimeTarget(): DabRuntimeTarget | null {
  const url = process.env[DAB_RUNTIME_ENV];
  if (!url || url.trim() === '') return null;
  return { baseUrl: url.replace(/\/+$/, '') };
}

async function dabFetch(path: string, init: RequestInit & { role?: string } = {}): Promise<Response> {
  const target = dabRuntimeTarget();
  if (!target) throw new Error(`DAB runtime not configured: set ${DAB_RUNTIME_ENV}.`);
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.role) headers['X-MS-API-ROLE'] = init.role;
  const res = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers,
    // Server-side fetch: no CORS, secrets stay off the browser.
    cache: 'no-store',
  });
  return res;
}

export interface DabProbe {
  ok: boolean;
  status: number;
  version?: string;
  body?: unknown;
}

/** Hit the DAB health endpoint to confirm the runtime is live. */
export async function probeRuntime(): Promise<DabProbe> {
  try {
    const res = await dabFetch('/health');
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* health may be plain text */ }
    const version = body && typeof body === 'object' ? (body as any).version : undefined;
    return { ok: res.ok, status: res.status, version, body };
  } catch (e: any) {
    return { ok: false, status: 0, body: e?.message || String(e) };
  }
}

export interface DabRestQuery {
  entityPath: string;          // e.g. "/book" (entity rest.path)
  pkSegment?: string;          // e.g. "/id/3"
  select?: string;
  filter?: string;
  orderby?: string;
  first?: number;
  after?: string;
  role?: string;
}

/** Server-side proxy of a DAB REST read (GET) — returns {status, headers, body}. */
export async function proxyRest(restBasePath: string, q: DabRestQuery): Promise<{ status: number; body: unknown; url: string }> {
  const params = new URLSearchParams();
  if (q.select) params.set('$select', q.select);
  if (q.filter) params.set('$filter', q.filter);
  if (q.orderby) params.set('$orderby', q.orderby);
  if (q.first !== undefined) params.set('$first', String(q.first));
  if (q.after) params.set('$after', q.after);
  const qs = params.toString();
  const path = `${restBasePath}${q.entityPath}${q.pkSegment || ''}${qs ? `?${qs}` : ''}`;
  const res = await dabFetch(path, { role: q.role });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status, body, url: path };
}

/** Server-side proxy of a GraphQL request. */
export async function proxyGraphql(
  graphqlPath: string,
  query: string,
  variables?: Record<string, unknown>,
  role?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await dabFetch(graphqlPath, {
    method: 'POST',
    role,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status, body };
}

/** Fetch the permission-aware OpenAPI v3 document the runtime generates. */
export async function fetchOpenApi(restBasePath: string): Promise<{ status: number; doc: unknown }> {
  const res = await dabFetch(`${restBasePath}/openapi`);
  const text = await res.text();
  let doc: unknown = text;
  try { doc = JSON.parse(text); } catch { /* leave as text */ }
  return { status: res.status, doc };
}

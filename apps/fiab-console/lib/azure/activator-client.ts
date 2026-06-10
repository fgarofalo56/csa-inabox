/**
 * Fabric Activator (Reflex) REST client.
 *
 * Auth: Same Console UAMI / chained credential as powerbi-client.ts.
 * Fabric Activator uses the Power BI scope for token acquisition (even
 * though endpoints live on api.fabric.microsoft.com — the resource server
 * federates back to Power BI).
 *
 * Endpoints:
 *   - https://api.fabric.microsoft.com/v1/workspaces/{ws}/reflexes
 *   - https://api.fabric.microsoft.com/v1/workspaces/{ws}/reflexes/{id}
 *
 * Pre-requisites for real data (same as powerbi-client.ts):
 *   - Tenant setting "Service principals can use Fabric APIs" enabled
 *   - UAMI's SP added to the Power BI / Fabric workspace
 *   - Reflex (Activator) item type enabled in the workspace
 *
 * Errors are wrapped in ActivatorError with status + body.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
// Fabric Activator authenticates via the Power BI scope.
const ACTIVATOR_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class ActivatorError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'ActivatorError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

async function getToken(): Promise<string> {
  const t = await credential.getToken(ACTIVATOR_SCOPE);
  if (!t?.token) throw new ActivatorError('Failed to acquire AAD token for Fabric Activator', 401);
  return t.token;
}

interface CallOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

async function call<T = any>(path: string, opts: CallOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const token = await getToken();
  const url = `${FABRIC_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `Activator ${method} ${path} failed`).toString();
    throw new ActivatorError(msg, res.status, json || text, url);
  }
  return (json as T) ?? ({} as T);
}

export interface ActivatorItem {
  id: string;
  displayName: string;
  description?: string;
  workspaceId?: string;
  type?: string;
}

export interface ActivatorRule {
  id: string;
  name: string;
  objectName?: string;
  propertyName?: string;
  condition?: { operator?: string; value?: unknown };
  action?: { kind?: string; config?: Record<string, unknown> };
  state?: 'Active' | 'Stopped';
  lastTriggered?: string;
}

export async function listActivators(workspaceId: string): Promise<ActivatorItem[]> {
  const j = await call<{ value: ActivatorItem[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/reflexes`);
  return j.value || [];
}

export async function getActivator(workspaceId: string, activatorId: string): Promise<ActivatorItem> {
  return call<ActivatorItem>(`/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}`);
}

export async function createActivator(
  workspaceId: string,
  body: { displayName: string; description?: string },
): Promise<ActivatorItem> {
  return call<ActivatorItem>(`/workspaces/${encodeURIComponent(workspaceId)}/reflexes`, {
    method: 'POST',
    body,
  });
}

export async function updateActivator(
  workspaceId: string,
  activatorId: string,
  body: { displayName?: string; description?: string },
): Promise<ActivatorItem> {
  return call<ActivatorItem>(
    `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}`,
    { method: 'PATCH', body },
  );
}

export async function deleteActivator(workspaceId: string, activatorId: string): Promise<void> {
  await call(`/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}`, {
    method: 'DELETE',
  });
}

/**
 * Rules ("triggers") are a sub-collection of a reflex. Public REST surface
 * for these is in preview; we surface whatever the API returns and fall
 * back to an empty list on 404/400 so the editor stays useful.
 */
export async function listRules(workspaceId: string, activatorId: string): Promise<ActivatorRule[]> {
  try {
    const j = await call<{ value: ActivatorRule[] }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers`,
    );
    return j.value || [];
  } catch (e) {
    if (e instanceof ActivatorError && (e.status === 404 || e.status === 400)) return [];
    throw e;
  }
}

export async function addRule(
  workspaceId: string,
  activatorId: string,
  body: { name: string; condition?: Record<string, unknown>; action?: Record<string, unknown> },
): Promise<ActivatorRule> {
  return call<ActivatorRule>(
    `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers`,
    { method: 'POST', body },
  );
}

export async function triggerRule(
  workspaceId: string,
  activatorId: string,
  ruleId: string,
): Promise<{ ok: true }> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers/${encodeURIComponent(ruleId)}/run`,
    { method: 'POST' },
  );
  return { ok: true };
}

/**
 * Start a reflex — sets every trigger on the reflex to Active. The Fabric
 * REST surface for "start the whole reflex" is in preview, so we iterate
 * over the triggers and PATCH each with state=Active. Returns the count
 * of updated triggers.
 */
export async function startReflex(
  workspaceId: string,
  activatorId: string,
): Promise<{ ok: true; updated: number }> {
  const rules = await listRules(workspaceId, activatorId);
  let updated = 0;
  for (const r of rules) {
    try {
      await call(
        `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers/${encodeURIComponent(r.id)}`,
        { method: 'PATCH', body: { state: 'Active' } },
      );
      updated++;
    } catch (e) {
      if (!(e instanceof ActivatorError && (e.status === 404 || e.status === 400))) throw e;
    }
  }
  return { ok: true, updated };
}

/**
 * Set a single trigger's state (Active | Stopped) — the per-rule enable/disable
 * parity for the Fabric opt-in path. PATCHes one trigger rather than the whole
 * reflex.
 */
export async function setTriggerState(
  workspaceId: string,
  activatorId: string,
  ruleId: string,
  state: 'Active' | 'Stopped',
): Promise<{ ok: true }> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers/${encodeURIComponent(ruleId)}`,
    { method: 'PATCH', body: { state } },
  );
  return { ok: true };
}

/** Delete a single trigger from a reflex — the per-rule delete parity for the
 *  Fabric opt-in path. */
export async function deleteTrigger(
  workspaceId: string,
  activatorId: string,
  ruleId: string,
): Promise<{ ok: true }> {
  await call(
    `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers/${encodeURIComponent(ruleId)}`,
    { method: 'DELETE' },
  );
  return { ok: true };
}

/**
 * Stop a reflex — sets every trigger to Stopped. Same approach as
 * startReflex (no single "disable reflex" endpoint in preview today).
 */
export async function stopReflex(
  workspaceId: string,
  activatorId: string,
): Promise<{ ok: true; updated: number }> {
  const rules = await listRules(workspaceId, activatorId);
  let updated = 0;
  for (const r of rules) {
    try {
      await call(
        `/workspaces/${encodeURIComponent(workspaceId)}/reflexes/${encodeURIComponent(activatorId)}/triggers/${encodeURIComponent(r.id)}`,
        { method: 'PATCH', body: { state: 'Stopped' } },
      );
      updated++;
    } catch (e) {
      if (!(e instanceof ActivatorError && (e.status === 404 || e.status === 400))) throw e;
    }
  }
  return { ok: true, updated };
}

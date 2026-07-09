/**
 * Webhook registration + delivery-log store (BR-WEBHOOK).
 *
 * Persists tenant-admin-registered outbound webhook endpoints and their
 * delivery history to Cosmos (no-vaporware.md — real data plane, never mocks):
 *   - `webhook-subscriptions` (PK /tenantId): one row per endpoint.
 *   - `webhook-deliveries`    (PK /webhookId): append-only attempt log, capped
 *     at the last {@link DELIVERY_LOG_CAP} per hook.
 *
 * The HMAC signing secret is stored server-side (this is a first-party admin
 * registry, not a public form) and is NEVER returned to the client — every read
 * path projects it out via {@link redactHook}.
 */

import crypto from 'node:crypto';
import {
  webhookSubscriptionsContainer,
  webhookDeliveriesContainer,
} from '@/lib/azure/cosmos-client';
import { isLoomEventType, type LoomEventType } from '@/lib/events/event-types';

/** How many delivery attempts to retain per hook (append-only, oldest pruned). */
export const DELIVERY_LOG_CAP = 100;

export interface WebhookRegistration {
  /** UUID. */
  id: string;
  /** Partition key — the registering tenant (session `claims.oid`). */
  tenantId: string;
  /** Human label for the endpoint. */
  name: string;
  /** Destination HTTPS URL (direct delivery target). */
  url: string;
  /** HMAC-SHA256 signing secret (server-only; redacted on every read). */
  secret: string;
  /** Subscribed event types (or `['*']` for all). */
  events: LoomEventType[] | ['*'];
  /** Opt-out toggle — default-ON per default-ON/opt-out; admin disables here. */
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Rolling delivery counters (best-effort, updated by the emitter). */
  stats?: { delivered: number; failed: number; lastAttemptAt?: string; lastStatus?: number };
}

/** The client-safe projection — signing secret replaced by a boolean flag. */
export type WebhookRegistrationView = Omit<WebhookRegistration, 'secret'> & { secretSet: boolean };

export interface WebhookDelivery {
  /** UUID (also the X-Loom-Delivery-Id header value). */
  id: string;
  /** Partition key — the hook this attempt targeted. */
  webhookId: string;
  tenantId: string;
  eventType: string;
  /** Outcome. */
  outcome: 'delivered' | 'failed';
  /** Final HTTP status (0 = network/transport error). */
  status: number;
  /** How many attempts were made (1 + retries). */
  attempts: number;
  /** Delivery channel actually used. */
  transport: 'direct' | 'eventgrid';
  /** First 300 chars of the response body / error (for the history drawer). */
  responseSnippet?: string;
  /** Total wall-clock ms across attempts. */
  durationMs?: number;
  at: string;
}

/** Redact the signing secret before returning a hook to any client. */
export function redactHook(h: WebhookRegistration): WebhookRegistrationView {
  const { secret, ...rest } = h;
  return { ...rest, secretSet: !!secret };
}

/**
 * Normalize + validate a registration payload from the wizard. Returns a typed
 * error string (for a 400) or the cleaned fields. HTTPS is REQUIRED (an HMAC
 * over cleartext http is pointless); localhost/private hosts are rejected as a
 * light SSRF guard (delivery is server-initiated).
 */
export function validateRegistrationInput(body: {
  name?: unknown;
  url?: unknown;
  events?: unknown;
  secret?: unknown;
  enabled?: unknown;
}): { ok: false; error: string } | {
  ok: true;
  name: string;
  url: string;
  events: LoomEventType[] | ['*'];
  secret?: string;
  enabled: boolean;
} {
  const name = String(body?.name ?? '').trim().slice(0, 120);
  if (!name) return { ok: false, error: 'name is required' };

  const urlRaw = String(body?.url ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    return { ok: false, error: 'url must be a valid absolute URL' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'url must use https' };
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '169.254.169.254' || // cloud IMDS
    host.endsWith('.local')
  ) {
    return { ok: false, error: 'url host is not allowed (loopback / link-local / IMDS)' };
  }

  const rawEvents = Array.isArray(body?.events) ? (body!.events as unknown[]) : [];
  let events: LoomEventType[] | ['*'];
  if (rawEvents.includes('*')) {
    events = ['*'];
  } else {
    const cleaned = [...new Set(rawEvents.filter(isLoomEventType))] as LoomEventType[];
    if (cleaned.length === 0) return { ok: false, error: 'select at least one event type' };
    events = cleaned;
  }

  const secret = body?.secret != null ? String(body.secret) : undefined;
  const enabled = body?.enabled === undefined ? true : body.enabled !== false;
  return { ok: true, name, url: urlRaw, events, secret, enabled };
}

/** Generate a strong random HMAC signing secret (32 bytes, base64url). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listHooks(tenantId: string): Promise<WebhookRegistration[]> {
  const c = await webhookSubscriptionsContainer();
  const { resources } = await c.items
    .query<WebhookRegistration>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources;
}

export async function getHook(tenantId: string, id: string): Promise<WebhookRegistration | null> {
  const c = await webhookSubscriptionsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<WebhookRegistration>();
    return resource && resource.tenantId === tenantId ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function createHook(
  tenantId: string,
  createdBy: string,
  input: { name: string; url: string; events: LoomEventType[] | ['*']; secret?: string; enabled: boolean },
): Promise<WebhookRegistration> {
  const now = new Date().toISOString();
  const doc: WebhookRegistration = {
    id: crypto.randomUUID(),
    tenantId,
    name: input.name,
    url: input.url,
    secret: input.secret && input.secret.length >= 16 ? input.secret : generateWebhookSecret(),
    events: input.events,
    enabled: input.enabled,
    createdAt: now,
    createdBy,
    updatedAt: now,
    stats: { delivered: 0, failed: 0 },
  };
  const c = await webhookSubscriptionsContainer();
  const { resource } = await c.items.create(doc);
  return resource!;
}

export async function updateHook(
  tenantId: string,
  id: string,
  patch: Partial<Pick<WebhookRegistration, 'name' | 'url' | 'events' | 'enabled' | 'secret'>>,
): Promise<WebhookRegistration | null> {
  const current = await getHook(tenantId, id);
  if (!current) return null;
  const next: WebhookRegistration = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.events !== undefined ? { events: patch.events } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.secret ? { secret: patch.secret } : {}),
    updatedAt: new Date().toISOString(),
  };
  const c = await webhookSubscriptionsContainer();
  const { resource } = await c.item(id, tenantId).replace(next);
  return resource!;
}

export async function deleteHook(tenantId: string, id: string): Promise<boolean> {
  const current = await getHook(tenantId, id);
  if (!current) return false;
  const c = await webhookSubscriptionsContainer();
  await c.item(id, tenantId).delete();
  return true;
}

// ── Delivery log ──────────────────────────────────────────────────────────

/** Append a delivery attempt and prune the hook's log back to the cap. */
export async function recordDelivery(entry: WebhookDelivery): Promise<void> {
  const c = await webhookDeliveriesContainer();
  await c.items.create(entry);
  // Best-effort prune: keep only the newest DELIVERY_LOG_CAP for this hook.
  try {
    const { resources } = await c.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.webhookId = @w ORDER BY c.at DESC OFFSET @cap LIMIT 1000',
        parameters: [
          { name: '@w', value: entry.webhookId },
          { name: '@cap', value: DELIVERY_LOG_CAP },
        ],
      })
      .fetchAll();
    await Promise.all(resources.map((r) => c.item(r.id, entry.webhookId).delete().catch(() => {})));
  } catch {
    /* prune is best-effort; the log staying slightly over cap is harmless */
  }
}

export async function listDeliveries(webhookId: string, limit = DELIVERY_LOG_CAP): Promise<WebhookDelivery[]> {
  const c = await webhookDeliveriesContainer();
  const { resources } = await c.items
    .query<WebhookDelivery>({
      query: 'SELECT * FROM c WHERE c.webhookId = @w ORDER BY c.at DESC OFFSET 0 LIMIT @n',
      parameters: [
        { name: '@w', value: webhookId },
        { name: '@n', value: Math.min(limit, DELIVERY_LOG_CAP) },
      ],
    })
    .fetchAll();
  return resources;
}

/** Best-effort bump of a hook's rolling delivery counters. Never throws. */
export async function bumpHookStats(
  tenantId: string,
  id: string,
  outcome: 'delivered' | 'failed',
  status: number,
): Promise<void> {
  try {
    const current = await getHook(tenantId, id);
    if (!current) return;
    const stats = current.stats ?? { delivered: 0, failed: 0 };
    const next: WebhookRegistration = {
      ...current,
      stats: {
        delivered: stats.delivered + (outcome === 'delivered' ? 1 : 0),
        failed: stats.failed + (outcome === 'failed' ? 1 : 0),
        lastAttemptAt: new Date().toISOString(),
        lastStatus: status,
      },
    };
    const c = await webhookSubscriptionsContainer();
    await c.item(id, tenantId).replace(next);
  } catch {
    /* stats are advisory */
  }
}

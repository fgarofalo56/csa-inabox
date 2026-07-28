/**
 * N7c — non-Dataverse activation destinations: webhook / Event Grid / Service Bus.
 *
 * Each is a REAL data-plane push (no-vaporware):
 *   • webhook      → HTTPS POST of the batch to a per-item https URL.
 *   • event-grid   → CloudEvents v1.0 POST to a per-item custom-topic endpoint,
 *                    Entra-authed with the Console UAMI (EVENTGRID_DATA_SCOPE);
 *                    the UAMI needs "EventGrid Data Sender" on the topic.
 *   • service-bus  → HTTPS data-plane send to `<ns>/<entity>/messages`, Entra-
 *                    authed (SERVICEBUS_DATA_SCOPE); the UAMI needs "Azure
 *                    Service Bus Data Sender" on the namespace/entity.
 *
 * Idempotency: every row carries a stable `dedupId` (`<itemId>:<key>:<version>`)
 * so a replayed batch is de-duplicable downstream — the EG CloudEvent `id` and
 * the SB `MessageId` are set to it (Service Bus duplicate detection drops repeats
 * when enabled on the entity).
 *
 * SOVEREIGN MOAT / IL5: Event Grid and Service Bus scopes are cloud-invariant and
 * the endpoints are the deployment's own in-boundary resources, so these
 * destinations run air-gapped. A webhook to a public SaaS host is honest-gated by
 * reachability, never required.
 */

import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { EVENTGRID_DATA_SCOPE } from '@/lib/azure/eventgrid-topics-client';
import { SERVICEBUS_DATA_SCOPE } from '@/lib/azure/servicebus-data-client';
import { serviceBusFqdn } from '@/lib/azure/cloud-endpoints';
import type {
  ActivationWebhookDest, ActivationEventGridDest, ActivationServiceBusDest,
} from './types';

/** One activated row handed to a non-Dataverse destination. */
export interface ActivationOutRow {
  /** Stable dedup id (`<itemId>:<key>:<version>`). */
  dedupId: string;
  /** The row key (mapped keyColumn value, or the source's natural key). */
  key: string;
  /** upsert | delete — carried through so consumers can apply the change. */
  op: 'upsert' | 'delete';
  /** The mapped/selected payload for this row. */
  data: Record<string, unknown>;
}

export interface DestinationResult {
  upserts: number;
  deletes: number;
  errors: number;
  firstError?: string;
}

export interface DestinationDeps {
  fetchImpl?: typeof fetch;
  getToken?: (scope: string) => Promise<string>;
}

function tally(rows: ActivationOutRow[], errors = 0, firstError?: string): DestinationResult {
  let upserts = 0, deletes = 0;
  for (const r of rows) { if (r.op === 'delete') deletes += 1; else upserts += 1; }
  return { upserts, deletes, errors, ...(firstError ? { firstError } : {}) };
}

async function defaultToken(scope: string): Promise<string> {
  const t = await uamiArmCredential().getToken(scope);
  if (!t?.token) throw new Error(`Failed to acquire a token for ${scope} — the Console UAMI must be configured.`);
  return t.token;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function shortError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return (text || `HTTP ${res.status}`).slice(0, 300);
}

/** POST the whole batch to the webhook as one JSON envelope. */
export async function sendWebhook(
  dest: ActivationWebhookDest,
  rows: ActivationOutRow[],
  meta: { itemId: string; mode: string; toVersion?: number },
  deps: DestinationDeps = {},
): Promise<DestinationResult> {
  if (rows.length === 0) return tally(rows);
  const fetchImpl = deps.fetchImpl ?? ((url: any, init?: any) => fetchWithTimeout(url, init));
  try {
    const res = await fetchImpl(dest.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        source: 'loom-activation-sync',
        itemId: meta.itemId,
        mode: meta.mode,
        toVersion: meta.toVersion,
        rows: rows.map((r) => ({ dedupId: r.dedupId, key: r.key, op: r.op, data: r.data })),
      }),
      cache: 'no-store',
    } as RequestInit);
    if (!res.ok) return tally(rows, rows.length, await shortError(res));
    return tally(rows);
  } catch (e) {
    return tally(rows, rows.length, (e as Error)?.message || String(e));
  }
}

/** Publish each row as a CloudEvent v1.0 to a custom Event Grid topic endpoint. */
export async function sendEventGrid(
  dest: ActivationEventGridDest,
  rows: ActivationOutRow[],
  meta: { itemId: string; toVersion?: number },
  deps: DestinationDeps = {},
): Promise<DestinationResult> {
  if (rows.length === 0) return tally(rows);
  const fetchImpl = deps.fetchImpl ?? ((url: any, init?: any) => fetchWithTimeout(url, init));
  const getToken = deps.getToken ?? defaultToken;
  const eventType = dest.eventType || 'Loom.Activation.Row';
  const token = await getToken(EVENTGRID_DATA_SCOPE);
  const nowIso = new Date().toISOString();

  let errors = 0; let firstError: string | undefined;
  for (const batch of chunk(rows, 100)) {
    const events = batch.map((r) => ({
      id: r.dedupId,
      source: `loom-activation/${meta.itemId}`,
      type: eventType,
      subject: r.key,
      time: nowIso,
      specversion: '1.0',
      data: { op: r.op, key: r.key, toVersion: meta.toVersion, row: r.data },
    }));
    try {
      const res = await fetchImpl(dest.topicEndpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/cloudevents-batch+json' },
        body: JSON.stringify(events),
        cache: 'no-store',
      } as RequestInit);
      if (!res.ok) { errors += batch.length; firstError ??= await shortError(res); }
    } catch (e) {
      errors += batch.length; firstError ??= (e as Error)?.message || String(e);
    }
  }
  return tally(rows, errors, firstError);
}

/** Send each row as one Service Bus message to `<ns>/<entity>/messages`. */
export async function sendServiceBus(
  dest: ActivationServiceBusDest,
  rows: ActivationOutRow[],
  meta: { itemId: string; toVersion?: number },
  deps: DestinationDeps = {},
): Promise<DestinationResult> {
  if (rows.length === 0) return tally(rows);
  const fetchImpl = deps.fetchImpl ?? ((url: any, init?: any) => fetchWithTimeout(url, init));
  const getToken = deps.getToken ?? defaultToken;
  const token = await getToken(SERVICEBUS_DATA_SCOPE);
  const host = serviceBusFqdn(dest.namespace);
  const base = `https://${host}/${encodeURIComponent(dest.entity)}/messages`;

  let errors = 0; let firstError: string | undefined;
  for (const r of rows) {
    try {
      const res = await fetchImpl(base, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          BrokerProperties: JSON.stringify({ MessageId: r.dedupId, Label: `activation.${r.op}` }),
        },
        body: JSON.stringify({ op: r.op, key: r.key, toVersion: meta.toVersion, row: r.data }),
        cache: 'no-store',
      } as RequestInit);
      if (!res.ok) { errors += 1; firstError ??= await shortError(res); }
    } catch (e) {
      errors += 1; firstError ??= (e as Error)?.message || String(e);
    }
  }
  return tally(rows, errors, firstError);
}

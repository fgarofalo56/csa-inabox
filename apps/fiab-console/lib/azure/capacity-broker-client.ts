/**
 * HYP-9 — Loom Capacity Broker client.
 *
 * Thin wrapper the Console BFF (and, in HYP-11, the engine job-submit
 * choke-points) call to reach the `loom-capacity-broker` ACA service — a
 * stateful admission-control service exposing a synchronous `POST /admit` over a
 * 2,880 × 30-second timepoint ledger (the LCU smoothing/bursting/throttle model,
 * Azure-native, NO Fabric dependency).
 *
 * Honest gate (no-vaporware.md): when `LOOM_CAPACITY_BROKER_URL` is unset the
 * broker is not deployed. The default-ON posture (PRP §7.3) is that job
 * submission proceeds UNTHROTTLED rather than blocking the platform, so the
 * choke-point callers catch {@link BrokerNotConfiguredError} and proceed; the
 * admin/testing BFF route instead surfaces an honest 503 naming the env var + the
 * bicep module (platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep).
 */

import { fetchWithTimeout } from './fetch-with-timeout';

/** Decision returned by the broker. allow|delay|reject (task synonyms: admit|queue|reject). */
export type AdmitDecision = 'allow' | 'delay' | 'reject';

/** Job smoothing class. */
export type AdmitClass = 'interactive' | 'background';

export interface AdmitRequest {
  tenantId: string;
  workspaceId?: string;
  engine: string;
  /** Requested LCU (CU-seconds). Accepts the PRP alias `estimatedLcu` server-side. */
  requestedUnits: number;
  class?: AdmitClass;
}

export interface AdmitResult {
  ok: boolean;
  decision: AdmitDecision;
  delayMs?: number;
  reason: string;
  /** Which ledger backend served this — "memory" (single-replica) | "redis" (shared). Honest. */
  backend: string;
  class: AdmitClass;
  engine: string;
  requestedLcu: number;
  perTimepointLcu: number;
  carryForwardSeconds: number;
  lastHourLcu: number;
  timepoint: number;
  bypassed?: boolean;
}

/** Thrown when the broker service is not deployed (env unset) — an honest infra gate. */
export class BrokerNotConfiguredError extends Error {
  constructor() {
    super(
      'Loom Capacity Broker not deployed. Set LOOM_CAPACITY_BROKER_URL (deploy ' +
        'platform/fiab/bicep/modules/compute/loom-capacity-broker-app.bicep, minReplicas 2).',
    );
    this.name = 'BrokerNotConfiguredError';
  }
}

/** The configured broker base URL (internal ACA ingress), or null when unset. */
export function capacityBrokerUrl(): string | null {
  const raw = process.env.LOOM_CAPACITY_BROKER_URL;
  if (!raw || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, '');
}

/** Whether the broker is deployed/wired. */
export function capacityBrokerConfigured(): boolean {
  return capacityBrokerUrl() !== null;
}

async function brokerFetch<T>(path: string, init: RequestInit): Promise<T> {
  const base = capacityBrokerUrl();
  if (!base) throw new BrokerNotConfiguredError();
  const res = await fetchWithTimeout(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `capacity broker returned ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/**
 * The choke-point call: submit a job's requested LCU for admission. Returns the
 * broker's allow/delay/reject decision + reasons. Throws
 * {@link BrokerNotConfiguredError} when the broker is not deployed — callers at
 * engine choke-points (HYP-11) catch it and proceed unthrottled (default-ON).
 */
export async function admit(req: AdmitRequest): Promise<AdmitResult> {
  return brokerFetch<AdmitResult>('/admit', { method: 'POST', body: JSON.stringify(req) });
}

/** Record actual post-run consumption (the /report endpoint). */
export async function report(input: {
  tenantId: string;
  workspaceId?: string;
  actualLcu: number;
}): Promise<{ ok: boolean; recorded: boolean; backend: string }> {
  return brokerFetch('/report', { method: 'POST', body: JSON.stringify(input) });
}

/** Read the live timepoint ledger state for the admin capacity UI (HYP-12). */
export async function ledgerState(
  tenantId: string,
  workspaceId: string,
  horizon = 120,
): Promise<{
  ok: boolean;
  backend: string;
  timepoint: number;
  lastHourLcu: number;
  future: number[];
}> {
  const t = encodeURIComponent(tenantId);
  const w = encodeURIComponent(workspaceId || '_');
  return brokerFetch(`/ledger/${t}/${w}?horizon=${encodeURIComponent(String(horizon))}`, {
    method: 'GET',
  });
}

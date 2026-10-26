// Estate-power support for a paused stamp (W1-8): the PostgreSQL 7-day restart.
//
// Microsoft Learn (PostgreSQL flexible server, stop/start): a stopped server is
// started again automatically after 7 days. LHDS refuses to let that happen at a
// moment it did not choose, so while a stamp is `paused` the control plane starts
// the server itself, on a schedule that always falls inside the 7-day limit. The
// estate pause lane (apps/fiab-console/lib/estate) then re-stops it on its next
// read, so the pause is bounded and visible rather than silently lapsing.
//
// Window arithmetic (no stored pause timestamp is needed): time is cut into fixed
// 6-day windows from the Unix epoch and one restart job is submitted per paused
// stamp per window. A server stopped at ANY instant is therefore restarted no
// later than 6 days later (the next window boundary), which is inside 7 days with
// a 1-day margin for a failed or retried job.

import { z } from 'zod';
import type { Collection } from '../store/types.js';
import type { StampDoc } from '../registry/types.js';
import type { JobRunner } from './runner.js';
import { JobFailure, type JobHandler } from './types.js';
import { stampResourceGroup, type Lookup } from './tenant-arm.js';

export const POSTGRES_AUTO_RESTART_DAYS = 7;
export const RESTART_INTERVAL_DAYS = 6;
export const RESTART_INTERVAL_MS = RESTART_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
export const POSTGRES_RESTART_KIND = 'stamp.postgres-restart';

/** Index of the fixed 6-day window `now` falls in. */
export function restartWindow(now: Date): number {
  return Math.floor(now.getTime() / RESTART_INTERVAL_MS);
}

export function restartIdempotencyKey(now: Date): string {
  return `window-${restartWindow(now)}`;
}

/** PostgreSQL flexible server `properties.state` values this code branches on; others pass through as strings. */
export type PostgresState = 'Ready' | 'Stopped' | 'Starting' | 'Stopping' | 'Updating' | 'absent' | (string & {});

export interface PostgresPower {
  getState(serverId: string): Promise<PostgresState>;
  /** Start the server and wait until a read says it is Ready. */
  start(serverId: string): Promise<void>;
}

export interface StampPowerDeps {
  stamps: Collection<StampDoc>;
  power: PostgresPower;
  /** Stamp deployment outputs; `postgresServerId` is the server to start. */
  getStampManifest: (resourceGroup: string, stampId: string) => Promise<Lookup<Record<string, unknown>>>;
}

/** `stamp.postgres-restart`: start the stamp's PostgreSQL server if it is Stopped, then read it back. */
export function postgresRestartHandler(deps: StampPowerDeps): JobHandler {
  return {
    kind: POSTGRES_RESTART_KIND,
    subjectType: 'stamp',
    inputSchema: z.strictObject({}),
    async run(ctx) {
      const stamp = await deps.stamps.get(ctx.job.subjectId);
      if (!stamp) throw new JobFailure('stamp_missing', 'the stamp record no longer exists');
      if (stamp.status !== 'paused') {
        await ctx.receipt('postgres.restart.skipped', `stamp status is ${stamp.status}, not paused; nothing to restart`);
        return;
      }
      const m = await deps.getStampManifest(stampResourceGroup(stamp.id, stamp.region), stamp.id);
      if (m.state !== 'found') {
        throw new JobFailure('stamp_manifest_unavailable', `the stamp deployment outputs could not be read (${m.state}); the PostgreSQL server cannot be identified`);
      }
      const serverId = m.value.postgresServerId;
      if (typeof serverId !== 'string' || !serverId) {
        throw new JobFailure('stamp_manifest_incomplete', 'the stamp deployment outputs carry no postgresServerId');
      }
      const before = await deps.power.getState(serverId);
      await ctx.receipt('postgres.state.before', `server=${serverId} state=${before}`);
      if (before === 'Ready') return; // running already: the 7-day clock is not ticking
      if (before !== 'Stopped') {
        throw new JobFailure('transient', `the PostgreSQL server is ${before}, not Stopped or Ready; retry the job`);
      }
      await deps.power.start(serverId);
      const after = await deps.power.getState(serverId);
      await ctx.receipt('postgres.state.after', `server=${serverId} state=${after}`);
      if (after !== 'Ready') {
        throw new JobFailure('start_unverified', `the PostgreSQL start was requested but a read-back says ${after}, not Ready`);
      }
    },
  };
}

export interface RestartScheduleResult {
  window: number;
  submitted: string[];
  retried: string[];
  alreadyDone: string[];
}

/**
 * Submit one restart job per paused stamp for the current window. A job already
 * recorded for the window is the idempotent answer; if it FAILED it is retried,
 * so a transient ARM error does not cost the stamp its restart for the window.
 */
export async function scheduleStampRestarts(deps: {
  stamps: Collection<StampDoc>;
  jobs: JobRunner;
  now: () => Date;
}): Promise<RestartScheduleResult> {
  const now = deps.now();
  const key = restartIdempotencyKey(now);
  const out: RestartScheduleResult = { window: restartWindow(now), submitted: [], retried: [], alreadyDone: [] };
  for (const stamp of await deps.stamps.list(500)) {
    if (stamp.status !== 'paused') continue;
    const { job, created } = await deps.jobs.submit({
      kind: POSTGRES_RESTART_KIND,
      subjectType: 'stamp',
      subjectId: stamp.id,
      idempotencyKey: key,
      requestedBy: 'system:postgres-restart-scheduler',
    });
    if (created) out.submitted.push(stamp.id);
    else if (job.state === 'failed') {
      await deps.jobs.retry(job.id);
      out.retried.push(stamp.id);
    } else out.alreadyDone.push(stamp.id);
  }
  return out;
}

// ── REST adapter ──────────────────────────────────────────────────────────────

export interface RestPostgresPowerOptions {
  armEndpoint: string;
  token: (scope: string) => Promise<string>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

const PG_API = '2024-08-01';
const PG_ID = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.DBforPostgreSQL\/flexibleServers\/[A-Za-z0-9-]{3,63}$/i;

export class RestPostgresPower implements PostgresPower {
  private readonly f: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: RestPostgresPowerOptions) {
    this.f = o.fetchFn ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async call(method: string, id: string, suffix: string, op: string): Promise<{ status: number; json?: Record<string, unknown> }> {
    if (!PG_ID.test(id)) throw new JobFailure('bad_server_id', `${op}: not a PostgreSQL flexible server resource id`);
    const res = await this.f(`${this.o.armEndpoint}${id}${suffix}?api-version=${PG_API}`, {
      method,
      headers: { authorization: `Bearer ${await this.o.token(`${this.o.armEndpoint}/.default`)}` },
    });
    if (res.status >= 400 && res.status !== 404) {
      if (res.status === 401 || res.status === 403) {
        throw new JobFailure('permission', `${op}: the control-plane identity is not authorised (HTTP ${res.status}). Grant it a role that can start the PostgreSQL server on the stamp resource group.`);
      }
      throw new JobFailure(res.status === 429 || res.status >= 500 ? 'transient' : 'arm_error', `${op}: Azure returned HTTP ${res.status}`);
    }
    let json: Record<string, unknown> | undefined;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { status: res.status, ...(json ? { json } : {}) };
  }

  async getState(serverId: string): Promise<PostgresState> {
    const r = await this.call('GET', serverId, '', 'read postgres state');
    if (r.status === 404) return 'absent';
    const state = (r.json?.properties as Record<string, unknown> | undefined)?.state;
    return typeof state === 'string' ? state : 'unknown';
  }

  async start(serverId: string): Promise<void> {
    await this.call('POST', serverId, '/start', 'start postgres');
    const max = this.o.maxPolls ?? 120;
    for (let n = 0; n < max; n++) {
      if ((await this.getState(serverId)) === 'Ready') return;
      await this.sleep(this.o.pollMs ?? 5000);
    }
    throw new JobFailure('start_timeout', 'the PostgreSQL server did not reach Ready within the start wait');
  }
}

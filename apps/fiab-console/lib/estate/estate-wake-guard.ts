/**
 * ESTATE WAKE GUARD (#5111) - a data-plane wake must not undo an estate pause.
 *
 * MEASURED 2026-10-24: the estate paused Synapse `loompool` at 02:39Z; the console's
 * own identity resumed it at 03:01Z through `resumePool()` (a routine provisioning /
 * grant / Copilot path), at ~$2.4/h, while the panel said "paused". Nothing in those
 * callers knew the estate was paused.
 *
 * So the verbs that wake a resource the estate pauses call `assertEstateAllowsWake`
 * first. While the PERSISTED estate state is PAUSING or PAUSED it throws a typed
 * `EstatePausedError` that names who paused it, when, and where to resume.
 *
 * What it does NOT block:
 *   - The estate's OWN resume. `pause-actuator`'s `resume` posts straight to ARM
 *     (it never calls `resumePool`/`startKustoCluster`; see its header), so this
 *     guard cannot sit in its path. Pinned by test.
 *   - RESUMING and RESUME_FAILED. The operator has asked for the estate back; a wake
 *     there is aligned with that, not against it.
 *
 * FAILS OPEN. If the stored state cannot be read (Cosmos blip, timeout, odd
 * document) the wake PROCEEDS and a warning is logged. The alternative - failing
 * closed - would make every warehouse, grant and Copilot action unusable whenever
 * Cosmos hiccups, an outage far larger than the cost of one pool running for a few
 * extra minutes. The estate-pause surface itself already reconciles drift, so a
 * wrongly allowed wake is visible and repairable; a wrongly refused one is silent
 * and compounding. Disclosed, not hidden: the warning names the cause.
 *
 * The state is read cross-partition by document id + kind, because the wake sites
 * (a scheduled job, a provisioner) have no session and so no tenant id. A short
 * cache (`LOOM_ESTATE_STATE_CACHE_TTL_MS`, shared with the state route) bounds the
 * Cosmos reads, and every estate pause/resume clears it.
 */
import { cachedStateRead } from './estate-state-cache';

export const ESTATE_PAUSED_CODE = 'ESTATE_PAUSED';

/** Where the operator lifts the pause. Named in every refusal. */
export const ESTATE_RESUME_LOCATION = 'Admin > Scale by SKU > Estate power';

/** Bound on the state read, so a hung Cosmos cannot hang a wake path. */
const READ_TIMEOUT_MS = 3_000;

const WAKE_GUARD_CACHE_KEY = 'estate-wake-guard';

export class EstatePausedError extends Error {
  readonly code = ESTATE_PAUSED_CODE;
  constructor(
    message: string,
    readonly estateState: 'PAUSING' | 'PAUSED',
    readonly pausedBy: string | null,
    readonly pausedAt: string | null,
  ) {
    super(message);
    this.name = 'EstatePausedError';
  }
}

export function isEstatePausedError(e: unknown): e is EstatePausedError {
  return e instanceof EstatePausedError || (!!e && typeof e === 'object' && (e as { code?: unknown }).code === ESTATE_PAUSED_CODE);
}

interface HeldView {
  held: boolean;
  state?: 'PAUSING' | 'PAUSED';
  by?: string | null;
  at?: string | null;
}

interface SnapshotRow {
  state?: string;
  createdBy?: string;
  createdAt?: string;
  pausedAt?: string;
}

async function readHeld(): Promise<{ cacheable: boolean; value: HeldView }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      const [{ maintenanceJobsContainer }, { ESTATE_PAUSE_DOC_ID, ESTATE_PAUSE_DOC_KIND }] = await Promise.all([
        import('@/lib/azure/cosmos-client'),
        import('./pause-orchestrator'),
      ]);
      const c = await maintenanceJobsContainer();
      const { resources } = await c.items
        .query<SnapshotRow>({
          query:
            'SELECT c.snapshot.state AS state, c.snapshot.createdBy AS createdBy, '
            + 'c.snapshot.createdAt AS createdAt, c.snapshot.pausedAt AS pausedAt '
            + 'FROM c WHERE c.id = @id AND c.kind = @kind',
          parameters: [
            { name: '@id', value: ESTATE_PAUSE_DOC_ID },
            { name: '@kind', value: ESTATE_PAUSE_DOC_KIND },
          ],
        })
        .fetchAll();
      return resources;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the estate state read did not answer within ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS);
    });
    const rows = await Promise.race([read, timeout]);
    const hit = (rows ?? []).find((r) => r?.state === 'PAUSING' || r?.state === 'PAUSED');
    if (!hit) return { cacheable: true, value: { held: false } };
    return {
      cacheable: true,
      value: {
        held: true,
        state: hit.state as 'PAUSING' | 'PAUSED',
        by: hit.createdBy ?? null,
        at: hit.pausedAt ?? hit.createdAt ?? null,
      },
    };
  } catch (e) {
    // FAIL OPEN (see header). Not cached, so the next wake re-attempts the read.
    console.warn(
      `[estate-wake-guard] could not read the estate pause state (${e instanceof Error ? e.message : String(e)}); `
      + 'allowing the wake. This is fail-open by design: a Cosmos fault must not make every warehouse unusable.',
    );
    return { cacheable: false, value: { held: false } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The refusal text. States what was established: the stored state, who, and when. */
export function estatePausedMessage(what: string, state: 'PAUSING' | 'PAUSED', by: string | null, at: string | null): string {
  return (
    `The estate is ${state}`
    + `${by ? `, paused by ${by}` : ''}${at ? ` at ${at}` : ''}, so waking ${what} is refused: it would restart billing `
    + `that the estate pause just stopped. Resume the estate first (${ESTATE_RESUME_LOCATION}), then retry.`
  );
}

/**
 * Throw `EstatePausedError` when the persisted estate state is PAUSING or PAUSED.
 * `what` completes "waking ...", e.g. "the Synapse dedicated SQL pool".
 */
export async function assertEstateAllowsWake(what: string): Promise<void> {
  const view = await cachedStateRead<HeldView>(WAKE_GUARD_CACHE_KEY, readHeld);
  if (view.held && view.state) {
    throw new EstatePausedError(estatePausedMessage(what, view.state, view.by ?? null, view.at ?? null), view.state, view.by ?? null, view.at ?? null);
  }
}

/**
 * ESTATE PAUSE - incremental snapshot persistence (review round 1, N1).
 *
 * `startPause` builds the snapshot in memory and the handler saved it only AFTER
 * the whole loop (several sequential ARM calls per app, ~20 apps). A process death
 * or Cosmos error inside that window left apps scaled to min 0 with NO snapshot and
 * therefore no banner, and a re-pause then hit the "already minReplicas 0" no-op, so
 * the original replica range was lost for good.
 *
 * This wraps the actuator so that, immediately BEFORE each real mutation, the
 * snapshot containing that resource's recorded pre-pause state (for a Container
 * App: the exact min/max range) is written to the same Cosmos document the final
 * save uses. Record first, then patch. If the record cannot be written, the
 * mutation is NOT sent and the resource stays running.
 *
 * The final `savePauseSnapshot` still runs and overwrites this document, so the
 * normal path is unchanged. A crash leaves a PAUSING snapshot holding every
 * resource that may have been touched; resume of it is idempotent (an app already
 * at its recorded range is read back and left alone).
 *
 * It writes through its own function rather than `savePauseSnapshot` so the
 * existing call-count contracts of that function stay meaningful: it is the
 * FINAL-state writer. Both write the same document id and kind.
 */
import type { EstateActuator } from './pause-actuator';
import { ESTATE_PAUSE_DOC_ID, ESTATE_PAUSE_DOC_KIND } from './pause-orchestrator';
import { newPauseSnapshot, type EstatePauseSnapshot } from './pause-state';

/** Upsert the pause snapshot document (progress or reset). Throws on Cosmos failure. */
export async function persistPauseProgress(snapshot: EstatePauseSnapshot): Promise<void> {
  const { maintenanceJobsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await maintenanceJobsContainer();
  await c.items.upsert({
    id: ESTATE_PAUSE_DOC_ID,
    tenantId: snapshot.tenantId,
    kind: ESTATE_PAUSE_DOC_KIND,
    snapshot,
    updatedAt: new Date().toISOString(),
  });
}

export interface IncrementalBase {
  id: string;
  tenantId: string;
  estateId: string;
  createdBy?: string;
}

export interface IncrementalPause {
  actuator: EstateActuator;
  /** True once at least one progress write succeeded (so a no-op run must reset it). */
  wasPersisted(): boolean;
}

export function withIncrementalSnapshot(
  actuator: EstateActuator,
  base: IncrementalBase,
  save: (s: EstatePauseSnapshot) => Promise<void> = persistPauseProgress,
): IncrementalPause {
  const snap = newPauseSnapshot(base);
  let persisted = false;
  return {
    wasPersisted: () => persisted,
    actuator: {
      ...actuator,
      pause: async (candidate, entry) => {
        if (entry) {
          snap.resources.push(entry);
          snap.updatedAt = new Date().toISOString();
          try {
            await save({ ...snap, resources: [...snap.resources] });
            persisted = true;
          } catch (e) {
            snap.resources.pop();
            return {
              ok: false,
              detail:
                `The pre-pause state of ${candidate.resource.name} could not be recorded (${e instanceof Error ? e.message.slice(0, 200) : String(e)}), `
                + 'so it was NOT paused: pausing without a record would leave resume guessing. Left RUNNING.',
              error: 'snapshot-persist-failed',
            };
          }
        }
        return actuator.pause(candidate, entry);
      },
    },
  };
}

/**
 * A pause that ended with nothing in motion must not leave a PAUSING record behind
 * (it would poll "0 of N confirmed" forever and block a retry). Put back what was
 * there before - preserving its resume timestamp, which the idle clock reads - or an
 * empty RUNNING record when there was none.
 */
export async function discardPauseProgress(
  previous: EstatePauseSnapshot | null,
  base: IncrementalBase,
  save: (s: EstatePauseSnapshot) => Promise<void> = persistPauseProgress,
): Promise<void> {
  await save(previous ?? { ...newPauseSnapshot(base), state: 'RUNNING' });
}

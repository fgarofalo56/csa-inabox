/**
 * ESTATE PAUSE - re-stopping a flexible server Azure restarted under a PAUSED estate
 * (#5099 phase B).
 *
 * THE FACT (Microsoft Learn, verified 2026-10-23):
 *   - PostgreSQL flexible server: "Server will be automatically started after 7
 *     days if you do not perform a manual start operation" (how-to-stop-server).
 *   - MySQL flexible server: a server stopped for 30 days is automatically started
 *     (how-to-stop-start-server-portal). Not 7: the two engines differ.
 *
 * WHAT THE STATE MACHINE DID BEFORE THIS. `pollPause` already treats a running
 * resource under a PAUSED estate as DRIFT: it reports it (`drifted`,
 * `driftedResources`) and the estate STAYS `PAUSED` (there is no PAUSED -> error
 * edge). It never RESUME_FAILEDs, because that state belongs to the resume path.
 * But nothing re-stopped it, and the idle lane skips an already-paused boundary,
 * so a restarted server billed until an operator noticed.
 *
 * WHAT THIS ADDS. The idle auto-pause lane reads `/state` every 30 minutes. When
 * that read finds a PostgreSQL/MySQL server of this estate running under a PAUSED
 * estate, it re-sends the stop, and ONLY for those two types, because they are the
 * only ones whose restart is Azure's own scheduled behaviour. Everything else that
 * drifts (a Container App someone scaled up, a roll of the estate) stays a report.
 *
 * SAFETY, each independently fail-safe:
 *   - the server must have been RUNNING before Loom paused it (a server that was
 *     already stopped is not Loom's to stop), its pause must not have been
 *     rejected, and its ownership verdict must be 'loom-owned';
 *   - every consumer recorded at pause time must still be CONFIRMED stopped in the
 *     same poll. A consumer that is running again would be broken by the re-stop,
 *     so the server is left running and the reason names that consumer.
 */
import type { EstateActuator } from './pause-actuator';
import { AUTO_RESTART_DAYS, isAutoRestartType } from './pause-autorestart';
import { pausableTypeSpec, type PauseCandidate } from './pause-inventory';
import type { PausePollResult } from './pause-orchestrator';
import { isRunningState, type EstatePauseSnapshot, type PausedResourceSnapshot } from './pause-state';

export interface ReassertOutcome {
  resourceId: string;
  name: string;
  resourceType: string;
  /** restopped: ARM accepted the stop. blocked: deliberately not stopped. failed: ARM rejected it. */
  status: 'restopped' | 'blocked' | 'failed';
  detail: string;
}

function toCandidate(entry: PausedResourceSnapshot): PauseCandidate | null {
  const spec = pausableTypeSpec(entry.resourceType);
  if (!spec) return null;
  return {
    resource: {
      resourceId: entry.resourceId,
      resourceType: entry.resourceType,
      name: entry.name,
      resourceGroup: entry.resourceGroup,
      subscriptionId: entry.subscriptionId,
      ...(entry.location ? { location: entry.location } : {}),
      tags: null,
      discoverySource: 'resource-graph',
    },
    spec,
    ownership: entry.ownership,
  };
}

/**
 * Re-stop each auto-restart-type server in `poll.driftedResources` that passes the
 * safety rules above. Never throws: each server's outcome is reported, a failure
 * as `failed` with ARM's text.
 */
export async function reassertAutoRestarted(
  snapshot: EstatePauseSnapshot,
  poll: Pick<PausePollResult, 'driftedResources' | 'progress'>,
  actuator: EstateActuator,
): Promise<ReassertOutcome[]> {
  const outcomes: ReassertOutcome[] = [];
  const drifted = new Set(poll.driftedResources.map((id) => id.toLowerCase()));
  for (const id of poll.driftedResources) {
    const entry = snapshot.resources.find((r) => r.resourceId.toLowerCase() === id.toLowerCase());
    if (!entry || !isAutoRestartType(entry.resourceType)) continue;
    const base = { resourceId: entry.resourceId, name: entry.name, resourceType: entry.resourceType };
    const blocked = (detail: string): void => {
      outcomes.push({ ...base, status: 'blocked', detail: `${entry.name} is running under a PAUSED estate and was NOT re-stopped: ${detail}` });
    };
    if (entry.ownership?.verdict !== 'loom-owned') {
      blocked(`its ownership verdict is '${entry.ownership?.verdict ?? 'none'}', not 'loom-owned'.`);
      continue;
    }
    if (entry.pauseFailed) {
      blocked('its pause was rejected at pause time, so this is not an Azure auto-restart of a server Loom stopped.');
      continue;
    }
    if (!isRunningState(entry.prePausePowerState)) {
      blocked(`it was ${entry.prePausePowerState} before the pause, so Loom did not stop it and will not stop it now.`);
      continue;
    }
    let pinned: string | null = null;
    for (const consumer of entry.consumers ?? []) {
      const c = snapshot.resources.find((r) => r.name.trim().toLowerCase() === consumer);
      if (!c) {
        pinned = `its consumer ${consumer} is not in the pause snapshot, so it could not be established that it is still stopped.`;
        break;
      }
      const row = poll.progress.find((p) => p.resourceId.toLowerCase() === c.resourceId.toLowerCase());
      if (drifted.has(c.resourceId.toLowerCase()) || row?.atExpectedState !== true) {
        pinned = `its consumer ${consumer} is not confirmed stopped (it is running again or could not be read), and stopping the server would break it.`;
        break;
      }
    }
    if (pinned) {
      blocked(pinned);
      continue;
    }
    const candidate = toCandidate(entry);
    const days = AUTO_RESTART_DAYS[entry.resourceType.toLowerCase()];
    if (!candidate) {
      blocked('its type is not registered as pausable.');
      continue;
    }
    let result;
    try {
      result = await actuator.pause(candidate, entry);
    } catch (e) {
      result = { ok: false, detail: `The re-stop of ${entry.name} threw.`, error: e instanceof Error ? e.message : String(e) };
    }
    outcomes.push({
      ...base,
      status: result.ok ? 'restopped' : 'failed',
      detail: result.ok
        ? `Azure restarts a stopped server of this type on its own after ${days} days; ${entry.name} came back while the estate is PAUSED. ${result.detail} The next state read confirms it.`
        : `${entry.name} is running under a PAUSED estate and the re-stop was not accepted: ${result.error ?? result.detail}`,
    });
  }
  return outcomes;
}

/**
 * Fold the outcomes into the poll the panel renders. The per-resource detail and the
 * headline are REPLACED for a re-asserted server, because the drift text says
 * "Loom has NOT re-paused it", which would be false right after a re-stop. `drifted`
 * is left true: this read saw the server running, and only the next read can say it stopped.
 */
export function applyReassert<T extends Pick<PausePollResult, 'progress' | 'reason' | 'driftedResources' | 'total'>>(
  poll: T,
  outcomes: readonly ReassertOutcome[],
): T {
  if (outcomes.length === 0) return poll;
  const byId = new Map(outcomes.map((o) => [o.resourceId.toLowerCase(), o]));
  const restopped = outcomes.filter((o) => o.status === 'restopped').length;
  const rest = outcomes.length - restopped;
  const others = poll.driftedResources.length - outcomes.length;
  return {
    ...poll,
    progress: poll.progress.map((p) => {
      const o = byId.get(p.resourceId.toLowerCase());
      return o ? { ...p, detail: o.detail } : p;
    }),
    // REPLACED, not appended: the stock drift reason says Loom re-paused nothing, which is false after a re-stop.
    reason:
      `The estate is PAUSED, but ${poll.driftedResources.length} of ${poll.total} resource(s) are RUNNING again. `
      + `${restopped} PostgreSQL/MySQL server(s) were restarted by Azure and Loom re-sent the stop (the next state read confirms it)`
      + (rest ? `; ${rest} more were left running (see each row)` : '')
      + (others > 0
        ? `. ${others} other resource(s) were restarted outside Loom and are reported, not re-paused: press Pause again to re-assert.`
        : '.'),
  };
}

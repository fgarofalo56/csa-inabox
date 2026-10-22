/**
 * ESTATE PAUSED BANNER - the server-side model behind the shell banner
 * (operator decision 2026-10-22: "the console must show a banner when services
 * are paused, with a one-click resume").
 *
 * Reads ONLY the pause snapshot (one Cosmos point read, the same document the
 * Admin estate power panel reads), never ARM: the banner sits on every page of
 * every signed-in user and must not cost an ARM fan-out per page view. The
 * panel's state route stays the authority that PROMOTES a snapshot
 * (PAUSING -> PAUSED, RESUMING -> RUNNING); the banner for an admin drives that
 * route while a transition is in flight.
 *
 * NEVER A SURPRISE: the banner states when the estate was paused and by whom. The
 * identity is shown to tenant admins only; everyone else sees the KIND of
 * actor, so the banner does not publish an administrator's UPN to every user.
 */
import { isPausedState, type EstatePauseSnapshot } from './pause-state';

export type PausedBannerState = 'PAUSING' | 'PAUSED' | 'RESUMING' | 'RESUME_FAILED';

export interface PausedBannerModel {
  paused: true;
  state: PausedBannerState;
  /** How many services Loom itself stopped (already-stopped ones are not counted). */
  count: number;
  /** Display names of those services. */
  names: string[];
  pausedAt: string | null;
  /** Admins: the identity. Everyone else: null. */
  pausedBy: string | null;
  /** 'automation' = a service principal (idle auto-pause lane or the estate-power workflow). */
  pausedByKind: 'person' | 'automation' | 'unknown';
  resumeStartedAt: string | null;
  /** Honest failure text on RESUME_FAILED (the snapshot's own outcomes), else null. */
  failure: string | null;
}

export type PausedBannerResult = { paused: false } | PausedBannerModel;

const SHOWN: readonly string[] = ['PAUSING', 'PAUSED', 'RESUMING', 'RESUME_FAILED'];

/**
 * PURE. Null snapshot, RUNNING, or a snapshot in which Loom stopped nothing
 * (every entry was already stopped before the pause) -> `{ paused: false }`.
 */
export function summarizePausedSnapshot(
  snapshot: EstatePauseSnapshot | null,
  opts: { isAdmin: boolean },
): PausedBannerResult {
  if (!snapshot || !SHOWN.includes(snapshot.state)) return { paused: false };
  // An entry whose pre-pause state was already stopped was not paused by Loom and
  // is not restarted by resume: counting it would overstate what the banner claims.
  const stopped = snapshot.resources.filter((r) => !isPausedState(r.prePausePowerState));
  if (stopped.length === 0) return { paused: false };

  const by = snapshot.createdBy ?? null;
  const kind: PausedBannerModel['pausedByKind'] = by === null ? 'unknown' : by.startsWith('sp:') ? 'automation' : 'person';
  const unconfirmed = (snapshot.resumeOutcomes ?? []).filter(
    (o) => o.confirmation === 'confirmed-mismatch' || o.confirmation === 'unknown',
  );
  const nameOf = new Map(snapshot.resources.map((r) => [r.resourceId, r.name]));
  const failure = snapshot.state === 'RESUME_FAILED'
    ? (unconfirmed.length > 0
      ? `${unconfirmed.length} service(s) are not confirmed back up: ${unconfirmed.map((o) => nameOf.get(o.resourceId) ?? o.resourceId.split('/').pop()).join(', ')}.`
      : 'At least one service is not confirmed back up.')
    : null;

  return {
    paused: true,
    state: snapshot.state as PausedBannerState,
    count: stopped.length,
    names: stopped.map((r) => r.name),
    pausedAt: snapshot.pausedAt ?? snapshot.createdAt ?? null,
    pausedBy: opts.isAdmin ? by : null,
    pausedByKind: kind,
    resumeStartedAt: snapshot.resumeStartedAt ?? null,
    failure,
  };
}

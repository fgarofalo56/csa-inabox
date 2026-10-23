/**
 * ESTATE PAUSE - the guards that need the WHOLE pause set (#5099 phase B).
 *
 * `tierPauseGuard` judges one resource from its own name and tags. Two phase-B
 * rules cannot: a database may be stopped only if its CONSUMERS are being stopped
 * too (`dbPauseGuard`), and an Application Gateway may be stopped only if an ARM
 * read of its backend pools shows it does not front the console (decided
 * asynchronously before the plan, see `./pause-appgateway-guard`, and passed in
 * as `holds`). This module applies both to the in-tier list `planPause` built, and
 * is split out of `./pause-orchestrator` to keep that file under its LOC ceiling.
 */
import type { PauseCandidate } from './pause-inventory';
import { dbPauseGuard, isConsumerType, isDbTierType } from './pause-guards';

export interface OutOfTierRow {
  resourceId: string;
  name: string;
  resourceType: string;
  reason: string;
  /** For a database held out by the dependency guard: the exact consumer that pins it. */
  pinnedBy?: string;
}

/**
 * Apply the set-level guards. Returns the candidates that stay in the pause set
 * (order preserved) and APPENDS every candidate it removes to `outOfTier`, so a
 * held-out resource is visible with its reason and never silently dropped.
 *
 * Order matters and is the safety argument: gateway holds first, then the
 * consumer view is built from what is STILL in the set, so a consumer that was
 * held out by the per-resource guard (never-pause, console, exempt) pins its
 * database.
 */
export function applySetGuards(
  inTier: readonly PauseCandidate[],
  outOfTier: OutOfTierRow[],
  holds?: ReadonlyMap<string, string>,
): PauseCandidate[] {
  const row = (c: PauseCandidate, reason: string, pinnedBy?: string): OutOfTierRow => ({
    resourceId: c.resource.resourceId,
    name: c.resource.name,
    resourceType: c.resource.resourceType,
    reason,
    ...(pinnedBy ? { pinnedBy } : {}),
  });

  const afterHolds: PauseCandidate[] = [];
  for (const c of inTier) {
    const why = holds?.get(c.resource.resourceId.toLowerCase());
    if (why) outOfTier.push(row(c, why));
    else afterHolds.push(c);
  }

  const pausing = new Set<string>();
  const heldOut = new Map<string, string>();
  for (const c of afterHolds) {
    if (isConsumerType(c.resource.resourceType)) pausing.add(c.resource.name.trim().toLowerCase());
  }
  for (const o of outOfTier) {
    if (isConsumerType(o.resourceType)) heldOut.set(o.name.trim().toLowerCase(), o.reason);
  }

  const kept: PauseCandidate[] = [];
  for (const c of afterHolds) {
    if (!isDbTierType(c.resource.resourceType)) {
      kept.push(c);
      continue;
    }
    const g = dbPauseGuard(c.resource, { pausing, heldOut });
    if (g.eligible) kept.push(c);
    else outOfTier.push(row(c, g.reason, g.pinnedBy));
  }
  return kept;
}

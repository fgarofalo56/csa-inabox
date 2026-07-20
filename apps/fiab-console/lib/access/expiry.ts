/**
 * Pure time-bound / expiry helpers (access-governance Wave-3). No Cosmos/ARM —
 * unit-testable. The sweeper route and activation route use these to compute
 * expiry timestamps and select which ledger assignments are due for revocation.
 */
import type { AccessAssignment } from '@/lib/types/access-assignment';

const MS_PER_HOUR = 3600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Compute an ISO expiry from `now`, given a lifetime in days and/or hours. Null when neither. */
export function computeExpiry(now: Date, opts: { lifetimeDays?: number | null; windowHours?: number | null }): string | null {
  const days = opts.lifetimeDays;
  const hours = opts.windowHours;
  let ms = 0;
  if (typeof days === 'number' && days > 0) ms += days * MS_PER_DAY;
  if (typeof hours === 'number' && hours > 0) ms += hours * MS_PER_HOUR;
  if (ms <= 0) return null;
  return new Date(now.getTime() + ms).toISOString();
}

/** Hours until expiry (negative if already past); null when no expiry. */
export function hoursUntil(expiresAt: string | null | undefined, now: Date): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return (t - now.getTime()) / MS_PER_HOUR;
}

/** True when an ACTIVE assignment has a set expiry that is at/before `now`. */
export function isExpired(a: Pick<AccessAssignment, 'state' | 'expiresAt'>, now: Date): boolean {
  if (a.state !== 'active') return false;         // eligible/expired/revoked are never swept
  if (!a.expiresAt) return false;                 // permanent
  const t = Date.parse(a.expiresAt);
  return !Number.isNaN(t) && t <= now.getTime();
}

/**
 * The assignments the sweeper should expire: state='active' AND a set expiresAt
 * that is at/before now. Eligible-not-activated and permanent grants are skipped.
 */
export function selectExpired<T extends Pick<AccessAssignment, 'state' | 'expiresAt'>>(assignments: T[], now: Date): T[] {
  return assignments.filter((a) => isExpired(a, now));
}

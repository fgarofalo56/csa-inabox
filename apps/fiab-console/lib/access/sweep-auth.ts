/**
 * Machine-caller authentication for the access-governance sweep routes (C17).
 *
 * ── Why this file exists (the defect it closes) ────────────────────────────
 * The three sweep routes (`/api/access-governance/sweep`,
 * `…/reviews/sweep`, `…/group-sync`) each hard-gated their machine path on
 * `process.env.LOOM_SWEEPER_TOKEN`. That variable was set NOWHERE in
 * `platform/`, `scripts/` or `.github/` — measured 2026-08-08, `grep -rn
 * LOOM_SWEEPER_TOKEN platform/ scripts/ .github/` exited 1 (zero matches) —
 * and the Function that was supposed to present it
 * (`azure-functions/access-governance-sweeper`) was absent from platform bicep
 * entirely. `isValidInternalToken`-style fail-closed logic therefore rejected
 * every machine call, on every estate, since the routes were written.
 *
 * The consequence was NOT cosmetic: expiry auto-revoke ran only when a human
 * tenant-admin pressed "Run sweep". Time-bound access that should have expired
 * stayed LIVE — a real ARM role assignment and a real SQL/ADX data-plane grant
 * — until someone happened to click. Review campaigns past their deadline never
 * auto-closed, so undecided grants were never revoked.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * The scheduled caller is now an in-VNet Container App Job that presents the
 * SHARED `LOOM_INTERNAL_TOKEN` — a deterministic `guid()` the deploy already
 * mints and wires to the Console UNCONDITIONALLY
 * (admin-plane/main.bicep, `secretRef: 'loom-internal-token'`). Per
 * `auto-bind-by-default.md` §5 the value is PRODUCED BY THE DEPLOY; there is no
 * operator step and no "set LOOM_SWEEPER_TOKEN" terminal state.
 *
 * `LOOM_SWEEPER_TOKEN` remains accepted when an operator has explicitly set it
 * (so any estate that wired it by hand keeps working), but it is never
 * REQUIRED and is no longer the only machine path.
 */
import type { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';

/** Legacy header the retired sweeper Function presented. Still honoured. */
export const LEGACY_SYSTEM_TOKEN_HEADER = 'x-loom-system-token';

/**
 * Constant-time compare for the legacy shared secret. Digests both sides so
 * `timingSafeEqual` always sees equal-length buffers and the secret length is
 * never leaked.
 */
function legacySweeperTokenOk(presented: string | null | undefined): boolean {
  const expected = (process.env.LOOM_SWEEPER_TOKEN || '').trim();
  // Fail closed when the legacy var is unset — this is the DEFAULT state and is
  // exactly why the machine path was dead before C17. The internal-token path
  // below is what actually carries scheduled callers now.
  if (!expected) return false;
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf-8').digest();
  const b = crypto.createHash('sha256').update(presented, 'utf-8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the request carries a valid SYSTEM credential for a sweep route.
 *
 * Accepted, in order:
 *   1. `x-loom-internal-token` / `Authorization: Bearer …` matching the shared
 *      deploy-minted `LOOM_INTERNAL_TOKEN` — the scheduled ACA job's path.
 *   2. `x-loom-system-token` matching `LOOM_SWEEPER_TOKEN`, only when an
 *      operator explicitly set that var (legacy compatibility).
 *
 * Returns false when neither matches, so callers fall through to the
 * tenant-admin session check. Never throws.
 */
export function isSweepSystemCaller(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const internal = req.headers.get(INTERNAL_TOKEN_HEADER) || bearer || null;
  if (isValidInternalToken(internal)) return true;
  return legacySweeperTokenOk(req.headers.get(LEGACY_SYSTEM_TOKEN_HEADER));
}

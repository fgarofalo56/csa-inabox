'use client';

/**
 * ShellSession context — the SINGLE source of admin truth for the client
 * chrome (rel-T53 / rel-T54).
 *
 * AppShell probes GET /api/me exactly once and feeds the result here; every
 * consumer (left nav, catalog rail, governance rail) reads the cached value
 * via {@link useShellSession} / {@link useIsTenantAdmin} rather than issuing
 * its own /api/me call. That keeps admin-gating decisions consistent across
 * the whole shell from one network round-trip.
 *
 * `isTenantAdmin` mirrors the fail-closed server check in
 * lib/auth/feature-gate — it is FALSE while the probe is in flight and for
 * non-admins, so admin-only destinations stay hidden until the caller is
 * positively confirmed as a tenant admin. This is presentation-only; the BFF
 * routes and admin pages still enforce their own hard gate.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface ShellSession {
  authenticated: boolean;
  user: null | { name: string; email?: string; upn: string; oid: string };
  /** Tenant admin per the fail-closed isTenantAdmin server check. */
  isTenantAdmin: boolean;
  /** True until the single /api/me probe in AppShell resolves. */
  loading: boolean;
}

const DEFAULT: ShellSession = {
  authenticated: false,
  user: null,
  isTenantAdmin: false,
  loading: true,
};

const SessionContext = createContext<ShellSession>(DEFAULT);

export function SessionProvider({ value, children }: { value: ShellSession; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Read the full shell session (identity + admin flag + loading). */
export function useShellSession(): ShellSession {
  return useContext(SessionContext);
}

/**
 * True only once the single shell probe has POSITIVELY confirmed the caller is
 * a tenant admin. Fail-closed: false while loading and for non-admins — safe to
 * use directly to hide admin-only nav destinations.
 */
export function useIsTenantAdmin(): boolean {
  return useContext(SessionContext).isTenantAdmin;
}

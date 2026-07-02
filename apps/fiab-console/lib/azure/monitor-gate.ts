import { NextResponse } from 'next/server';
import { MonitorNotConfiguredError, MonitorError } from '@/lib/azure/monitor-client';

/**
 * Shared Azure Monitor error → honest-gate mapper.
 *
 * Behavior-preserving extract of the per-route `monitorGate` helpers. The
 * branching (which Monitor error maps to which HTTP status) was identical
 * across ~11 routes, but each route names a DIFFERENT missing env var / role /
 * reason in the response body. So the control flow lives here and each caller
 * passes its exact body via the `bodies` builders — the emitted JSON envelope
 * and status codes are byte-for-byte what the inlined copies produced.
 *
 *   MonitorNotConfiguredError  → 503 { ok:false, ...bodies.notConfigured(e.missing) }
 *   MonitorError (401|403)     → 403 { ok:false, ...bodies.unauthorized(e.status) }
 *   anything else              → null  (caller falls through to its own 502)
 */
export interface MonitorGateBodies {
  /** 503 body (minus `ok:false`) when Azure Monitor env vars are unset. */
  notConfigured: (missing: string[] | undefined) => Record<string, unknown>;
  /** 403 body (minus `ok:false`) when the UAMI lacks the required role. */
  unauthorized: (status: number) => Record<string, unknown>;
}

export function monitorGate(e: unknown, bodies: MonitorGateBodies): NextResponse | null {
  if (e instanceof MonitorNotConfiguredError) {
    return NextResponse.json({ ok: false, ...bodies.notConfigured(e.missing) }, { status: 503 });
  }
  if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({ ok: false, ...bodies.unauthorized(e.status) }, { status: 403 });
  }
  return null;
}

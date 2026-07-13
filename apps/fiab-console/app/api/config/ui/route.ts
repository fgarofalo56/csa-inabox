/**
 * GET /api/config/ui — public (session-optional) runtime UI config.
 *
 * This is the RUNTIME replacement for the client-baked NEXT_PUBLIC_LOOM_BI_BACKEND
 * build var. The client bundle can no longer read a NEXT_PUBLIC_* value to decide
 * whether the Power BI backend is on (that value is frozen at build time); instead
 * every editor fetches this endpoint (via useBiBackend()) and reacts to the
 * effective, admin-settable value with NO rebuild.
 *
 * Returns only NON-SENSITIVE feature flags — safe to serve without an admin gate
 * (the editors it feeds are already behind auth, and the value is just "is the
 * Power BI opt-in on"). No secrets, no infra identifiers.
 *
 * Effective value resolution (see lib/admin/platform-settings.ts):
 *   runtime admin setting > server env LOOM_BI_BACKEND > default 'loom-native'.
 */
import { NextResponse } from 'next/server';
import { resolveBiBackendMode } from '@/lib/admin/platform-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Best-effort: a store failure falls back to the env/default resolution
  // inside resolveBiBackendMode, so this endpoint never 500s the editors.
  let biBackend: 'loom-native' | 'powerbi' = 'loom-native';
  try {
    biBackend = await resolveBiBackendMode();
  } catch {
    biBackend = 'loom-native';
  }
  return NextResponse.json({
    ok: true,
    biBackend,
    powerBiEnabled: biBackend === 'powerbi',
  });
}

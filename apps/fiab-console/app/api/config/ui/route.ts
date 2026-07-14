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
import { resolveBiBackendMode, resolveMapsAccount } from '@/lib/admin/platform-settings';
import { isMapsConfigured } from '@/lib/azure/maps-client';

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
  // Azure Maps runtime status — replaces the client-baked NEXT_PUBLIC_LOOM_AZURE_MAPS_*
  // build vars. `mapsEnabled` = a server-side credential is configured (checked
  // WITHOUT minting a token — the token stays in the /api/maps/* broker routes);
  // `mapsAccount` = the non-secret account label/uniqueId used to prefill the geo
  // editors. Neither is sensitive. Best-effort — never 500s the editors.
  let mapsEnabled = false;
  let mapsAccount = '';
  try {
    mapsEnabled = isMapsConfigured();
    mapsAccount = await resolveMapsAccount();
  } catch {
    mapsEnabled = false;
    mapsAccount = '';
  }
  return NextResponse.json({
    ok: true,
    biBackend,
    powerBiEnabled: biBackend === 'powerbi',
    mapsEnabled,
    mapsAccount,
  });
}

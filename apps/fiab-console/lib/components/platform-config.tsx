'use client';

/**
 * Runtime platform config for the CLIENT — the replacement for the build-baked
 * NEXT_PUBLIC_LOOM_BI_BACKEND var.
 *
 * A NEXT_PUBLIC_* value is frozen into the client bundle at BUILD time, so it
 * could never be flipped from the running console — the operator's exact
 * complaint ("editors say 'set NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi' but there's
 * nowhere in the console to set it"). Instead the effective value is served at
 * RUNTIME by GET /api/config/ui and read here via {@link useBiBackend}; an admin
 * flips the backend in /admin and every editor reacts with NO rebuild.
 *
 * The fetch is memoized module-wide (one in-flight promise, cached result) so
 * that the many editors calling useBiBackend() share a SINGLE round-trip — the
 * same one-probe pattern the shell uses for /api/me. Fail-closed: until the
 * probe resolves (and on any error) the value is the Azure-native default
 * (`powerBiEnabled:false`), so no Power BI affordance ever flashes before the
 * config confirms it is opted in (no-fabric-dependency.md).
 */

import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';

export type BiBackendMode = 'loom-native' | 'powerbi';

export interface PlatformConfig {
  biBackend: BiBackendMode;
  powerBiEnabled: boolean;
  /** Azure Maps configured server-side (credential present) — the runtime
   *  replacement for the client-baked NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY. When true,
   *  geo surfaces render the live basemap via the /api/maps/static proxy (no
   *  credential in the client). */
  mapsEnabled: boolean;
  /** Non-secret Azure Maps account label/uniqueId — prefills the geo editors
   *  (was NEXT_PUBLIC_LOOM_AZURE_MAPS_ACCOUNT). Empty when unset. */
  mapsAccount: string;
}

/** Azure-native default — used while loading and on any fetch error. */
export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  biBackend: 'loom-native',
  powerBiEnabled: false,
  mapsEnabled: false,
  mapsAccount: '',
};

let _cache: PlatformConfig | null = null;
let _inflight: Promise<PlatformConfig> | null = null;

function coerce(d: unknown): PlatformConfig {
  const o = (d ?? {}) as Record<string, unknown>;
  const biBackend: BiBackendMode = o.biBackend === 'powerbi' ? 'powerbi' : 'loom-native';
  return {
    biBackend,
    powerBiEnabled: biBackend === 'powerbi',
    mapsEnabled: o.mapsEnabled === true,
    mapsAccount: typeof o.mapsAccount === 'string' ? o.mapsAccount : '',
  };
}

/** Shared, memoized fetch of GET /api/config/ui. Never rejects. */
export function loadPlatformConfig(): Promise<PlatformConfig> {
  if (_cache) return Promise.resolve(_cache);
  if (!_inflight) {
    _inflight = clientFetch('/api/config/ui')
      .then((r) => r.json())
      .then((d) => { _cache = coerce(d); return _cache; })
      .catch(() => DEFAULT_PLATFORM_CONFIG)
      .finally(() => { _inflight = null; });
  }
  return _inflight;
}

/**
 * Clear the memoized config so the NEXT read re-fetches. Called after the admin
 * toggle saves, so an admin sees editors react without a full reload.
 */
export function invalidatePlatformConfig(): void {
  _cache = null;
}

export interface UsePlatformConfig {
  config: PlatformConfig;
  loading: boolean;
}

/** Read the runtime platform config (shared single fetch). */
export function usePlatformConfig(): UsePlatformConfig {
  const [config, setConfig] = useState<PlatformConfig>(_cache ?? DEFAULT_PLATFORM_CONFIG);
  const [loading, setLoading] = useState<boolean>(_cache == null);

  useEffect(() => {
    let cancelled = false;
    if (_cache) { setConfig(_cache); setLoading(false); return; }
    loadPlatformConfig().then((c) => {
      if (!cancelled) { setConfig(c); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, []);

  return { config, loading };
}

export interface UseBiBackend {
  biBackend: BiBackendMode;
  /** True only once the runtime config CONFIRMS the Power BI opt-in is on. */
  powerBiEnabled: boolean;
  loading: boolean;
}

/**
 * The runtime BI backend selection. Editors use `powerBiEnabled` to show/hide
 * the Power BI workspace picker / embed / sync affordances. Fail-closed: false
 * while loading, so the Azure-native surface renders first and Power BI controls
 * appear only when the admin has opted in.
 */
export function useBiBackend(): UseBiBackend {
  const { config, loading } = usePlatformConfig();
  return { biBackend: config.biBackend, powerBiEnabled: config.powerBiEnabled, loading };
}

export interface UseMapsConfig {
  /** True once the runtime config CONFIRMS an Azure Maps credential is configured
   *  server-side. Fail-closed: false while loading, so the vector overlay renders
   *  first and the raster basemap appears only when Maps is really available. */
  mapsEnabled: boolean;
  /** Non-secret account label/uniqueId for prefilling the geo editors. */
  mapsAccount: string;
  loading: boolean;
}

/**
 * The runtime Azure Maps status. Replaces every client-baked
 * NEXT_PUBLIC_LOOM_AZURE_MAPS_KEY / _ACCOUNT read. Geo/tapestry/map editors use
 * `mapsEnabled` to decide whether to layer the live raster basemap (fetched via
 * the credential-free {@link mapsStaticUrl} proxy) and `mapsAccount` to prefill
 * the account field.
 */
export function useMapsConfig(): UseMapsConfig {
  const { config, loading } = usePlatformConfig();
  return { mapsEnabled: config.mapsEnabled, mapsAccount: config.mapsAccount, loading };
}

/**
 * Build a credential-free URL to the server-side static-raster proxy
 * (/api/maps/static). The browser `<img src>` never carries a key/token — the
 * proxy resolves the credential server-side. Callers pass the bbox center/zoom
 * and size; only include this when {@link useMapsConfig}().mapsEnabled is true.
 */
export function mapsStaticUrl(opts: {
  style?: string; zoom: number; lon: number; lat: number; width?: number; height?: number;
}): string {
  const p = new URLSearchParams({
    style: opts.style || 'main',
    zoom: String(Math.round(opts.zoom)),
    lon: String(opts.lon),
    lat: String(opts.lat),
    width: String(Math.round(opts.width ?? 640)),
    height: String(Math.round(opts.height ?? 360)),
  });
  return `/api/maps/static?${p.toString()}`;
}

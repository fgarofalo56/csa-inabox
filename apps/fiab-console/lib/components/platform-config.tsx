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
}

/** Azure-native default — used while loading and on any fetch error. */
export const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  biBackend: 'loom-native',
  powerBiEnabled: false,
};

let _cache: PlatformConfig | null = null;
let _inflight: Promise<PlatformConfig> | null = null;

function coerce(d: unknown): PlatformConfig {
  const o = (d ?? {}) as Record<string, unknown>;
  const biBackend: BiBackendMode = o.biBackend === 'powerbi' ? 'powerbi' : 'loom-native';
  return { biBackend, powerBiEnabled: biBackend === 'powerbi' };
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

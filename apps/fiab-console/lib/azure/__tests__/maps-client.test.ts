import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveMapsBackend,
  isMapsConfigured,
  isMapLibreConfigured,
  resolveMapsTileOrigin,
  MAPS_STYLE_PROXY_URL,
  MAPS_GL_JS_PROXY_URL,
  MAPS_GL_CSS_PROXY_URL,
} from '../maps-client';

/**
 * maps-client backend switch — the OSS MapLibre (GCC-High / sovereign) path plus
 * the existing Azure Maps opt-in + honest gates. The AAD path is not covered here
 * (it mints a real UAMI token); we exercise the pure env-driven verdicts:
 * maplibre (Gov default), the subscription-key path, and the honest gates.
 */
describe('maps-client resolveMapsBackend', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.LOOM_MAPS_BACKEND;
    delete process.env.LOOM_MAPS_TILE_URL;
    delete process.env.LOOM_AZURE_MAPS_CLIENT_ID;
    delete process.env.LOOM_AZURE_MAPS_KEY;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('routes to OSS MapLibre when LOOM_MAPS_BACKEND=maplibre + a tile URL (the Gov path)', async () => {
    process.env.LOOM_MAPS_BACKEND = 'maplibre';
    process.env.LOOM_MAPS_TILE_URL = 'https://loom-maps-tiles.internal.azurecontainerapps.io/style.json';
    const b = await resolveMapsBackend();
    expect(b.ok).toBe(true);
    if (b.ok && b.mode === 'maplibre') {
      // The browser is handed the Console proxy paths — never the internal host.
      expect(b.styleUrl).toBe(MAPS_STYLE_PROXY_URL);
      expect(b.glJsUrl).toBe(MAPS_GL_JS_PROXY_URL);
      expect(b.glCssUrl).toBe(MAPS_GL_CSS_PROXY_URL);
      expect(b.styleUrl.startsWith('/api/maps/tiles')).toBe(true);
      expect(b.styleUrl).not.toContain('azurecontainerapps.io');
    } else {
      throw new Error('expected maplibre mode');
    }
  });

  it('honest-gates maplibre when the tile URL is missing (names LOOM_MAPS_TILE_URL)', async () => {
    process.env.LOOM_MAPS_BACKEND = 'maplibre';
    const b = await resolveMapsBackend();
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.envVar).toBe('LOOM_MAPS_TILE_URL');
      expect(b.reason).toMatch(/tileserver|tile server|maplibre/i);
      expect(b.reason).toMatch(/loom-maps-app\.bicep/);
    }
  });

  it('honest-gates (default) when nothing is configured, offering both paths', async () => {
    const b = await resolveMapsBackend();
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.envVar).toBe('LOOM_MAPS_BACKEND');
      expect(b.reason).toMatch(/maplibre/);
      expect(b.reason).toMatch(/azure-maps/);
    }
  });

  it('keeps the Azure Maps subscription-key opt-in path (Commercial)', async () => {
    process.env.LOOM_MAPS_BACKEND = 'azure-maps';
    process.env.LOOM_AZURE_MAPS_KEY = 'test-key-123';
    const b = await resolveMapsBackend();
    expect(b.ok).toBe(true);
    if (b.ok && b.mode === 'key') expect(b.key).toBe('test-key-123');
    else throw new Error('expected key mode');
  });

  it('honest-gates azure-maps opted-in with no credential', async () => {
    process.env.LOOM_MAPS_BACKEND = 'azure-maps';
    const b = await resolveMapsBackend();
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.envVar).toBe('LOOM_MAPS_BACKEND');
  });

  it('isMapsConfigured / isMapLibreConfigured reflect the maplibre backend', () => {
    process.env.LOOM_MAPS_BACKEND = 'maplibre';
    process.env.LOOM_MAPS_TILE_URL = 'https://loom-maps-tiles.internal/style.json';
    expect(isMapsConfigured()).toBe(true);
    expect(isMapLibreConfigured()).toBe(true);
    delete process.env.LOOM_MAPS_TILE_URL;
    expect(isMapsConfigured()).toBe(false);
    expect(isMapLibreConfigured()).toBe(false);
  });

  it('resolveMapsTileOrigin strips the trailing /style.json path', () => {
    process.env.LOOM_MAPS_TILE_URL = 'https://loom-maps-tiles.internal.azurecontainerapps.io/style.json';
    expect(resolveMapsTileOrigin()).toBe('https://loom-maps-tiles.internal.azurecontainerapps.io');
    delete process.env.LOOM_MAPS_TILE_URL;
    expect(resolveMapsTileOrigin()).toBe('');
  });
});

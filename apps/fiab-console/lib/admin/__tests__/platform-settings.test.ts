import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Resolution-order tests for the BI-backend runtime toggle:
 *   runtime admin setting > server env LOOM_BI_BACKEND > default 'loom-native'.
 *
 * The Cosmos singleton read is mocked via `envConfigContainer` so the pure
 * resolution logic is exercised without a live store.
 */

// Mock the Cosmos client — only envConfigContainer is used by platform-settings.
const mockRead = vi.fn();
const mockUpsert = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  envConfigContainer: async () => ({
    item: () => ({ read: mockRead }),
    items: { upsert: mockUpsert },
  }),
}));

import {
  biBackendModeFromEnv,
  resolveBiBackendMode,
  resolveBiBackendWithSource,
  isBiBackendMode,
  powerBiEnabled,
} from '../platform-settings';

function docResult(biBackend?: string) {
  return { resource: biBackend === undefined ? undefined : { id: '__platform__', tenantId: '__platform__', biBackend } };
}

describe('platform-settings — BI backend resolution', () => {
  beforeEach(() => {
    mockRead.mockReset();
    mockUpsert.mockReset();
    delete process.env.LOOM_BI_BACKEND;
    delete process.env.NEXT_PUBLIC_LOOM_BI_BACKEND;
  });

  it('isBiBackendMode guards the two valid modes only', () => {
    expect(isBiBackendMode('loom-native')).toBe(true);
    expect(isBiBackendMode('powerbi')).toBe(true);
    expect(isBiBackendMode('aas')).toBe(false);
    expect(isBiBackendMode('')).toBe(false);
    expect(isBiBackendMode(undefined)).toBe(false);
  });

  it('biBackendModeFromEnv: powerbi only when env is powerbi; else loom-native', () => {
    expect(biBackendModeFromEnv()).toBe('loom-native');
    process.env.LOOM_BI_BACKEND = 'powerbi';
    expect(biBackendModeFromEnv()).toBe('powerbi');
    process.env.LOOM_BI_BACKEND = 'aas';
    expect(biBackendModeFromEnv()).toBe('loom-native');
    process.env.LOOM_BI_BACKEND = 'PowerBI'; // case-insensitive
    expect(biBackendModeFromEnv()).toBe('powerbi');
  });

  it('runtime setting WINS over env (runtime powerbi, env aas)', async () => {
    process.env.LOOM_BI_BACKEND = 'aas';
    mockRead.mockResolvedValue(docResult('powerbi'));
    expect(await resolveBiBackendMode()).toBe('powerbi');
    expect(await powerBiEnabled()).toBe(true);
    const withSrc = await resolveBiBackendWithSource();
    expect(withSrc.source).toBe('runtime');
    expect(withSrc.mode).toBe('powerbi');
    expect(withSrc.envValue).toBe('aas');
  });

  it('runtime setting WINS over env (runtime loom-native, env powerbi)', async () => {
    process.env.LOOM_BI_BACKEND = 'powerbi';
    mockRead.mockResolvedValue(docResult('loom-native'));
    expect(await resolveBiBackendMode()).toBe('loom-native');
    expect(await powerBiEnabled()).toBe(false);
    expect((await resolveBiBackendWithSource()).source).toBe('runtime');
  });

  it('falls back to env when no runtime doc', async () => {
    process.env.LOOM_BI_BACKEND = 'powerbi';
    mockRead.mockResolvedValue(docResult(undefined)); // no doc
    expect(await resolveBiBackendMode()).toBe('powerbi');
    const withSrc = await resolveBiBackendWithSource();
    expect(withSrc.source).toBe('env');
    expect(withSrc.mode).toBe('powerbi');
  });

  it('defaults to loom-native when neither runtime nor env is set', async () => {
    mockRead.mockResolvedValue(docResult(undefined));
    expect(await resolveBiBackendMode()).toBe('loom-native');
    const withSrc = await resolveBiBackendWithSource();
    expect(withSrc.source).toBe('default');
    expect(withSrc.mode).toBe('loom-native');
  });

  it('never throws on a store failure — falls back to env/default', async () => {
    process.env.LOOM_BI_BACKEND = 'powerbi';
    mockRead.mockRejectedValue(new Error('cosmos down'));
    // resolveBiBackendMode swallows and uses env.
    expect(await resolveBiBackendMode()).toBe('powerbi');
  });

  it('treats a 404 (never-written doc) as unset', async () => {
    const notFound: any = new Error('not found');
    notFound.code = 404;
    mockRead.mockRejectedValue(notFound);
    expect(await resolveBiBackendMode()).toBe('loom-native');
  });
});

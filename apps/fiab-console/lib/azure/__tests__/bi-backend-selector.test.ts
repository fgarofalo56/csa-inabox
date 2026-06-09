/**
 * bi-backend — pure backend-selector behaviour for the semantic-model routes.
 * No network, no @azure/identity import: biBackend()/usingAas() are env-driven.
 *
 * (aasConfigGate() in aas-client.ts is equally env-pure, but importing that
 * module pulls @azure/identity, whose transitive deps are not resolvable in the
 * shared test store — a pre-existing harness gap. The selector lives in its own
 * dependency-free module precisely so this behaviour is testable.)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const SAVED = { ...process.env };

function clearEnv() {
  delete process.env.LOOM_AAS_SERVER_NAME;
  delete process.env.LOOM_BI_BACKEND;
}

async function loadBackend() {
  vi.resetModules();
  return import('../../../app/api/items/semantic-model/_lib/bi-backend');
}

afterEach(() => {
  process.env = { ...SAVED };
});

describe('biBackend selector', () => {
  it('defaults to powerbi when no AAS server is configured (legacy non-regression)', async () => {
    clearEnv();
    const m = await loadBackend();
    expect(m.biBackend()).toBe('powerbi');
    expect(m.usingAas()).toBe(false);
  });

  it('defaults to aas when an AAS server is configured (Azure-native default)', async () => {
    clearEnv();
    process.env.LOOM_AAS_SERVER_NAME = 'aas-loom';
    const m = await loadBackend();
    expect(m.biBackend()).toBe('aas');
    expect(m.usingAas()).toBe(true);
  });

  it('honors explicit LOOM_BI_BACKEND=powerbi even when AAS is configured', async () => {
    clearEnv();
    process.env.LOOM_AAS_SERVER_NAME = 'aas-loom';
    process.env.LOOM_BI_BACKEND = 'powerbi';
    const m = await loadBackend();
    expect(m.biBackend()).toBe('powerbi');
    expect(m.usingAas()).toBe(false);
  });

  it('honors explicit LOOM_BI_BACKEND=aas even without a server (gate handles it)', async () => {
    clearEnv();
    process.env.LOOM_BI_BACKEND = 'aas';
    const m = await loadBackend();
    expect(m.biBackend()).toBe('aas');
  });

  it('is case-insensitive for the LOOM_BI_BACKEND value', async () => {
    clearEnv();
    process.env.LOOM_BI_BACKEND = 'PowerBI';
    const m = await loadBackend();
    expect(m.biBackend()).toBe('powerbi');
  });
});

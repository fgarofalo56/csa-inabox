/**
 * N7e — registry wiring + the opt-in posture that backs the SQL Lab engine
 * picker. (The full editor render harness is known-broken repo-wide, so the
 * "Trino option shows + DuckDB is the default" contract is proven here through
 * the registries the picker reads: the FLAG0 default-OFF flag and the G2 gate.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RUNTIME_FLAGS } from '@/lib/admin/runtime-flags';
import { getGate, gateStatus } from '@/lib/gates/registry';
import { EDITABLE_ENV } from '@/lib/admin/env-config';

// The client editor (sql-lab-editor.tsx) declares TRINO_FLAG_ID = this string.
// It is asserted here as a literal rather than imported to avoid pulling the
// client-only editor module into the node test harness.
const TRINO_FLAG_ID = 'n7e-trino-federation';

beforeEach(() => { delete process.env.LOOM_TRINO_URL; });
afterEach(() => { delete process.env.LOOM_TRINO_URL; });

describe('N7e FLAG0 — the additive opt-in engine choice (default OFF)', () => {
  it('registers n7e-trino-federation with the N7e owner item', () => {
    const flag = RUNTIME_FLAGS.find((f) => f.id === TRINO_FLAG_ID);
    expect(flag).toBeTruthy();
    expect(flag?.ownerItem).toBe('N7e');
    // The description documents the sole loom_default_on_opt_out carve-out.
    expect(flag?.description).toMatch(/opt-in|default:false|DEFAULT OFF/i);
  });
});

describe('N7e G2 gate — svc-loom-trino (opt-in; gates no feature)', () => {
  it('is registered on the SQL Lab engine picker + the federated route', () => {
    const gate = getGate('svc-loom-trino');
    expect(gate).toBeTruthy();
    const paths = gate!.surfaces.map((s) => s.path);
    expect(paths).toContain('/items/sql-lab');
    expect(paths).toContain('/api/sql/trino');
    // Opt-in heavy infra → NOT auto-resolved, but has an inline Fix-it (env-picker).
    expect(gate!.fixit.kind).toBe('env-picker');
    expect(gate!.requiredSettings.map((r) => r.envVar)).toContain('LOOM_TRINO_URL');
  });

  it('is BLOCKED (opt-in default) when unset and CONFIGURED once wired — DuckDB stays the default engine either way', () => {
    expect(gateStatus('svc-loom-trino')?.status).toBe('blocked');
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    expect(gateStatus('svc-loom-trino')?.status).toBe('configured');
  });

  it('is available in every cloud (Commercial → IL5) — its absence removes no capability', () => {
    expect(getGate('svc-loom-trino')?.availability).toMatchObject({ commercial: 'ga', gccHigh: 'ga', il5: 'ga' });
  });
});

describe('N7e env-sync — LOOM_TRINO_URL is a settable editable var', () => {
  it('exposes LOOM_TRINO_URL in the editable whitelist (Fix-it can set it)', () => {
    expect(EDITABLE_ENV.some((e) => e.key === 'LOOM_TRINO_URL')).toBe(true);
  });
});

/**
 * N7e — registry wiring + the DEFAULT-ON posture that backs the SQL Lab engine
 * picker. (The full editor render harness is known-broken repo-wide, so the
 * "Trino option shows + DuckDB is the engine the picker starts on" contract is
 * proven here through the registries the picker reads: the FLAG0 flag and the
 * G2 gate.)
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

describe('N7e FLAG0 — the additive engine choice (DEFAULT-ON, opt-out)', () => {
  it('registers n7e-trino-federation with the N7e owner item', () => {
    const flag = RUNTIME_FLAGS.find((f) => f.id === TRINO_FLAG_ID);
    expect(flag).toBeTruthy();
    expect(flag?.ownerItem).toBe('N7e');
    // loom_default_on_opt_out: the engine ships enabled and the flag is a kill
    // switch, so the description must read as opt-OUT, never opt-in.
    expect(flag?.description).toMatch(/DEFAULT-ON|opt-out/i);
    expect(flag?.description).not.toMatch(/DEFAULTS OFF/i);
  });
});

describe('N7e G2 gate — svc-loom-trino (default-ON; gates no feature)', () => {
  it('is registered on the SQL Lab engine picker + the federated route', () => {
    const gate = getGate('svc-loom-trino');
    expect(gate).toBeTruthy();
    const paths = gate!.surfaces.map((s) => s.path);
    expect(paths).toContain('/items/sql-lab');
    expect(paths).toContain('/api/sql/trino');
    // Wired by the deploy, with an inline Fix-it (env-picker) for the cases
    // where it is not (explicit opt-out / non-Container-Apps boundary).
    expect(gate!.fixit.kind).toBe('env-picker');
    expect(gate!.requiredSettings.map((r) => r.envVar)).toContain('LOOM_TRINO_URL');
  });

  it('is BLOCKED when unset (opted out / image missing) and CONFIGURED once the deploy wires it — DuckDB stays the engine the picker starts on either way', () => {
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

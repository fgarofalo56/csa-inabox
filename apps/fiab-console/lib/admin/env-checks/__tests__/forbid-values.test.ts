/**
 * #2678 §3 — evalEnv forbidValues: a var SET to an explicitly-unsafe value must
 * NOT report the clean 'pass' it used to. The security-load-bearing case is the
 * Trino engine deployed anonymous/unauthorized (LOOM_TRINO_AUTH_MODE=disabled or
 * LOOM_TRINO_ACCESS_CONTROL=none), which previously reported GREEN because the
 * check only observed LOOM_TRINO_URL.
 *
 * MUTATION PROOF: deleting the `forbidValues` field from the trino spec (reverting
 * the fix) turns the "flags disabled" assertion RED — the check would report
 * 'pass' again.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { evalEnv, type EnvSpec } from '../core';
import { DATA_PLANE_ENV_CHECKS } from '../data-plane';

const trinoSpec = DATA_PLANE_ENV_CHECKS.find((s) => s.id === 'svc-loom-trino') as EnvSpec;

afterEach(() => {
  delete process.env.LOOM_TRINO_URL;
  delete process.env.LOOM_TRINO_AUTH_MODE;
  delete process.env.LOOM_TRINO_ACCESS_CONTROL;
});

describe('svc-loom-trino gate observes the auth posture (#2678 §3)', () => {
  it('carries the forbidValues predicate for the anonymous/unauthorized postures', () => {
    expect(trinoSpec.forbidValues?.LOOM_TRINO_AUTH_MODE).toContain('disabled');
    expect(trinoSpec.forbidValues?.LOOM_TRINO_ACCESS_CONTROL).toContain('none');
  });

  it('PASSES when the engine is wired and enforcing (entra)', () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'entra';
    expect(evalEnv(trinoSpec).status).toBe('pass');
  });

  it('PASSES when SEALED (enforced, serves nobody — a safe default)', () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'sealed';
    expect(evalEnv(trinoSpec).status).toBe('pass');
  });

  it('WARNS loudly when deployed anonymous (disabled) — no longer a green pass', () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_AUTH_MODE = 'disabled';
    const r = evalEnv(trinoSpec);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('SECURITY');
    expect(r.detail?.toLowerCase()).toContain('unauthenticated');
  });

  it('WARNS when engine catalog authorization is disabled (access control none)', () => {
    process.env.LOOM_TRINO_URL = 'https://trino.internal';
    process.env.LOOM_TRINO_ACCESS_CONTROL = 'none';
    expect(evalEnv(trinoSpec).status).toBe('warn');
  });
});

describe('evalEnv forbidValues — generic behavior', () => {
  const base: EnvSpec = {
    id: 'x', category: 'data-plane', title: 'x', severity: 'optional',
    required: ['X_URL'], warnOnMiss: true, remediation: 'set X_URL',
    forbidValues: { X_MODE: ['off'] }, forbidRemediation: 'do not set X_MODE=off',
  };
  afterEach(() => { delete process.env.X_URL; delete process.env.X_MODE; });

  it('only trips once the required vars are satisfied', () => {
    // Required missing -> the missing check dominates (not the forbid warn).
    process.env.X_MODE = 'off';
    expect(evalEnv(base).detail).toContain('Missing');
  });

  it('warns with the security remediation when the forbidden value is set', () => {
    process.env.X_URL = 'https://x';
    process.env.X_MODE = 'off';
    const r = evalEnv(base);
    expect(r.status).toBe('warn');
    expect(r.remediation).toBe('do not set X_MODE=off');
  });

  it('passes cleanly when the forbidden value is absent', () => {
    process.env.X_URL = 'https://x';
    process.env.X_MODE = 'on';
    expect(evalEnv(base).status).toBe('pass');
  });
});

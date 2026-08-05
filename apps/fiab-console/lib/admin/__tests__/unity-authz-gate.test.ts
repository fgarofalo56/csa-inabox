/**
 * `svc-loom-unity-authz` — the gate that was satisfied by its own failure mode.
 *
 * WHAT WAS WRONG (both directions, measured 2026-08-04)
 * ----------------------------------------------------
 * The spec's anyOf group accepted `LOOM_UNITY_AUTH_MODE`, and `has()` in
 * env-checks/core.ts is PRESENCE-only. `.github/workflows/gov-uc-purview-wire.yml`
 * sets `LOOM_UNITY_AUTH_MODE=anonymous` — the value that makes the Console send
 * NO credential — next to a catalog deployed with `authMode=disabled` (issue
 * #2643, anonymous read+mutate). So on Gov the "catalog authorization" gate read
 * CONFIGURED **because** the catalog was anonymous.
 *
 * Meanwhile on Commercial, where `admin-plane/main.bicep` never deploys
 * loom-unity at all (compute/loom-unity-app.bicep is orphan-allowlisted; the
 * Databricks Unity Catalog path is used instead), the same gate reported
 * "Blocked, 1 missing" for a component that does not exist and exposes nothing.
 *
 * These tests pin BOTH halves of the fix, and are written so that reverting
 * either mechanism fails them:
 *   - `rejectValues` — an off-switch value must never satisfy the gate.
 *   - `appliesWhenPresent` — absent component ⇒ pass; PRESENT component ⇒ the
 *     full check applies again (this is the assertion that stops the mechanism
 *     from becoming an escape hatch).
 * Plus: the live probe must stay wired into GATE_PROBE_MAP, because env presence
 * alone can never prove a deployed catalog rejects anonymous callers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ENV_CHECKS, evalEnv, type EnvSpec } from '../env-checks';
import { GATE_PROBE_MAP } from '../readiness';

const VARS = [
  'LOOM_UNITY_URL',
  'LOOM_UNITY_AUTH_MODE',
  'LOOM_UNITY_CLIENT_ID',
  'LOOM_UNITY_AUDIENCE',
  'LOOM_UNITY_TOKEN',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function spec(): EnvSpec {
  const s = (ENV_CHECKS as EnvSpec[]).find((x) => x.id === 'svc-loom-unity-authz');
  if (!s) throw new Error('svc-loom-unity-authz missing from ENV_CHECKS');
  return s;
}

describe('svc-loom-unity-authz — an anonymous catalog must never satisfy the authorization gate', () => {
  // THE REGRESSION. Before rejectValues these four all returned status 'pass'.
  for (const offSwitch of ['anonymous', 'disabled', 'none', 'off']) {
    it(`LOOM_UNITY_AUTH_MODE=${offSwitch} does NOT satisfy the gate on a deployed catalog`, () => {
      process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example:8080';
      process.env.LOOM_UNITY_AUTH_MODE = offSwitch;
      const r = evalEnv(spec());
      expect(r.status).not.toBe('pass');
      expect(r.detail).toMatch(/Missing/);
    });
  }

  it('is case- and whitespace-insensitive (ANONYMOUS / " anonymous " are the same value)', () => {
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example:8080';
    for (const v of ['ANONYMOUS', ' Anonymous ', 'DiSaBlEd']) {
      process.env.LOOM_UNITY_AUTH_MODE = v;
      expect(evalEnv(spec()).status, `value ${JSON.stringify(v)}`).not.toBe('pass');
    }
  });

  it('a real authorization mode DOES satisfy it', () => {
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example:8080';
    process.env.LOOM_UNITY_AUTH_MODE = 'entra';
    expect(evalEnv(spec()).status).toBe('pass');
  });

  it('does NOT accept LOOM_UNITY_TOKEN — a bearer must stay a Key Vault secretref', () => {
    // EDITABLE_ENV derives from ENV_CHECKS, so putting the token in this group
    // would surface a bearer on the /admin/env-config plaintext form. The repo
    // decided against that deliberately (same treatment as
    // LOOM_ICEBERG_CATALOG_TOKEN / LOOM_SHARING_BEARER), and
    // env-config.test.ts's editable-var count pins it. The remediation
    // therefore must NOT prescribe the token as the way to close this gate.
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example:8080';
    process.env.LOOM_UNITY_TOKEN = 'server-minted-token';
    expect(evalEnv(spec()).status).not.toBe('pass');
    expect(spec().anyOf?.[0]).not.toContain('LOOM_UNITY_TOKEN');
  });

  it('remediation steers to the Entra exchange path, not the dead LOOM_UNITY_TOKEN path', () => {
    // The Fix-it used to instruct operators to set LOOM_UNITY_TOKEN as the
    // mandatory Console half. No bicep module in the repo emits it and no Key
    // Vault secret backs it, and it is not even in the anyOf group — so
    // following the Fix-it exactly left the gate Blocked (a G2 violation).
    const r = spec().remediation;
    expect(r).toMatch(/uc-token-exchange|unity-control\/auth\/tokens/);
    expect(r).toMatch(/LOOM_UNITY_CLIENT_ID/);
    // and it must say plainly that the off-switch is not a fix
    expect(r).toMatch(/anonymous/i);
  });
});

describe('svc-loom-unity-authz — scoped to estates that actually deploy Loom Unity', () => {
  it('passes when LOOM_UNITY_URL is unset (no catalog ⇒ no anonymous surface)', () => {
    // Commercial: loom-unity is never stood up. Nothing to configure, nothing
    // exposed. This is the 2-point deduction that made /admin/readiness 97.
    const r = evalEnv(spec());
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/Not deployed in this estate/);
    expect(r.detail).toMatch(/LOOM_UNITY_URL/);
  });

  it('does NOT pass merely because the other vars are unset once the catalog IS deployed', () => {
    // The anti-escape-hatch assertion. If appliesWhenPresent ever suppressed the
    // check for a DEPLOYED catalog, this would go green and #2643 would be
    // invisible again.
    process.env.LOOM_UNITY_URL = 'https://loom-unity.internal.example:8080';
    const r = evalEnv(spec());
    expect(r.status).not.toBe('pass');
    expect(r.detail).toMatch(/Missing/);
  });

  it('is not silently converted into an opt-in / auto-resolving gate', () => {
    // The three fields that would make readiness.ts report 'ready' or 'opt-in'
    // WITHOUT evaluating anything. None may be set on a security gate.
    const s = spec();
    expect(s.optIn).toBeUndefined();
    expect(s.optionalDefault).toBeUndefined();
    expect(s.derived).toBeUndefined();
  });
});

describe('svc-loom-unity-authz — the live probe is the sharp verdict', () => {
  it('is wired into GATE_PROBE_MAP so a deployed catalog is judged on measured evidence', () => {
    expect(GATE_PROBE_MAP['svc-loom-unity-authz']).toBe('probe-loom-unity-authz');
  });
});

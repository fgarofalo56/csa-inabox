/**
 * A GATE THAT CANNOT FAIL MEASURES NOTHING — `rejectUnreachableUrls`.
 *
 * ## The measured defect
 *
 * `svc-iceberg-catalog` requires `LOOM_ICEBERG_CATALOG_URL`. The live Commercial
 * Console carried the value `https://0.0.0.0:3000/api/catalog/iceberg` — a
 * bind-all listen address that also points circularly back at Loom's own BFF
 * proxy. `lib/azure/iceberg-catalog-client.ts` correctly rejects that shape, so
 * every federation request returned the honest 503 not-configured gate... while
 * `/admin/readiness` scored the very same estate **Ready**, because the env-check
 * asked only whether the string was non-empty.
 *
 * The health surface and the runtime disagreed about one variable, and the
 * disagreement is precisely why "federated lake access is broken" could sit
 * behind a 98/100 readiness score.
 *
 * `rejectValues` could not express this: the defect is a SHAPE (any unspecified
 * host), not a fixed literal. The fix routes the listed vars through the SAME
 * predicate the runtime clients use, so the two can no longer diverge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evalEnv } from '@/lib/admin/env-checks/core';
import type { EnvSpec } from '@/lib/admin/env-checks/core';
import { isUnreachableServiceUrl } from '@/lib/azure/unreachable-url';

const SPEC: EnvSpec = {
  id: 'test-spec', category: 'data-plane', title: 'Test', severity: 'recommended',
  required: ['FEDLAKE_SPEC_PROBE_URL'], warnOnMiss: true,
  rejectUnreachableUrls: ['FEDLAKE_SPEC_PROBE_URL'],
  remediation: 'set it',
};

const saved = process.env.FEDLAKE_SPEC_PROBE_URL;
beforeEach(() => { delete process.env.FEDLAKE_SPEC_PROBE_URL; });
afterEach(() => {
  if (saved === undefined) delete process.env.FEDLAKE_SPEC_PROBE_URL;
  else process.env.FEDLAKE_SPEC_PROBE_URL = saved;
});

describe('isUnreachableServiceUrl — the shared predicate', () => {
  it('rejects the exact value observed live on the Commercial Console', () => {
    expect(isUnreachableServiceUrl('https://0.0.0.0:3000/api/catalog/iceberg')).toBe(true);
  });

  it('rejects every unspecified / bind-all address form', () => {
    expect(isUnreachableServiceUrl('https://0.0.0.0')).toBe(true);
    expect(isUnreachableServiceUrl('https://[::]:8080')).toBe(true);
    expect(isUnreachableServiceUrl('http://0:0:0:0:0:0:0:0/x')).toBe(true);
  });

  it('rejects unparseable values and empties', () => {
    expect(isUnreachableServiceUrl('')).toBe(true);
    expect(isUnreachableServiceUrl('   ')).toBe(true);
    expect(isUnreachableServiceUrl('iceberg-catalog.internal')).toBe(true); // bare host, no scheme
    expect(isUnreachableServiceUrl('${LOOM_ICEBERG_CATALOG_URL}')).toBe(true); // unexpanded
  });

  it('ACCEPTS real endpoints — including loopback sidecars and non-http schemes', () => {
    expect(isUnreachableServiceUrl('https://iceberg-catalog.internal.abc.centralus.azurecontainerapps.io')).toBe(false);
    // A sidecar on the same Container App is a legitimate, reachable target.
    expect(isUnreachableServiceUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isUnreachableServiceUrl('http://localhost:8080')).toBe(false);
    // LOOM_FLIGHTSQL_URL is grpc://<fqdn>:8815 — must not be rejected as a shape.
    expect(isUnreachableServiceUrl('grpc://loom-duckdb.internal.example.io:8815')).toBe(false);
  });

  it('applies a caller-supplied self-proxy pattern (the iceberg circular case)', () => {
    const selfProxy = /\/api\/catalog\/iceberg(\/|$)/;
    expect(isUnreachableServiceUrl('https://real-host.example.io/api/catalog/iceberg', selfProxy)).toBe(true);
    expect(isUnreachableServiceUrl('https://real-host.example.io/api/2.1/unity-catalog/iceberg', selfProxy)).toBe(false);
  });
});

describe('evalEnv — a placeholder no longer reads as configured', () => {
  it('FAILS on the bind-all placeholder instead of passing', () => {
    process.env.FEDLAKE_SPEC_PROBE_URL = 'https://0.0.0.0:3000/api/catalog/iceberg';
    const r = evalEnv(SPEC);
    expect(r.status).not.toBe('pass');
    // And it must say WHY, so an operator is not sent to configure a var that
    // is already (wrongly) configured.
    expect(r.detail).toContain('is SET but is not a reachable endpoint');
  });

  it('passes on a real endpoint', () => {
    process.env.FEDLAKE_SPEC_PROBE_URL = 'https://iceberg-catalog.internal.example.io';
    expect(evalEnv(SPEC).status).toBe('pass');
  });

  it('still reports plain-missing as missing, without the unusable wording', () => {
    const r = evalEnv(SPEC);
    expect(r.status).not.toBe('pass');
    expect(r.detail).toContain('Missing: FEDLAKE_SPEC_PROBE_URL');
    expect(r.detail).not.toContain('is SET but is not a reachable endpoint');
  });

  it('leaves specs that do NOT opt in unchanged (no blanket behaviour change)', () => {
    const plain: EnvSpec = { ...SPEC, rejectUnreachableUrls: undefined };
    process.env.FEDLAKE_SPEC_PROBE_URL = 'https://0.0.0.0:3000/api/catalog/iceberg';
    expect(evalEnv(plain).status).toBe('pass');
  });
});

describe('the federated-lake specs actually opt in', () => {
  it('svc-iceberg-catalog rejects placeholders AND is no longer optionalDefault', async () => {
    const { DATA_PLANE_ENV_CHECKS } = await import('@/lib/admin/env-checks/data-plane');
    const spec = DATA_PLANE_ENV_CHECKS.find((s) => s.id === 'svc-iceberg-catalog');
    expect(spec).toBeDefined();
    expect(spec!.rejectUnreachableUrls).toEqual(['LOOM_ICEBERG_CATALOG_URL']);
    // optionalDefault forces `pass` no matter what — with the catalog now
    // deployed by the orchestrator, an unset var means the deploy did not
    // happen, which readiness must be able to say.
    expect(spec!.optionalDefault).toBeFalsy();
  });

  it('svc-loom-trino-authz observes the AUTH POSTURE, not just the URL (#2678 §3)', async () => {
    const { DATA_PLANE_ENV_CHECKS } = await import('@/lib/admin/env-checks/data-plane');
    const spec = DATA_PLANE_ENV_CHECKS.find((s) => s.id === 'svc-loom-trino-authz');
    expect(spec).toBeDefined();
    // The exact hole #2678 named: a deploy with trinoAuthMode='disabled' — an
    // engine any in-VNet workload can query as any user — used to report GREEN
    // because LOOM_TRINO_AUTH_MODE appeared only in prose.
    expect(spec!.required).toContain('LOOM_TRINO_AUTH_MODE');
    for (const bad of ['disabled', 'none', 'off', 'anonymous']) {
      expect(spec!.rejectValues?.LOOM_TRINO_AUTH_MODE).toContain(bad);
    }
    // 'sealed' is enforced-but-unmintable, the correct from-scratch state.
    expect(spec!.rejectValues?.LOOM_TRINO_AUTH_MODE).not.toContain('sealed');
    // It must go quiet where the engine is not deployed, not red.
    expect(spec!.appliesWhenPresent?.envVar).toBe('LOOM_TRINO_URL');
  });

  it('svc-loom-trino itself is no longer the opt-in carve-out', async () => {
    const { DATA_PLANE_ENV_CHECKS } = await import('@/lib/admin/env-checks/data-plane');
    const spec = DATA_PLANE_ENV_CHECKS.find((s) => s.id === 'svc-loom-trino')!;
    expect(spec.optIn).toBeFalsy();
    expect(spec.rejectUnreachableUrls).toEqual(['LOOM_TRINO_URL']);
    // CRITICAL: the auth var must NOT be in THIS spec's required list.
    // /api/sql/trino hard-gates on it (backendGateResponse), so adding the var
    // here would 503 the engine on every estate that has not redeployed —
    // turning a health observation into an outage. Measured: doing exactly that
    // took 5 route tests from green to 503.
    expect(spec.required).toEqual(['LOOM_TRINO_URL']);
  });

  it('the anonymous Trino posture is reported as a defect end to end', async () => {
    const { DATA_PLANE_ENV_CHECKS } = await import('@/lib/admin/env-checks/data-plane');
    const spec = DATA_PLANE_ENV_CHECKS.find((s) => s.id === 'svc-loom-trino-authz')!;
    const savedUrl = process.env.LOOM_TRINO_URL;
    const savedMode = process.env.LOOM_TRINO_AUTH_MODE;
    try {
      // Engine not deployed → not-applicable, never a false red.
      delete process.env.LOOM_TRINO_URL;
      delete process.env.LOOM_TRINO_AUTH_MODE;
      expect(evalEnv(spec).status).toBe('pass');

      process.env.LOOM_TRINO_URL = 'https://loom-trino.internal.example.io';
      process.env.LOOM_TRINO_AUTH_MODE = 'entra';
      expect(evalEnv(spec).status).toBe('pass');
      process.env.LOOM_TRINO_AUTH_MODE = 'sealed';
      expect(evalEnv(spec).status).toBe('pass');
      // The failure mode the gate exists to catch.
      process.env.LOOM_TRINO_AUTH_MODE = 'disabled';
      expect(evalEnv(spec).status).not.toBe('pass');
      // ...and a revision that predates the authorization work.
      delete process.env.LOOM_TRINO_AUTH_MODE;
      expect(evalEnv(spec).status).not.toBe('pass');
    } finally {
      if (savedUrl === undefined) delete process.env.LOOM_TRINO_URL; else process.env.LOOM_TRINO_URL = savedUrl;
      if (savedMode === undefined) delete process.env.LOOM_TRINO_AUTH_MODE; else process.env.LOOM_TRINO_AUTH_MODE = savedMode;
    }
  });
});

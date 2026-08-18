/**
 * GET /api/items/user-data-function/endpoints — the editor's endpoint picker
 * must be fed by the SAME policy the invoke route enforces.
 *
 * WHY THIS SUITE EXISTS
 *   The editor asked the user to hand-type `state.azureFunctionUrl` and
 *   `state.functionKeySecret`. Since `lib/azure/udf-endpoint-policy.ts` made
 *   both operator configuration — item state may only SELECT an approved
 *   endpoint and AGREE with its key — the only values a user could type were
 *   one they already knew or one guaranteed to 409. This route replaces the
 *   ask with a selection, so what it returns has to BE the approved set, not a
 *   second list that resembles it.
 *
 * Hermetic: only the session is mocked. The endpoint policy runs for real
 * against env, so every assertion is on the actual approved configuration.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const sessionMock = vi.fn(() => ({ claims: { oid: 'o1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionMock() }));

import { GET } from '../route';
import { configuredUdfEndpoints, udfKeySecretDisagrees, resolveUdfEndpoint } from '@/lib/azure/udf-endpoint-policy';

const RUNTIME = 'https://loom-udf-runtime.internal.example.io';
const APPROVED_FN = 'https://contoso-udf.azurewebsites.net';

function call() {
  return GET({} as any, { params: Promise.resolve({}) } as any);
}

const ENV_KEYS = [
  'LOOM_UDF_FUNCTION_BASE',
  'LOOM_UDF_FUNCTION_KEY_SECRET',
  'LOOM_UDF_ALLOWED_FUNCTION_BASES',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  sessionMock.mockReturnValue({ claims: { oid: 'o1', tid: 't1', groups: [] }, exp: Date.now() / 1000 + 3600 });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
});

describe('GET /api/items/user-data-function/endpoints', () => {
  it('401s without a session — the approved-endpoint list is not public', async () => {
    sessionMock.mockReturnValue(null as any);
    const res = await call();
    expect(res.status).toBe(401);
  });

  it('returns the deployment default FIRST and marks it isDefault', async () => {
    process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
    process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES = `${APPROVED_FN}=udf-fnapp-key`;
    const j = await (await call()).json();
    expect(j.ok).toBe(true);
    expect(j.endpoints.map((e: any) => e.base)).toEqual([RUNTIME, APPROVED_FN]);
    expect(j.endpoints[0].isDefault).toBe(true);
    expect(j.endpoints[1].isDefault).toBe(false);
  });

  it('is the SAME set the invoke path resolves against — not a look-alike list', async () => {
    process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
    process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES = `${APPROVED_FN}=udf-fnapp-key`;
    const j = await (await call()).json();
    const policy = configuredUdfEndpoints();
    expect(j.endpoints.map((e: any) => ({
      base: e.base, keySecretName: e.keySecretName, acceptsPushedSource: e.acceptsPushedSource,
    }))).toEqual(policy.map((e) => ({
      base: e.base, keySecretName: e.keySecretName, acceptsPushedSource: e.acceptsPushedSource,
    })));
  });

  it('carries the key-secret NAME so the editor can write an agreeing value — and no key material', async () => {
    process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
    process.env.LOOM_UDF_ALLOWED_FUNCTION_BASES = `${APPROVED_FN}=udf-fnapp-key`;
    const res = await call();
    const body = await res.text();
    const j = JSON.parse(body);
    expect(j.endpoints[1].keySecretName).toBe('udf-fnapp-key');
    // A NAME, never a value: nothing in the payload is a secret, and the
    // keyed endpoint is the one that must not receive pushed source.
    expect(j.endpoints[1].acceptsPushedSource).toBe(false);
    expect(j.endpoints[0].keySecretName).toBeUndefined();
    expect(j.endpoints[0].acceptsPushedSource).toBe(true);
  });

  it('an unconfigured deployment gets the honest gate, not an empty picker', async () => {
    const j = await (await call()).json();
    expect(j.ok).toBe(true);
    expect(j.endpoints).toEqual([]);
    expect(j.gate.missing).toBe('LOOM_UDF_FUNCTION_BASE');
    expect(j.gate.detail).toMatch(/LOOM_UDF_FUNCTION_BASE|udf-runtime\.bicep/);
  });

  it('omits the gate when endpoints exist — a gate that always shows is not a gate', async () => {
    process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
    const j = await (await call()).json();
    expect(j.endpoints).toHaveLength(1);
    expect(j.gate).toBeUndefined();
  });
});

/**
 * `udfKeySecretDisagrees` is the policy's key comparison, extracted so the
 * editor cannot answer the question with a second implementation.
 *
 * That is not hypothetical tidiness: the editor DID hand-roll it, dropped the
 * empty-request clause, and warned "Run returns 409" on every keyed endpoint
 * whose item named no key — a refusal `resolveUdfEndpoint` does not issue. The
 * first case below is the one that was wrong, and it is asserted against BOTH
 * the predicate and the resolver so the two can never disagree again.
 */
describe('udfKeySecretDisagrees — an EMPTY asked key is not a disagreement', () => {
  it('an item naming NO key never disagrees, keyed endpoint or not', () => {
    expect(udfKeySecretDisagrees('', 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees('   ', 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees(undefined, 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees(null, 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees('', undefined)).toBe(false);
  });

  it('a NAMED key disagrees only when it differs, case-insensitively', () => {
    expect(udfKeySecretDisagrees('udf-fnapp-key', 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees('UDF-FNAPP-KEY', 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees(' udf-fnapp-key ', 'udf-fnapp-key')).toBe(false);
    expect(udfKeySecretDisagrees('some-other-secret', 'udf-fnapp-key')).toBe(true);
    // Named a key against an endpoint configured with none — still a refusal.
    expect(udfKeySecretDisagrees('some-other-secret', undefined)).toBe(true);
  });

  it('THE RESOLVER AGREES: a keyed default + an item naming no key returns an endpoint, no gate', () => {
    process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
    process.env.LOOM_UDF_FUNCTION_KEY_SECRET = 'udf-fnapp-key';
    const resolved = resolveUdfEndpoint('', '');
    expect('gate' in resolved).toBe(false);
    expect('endpoint' in resolved && resolved.endpoint.keySecretName).toBe('udf-fnapp-key');
  });

  it('THE RESOLVER AGREES: a DISAGREEING named key does gate', () => {
    process.env.LOOM_UDF_FUNCTION_BASE = RUNTIME;
    process.env.LOOM_UDF_FUNCTION_KEY_SECRET = 'udf-fnapp-key';
    const resolved = resolveUdfEndpoint('', 'some-other-secret');
    expect('gate' in resolved).toBe(true);
    expect('gate' in resolved && resolved.gate.missing).toBe('LOOM_UDF_FUNCTION_KEY_SECRET');
  });
});

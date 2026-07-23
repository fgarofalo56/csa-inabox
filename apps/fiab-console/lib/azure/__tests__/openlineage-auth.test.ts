/**
 * L2 — OpenLineage ingest verifier: auth acceptance + rejection paths
 * (rev-2 SRE-F2 security redesign).
 *
 * Entra mode is exercised with a REAL RS256 keypair: the test signs JWTs with
 * a locally generated RSA key and injects its JWK via the test hook (no
 * network), so the signature / issuer / audience / expiry / registration
 * checks all run the production code path. Workspace-token mode covers the
 * per-workspace token binding + constant-time fail-closed behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { verifyOpenLineageAuth, __setOpenLineageJwksForTest } from '../openlineage-auth';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const POOL_APP_ID = '99999999-8888-7777-6666-555555555555';
const WS_ID = 'ws-sales';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: strangerPub, privateKey: strangerKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
void strangerPub;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(payload: Record<string, unknown>, opts: { kid?: string; key?: crypto.KeyObject; alg?: string } = {}): string {
  const header = { alg: opts.alg || 'RS256', typ: 'JWT', kid: opts.kid ?? 'test-kid' };
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), opts.key || privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

function basePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://sts.windows.net/${TENANT}/`,
    aud: `api://${CLIENT_ID}`,
    appid: POOL_APP_ID,
    exp: now + 3600,
    nbf: now - 60,
    ...over,
  };
}

const SAVED = ['LOOM_OPENLINEAGE_AUTH_MODE', 'LOOM_ENTRA_TENANT_ID',
  'LOOM_OPENLINEAGE_POOL_PRINCIPALS', 'LOOM_OPENLINEAGE_WORKSPACE_TOKEN', 'AZURE_CLOUD',
  'LOOM_MSAL_TENANT_ID', 'LOOM_MSAL_CLIENT_ID', 'AZURE_TENANT_ID', 'LOOM_OPENLINEAGE_AUDIENCE'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  for (const k of SAVED) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  process.env.LOOM_OPENLINEAGE_POOL_PRINCIPALS = `${POOL_APP_ID}=${WS_ID}`;
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  __setOpenLineageJwksForTest([{ ...jwk, kid: 'test-kid' } as never]);
});

afterEach(() => {
  __setOpenLineageJwksForTest(null);
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('entra mode (default)', () => {
  it('accepts a valid pinned-tenant bearer and returns the registered workspace', async () => {
    const r = await verifyOpenLineageAuth(`Bearer ${signJwt(basePayload())}`);
    expect(r).toEqual({ ok: true, workspaceId: WS_ID, principal: POOL_APP_ID.toLowerCase(), mode: 'entra' });
  });

  it('401s a missing bearer', async () => {
    const r = await verifyOpenLineageAuth(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('401s an EXPIRED token (acceptance a)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await verifyOpenLineageAuth(`Bearer ${signJwt(basePayload({ exp: now - 3600 }))}`);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.error).toMatch(/expired/); }
  });

  it('401s a FOREIGN-TENANT issuer (acceptance a)', async () => {
    const r = await verifyOpenLineageAuth(
      `Bearer ${signJwt(basePayload({ iss: 'https://sts.windows.net/deadbeef-0000-0000-0000-000000000000/' }))}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.error).toMatch(/issuer/); }
  });

  it('401s an audience mismatch', async () => {
    const r = await verifyOpenLineageAuth(`Bearer ${signJwt(basePayload({ aud: 'api://someone-else' }))}`);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.error).toMatch(/audience/); }
  });

  it('401s a token signed by the wrong key (forged signature)', async () => {
    const r = await verifyOpenLineageAuth(`Bearer ${signJwt(basePayload(), { key: strangerKey })}`);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.error).toMatch(/signature/); }
  });

  it('401s an unknown signing key (kid not in JWKS)', async () => {
    const r = await verifyOpenLineageAuth(`Bearer ${signJwt(basePayload(), { kid: 'nope' })}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('403s a VALID token whose principal has no workspace registration (per-pool binding)', async () => {
    const r = await verifyOpenLineageAuth(
      `Bearer ${signJwt(basePayload({ appid: '00000000-1111-2222-3333-444444444444' }))}`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.error).toMatch(/not registered/); }
  });

  it('503s (fail-closed, honest gate) when the verifier tenant is not pinned', async () => {
    delete process.env.LOOM_ENTRA_TENANT_ID;
    const r = await verifyOpenLineageAuth(`Bearer ${signJwt(basePayload())}`);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(503); expect(r.error).toMatch(/LOOM_ENTRA_TENANT_ID|AZURE_TENANT_ID/); }
  });
});

describe('workspace-token mode', () => {
  beforeEach(() => {
    process.env.LOOM_OPENLINEAGE_AUTH_MODE = 'workspace-token';
    process.env.LOOM_OPENLINEAGE_WORKSPACE_TOKEN = `${WS_ID}=tok-sales-1,ws-hr=tok-hr-9`;
  });

  it('accepts a minted token and binds it to exactly ONE workspace', async () => {
    const r = await verifyOpenLineageAuth('Bearer tok-hr-9');
    expect(r).toEqual({ ok: true, workspaceId: 'ws-hr', principal: 'workspace-token:ws-hr', mode: 'workspace-token' });
  });

  it('401s a wrong token', async () => {
    const r = await verifyOpenLineageAuth('Bearer not-a-token');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('503s (fail-closed) when no per-workspace token is minted', async () => {
    delete process.env.LOOM_OPENLINEAGE_WORKSPACE_TOKEN;
    const r = await verifyOpenLineageAuth('Bearer tok-sales-1');
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(503); expect(r.error).toMatch(/openlineage-pool-setup\.sh/); }
  });
});

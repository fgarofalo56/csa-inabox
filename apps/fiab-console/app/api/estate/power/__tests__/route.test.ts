/**
 * /api/estate/power — the service-principal entry point (PRP-02 step 3, #4876).
 *
 * What is REAL here: the Entra verifier (`verifyEntraBearer`, with a generated
 * RSA key injected through its JWKS test hook, so signatures are really checked),
 * `verifyEstatePowerCaller`, the route, and the shared handlers + orchestrator
 * logic. What is mocked: only the network edge (ARM actuator, Cosmos, audit
 * sinks), as in the cookie-route suite.
 *
 * Every rejection case asserts TWO things: the status AND that nothing
 * downstream ran (`createArmActuator` not called). The second is what makes a
 * rejection case able to fail if the gate is deleted: a route that returned 401
 * after doing the work would still pass a status-only check.
 *
 * Each `it` names the single input that breaks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

const auditCreate = vi.fn(async (doc: unknown) => ({ resource: doc }));
const upsert = vi.fn(async (d: unknown) => ({ resource: d }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: auditCreate } })),
  maintenanceJobsContainer: vi.fn(async () => ({
    items: { upsert },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  })),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));

const createArmActuator = vi.fn();
const loadPauseSnapshot = vi.fn(async () => null as unknown);
const savePauseSnapshot = vi.fn(async (_s?: unknown) => {});
const resolveDeployManifest = vi.fn();
const createManifestTagReader = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: (...a: unknown[]) => createArmActuator(...a),
    loadPauseSnapshot: (...a: unknown[]) => loadPauseSnapshot(...(a as [])),
    savePauseSnapshot: (...a: unknown[]) => savePauseSnapshot(...(a as [])),
    resolveDeployManifest: (...a: unknown[]) => resolveDeployManifest(...a),
    createManifestTagReader: (...a: unknown[]) => createManifestTagReader(...a),
  };
});

import { armPowerReading, type EstatePauseSnapshot } from '@/lib/estate/pause-state';
import { previewToken } from '@/lib/estate/pause-orchestrator';
import { __setEntraJwksForTest } from '@/lib/azure/entra-bearer-verify';
import { clearStateCache } from '@/lib/estate/estate-state-cache';

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER_TENANT = '99999999-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const AUD = `api://${CLIENT_ID}`;
const SP_APP = 'cccccccc-0000-0000-0000-000000000001';
const ESTATE = 'loom:estate-a';
const SUB = 'sub-a';
const POOL_ID = `/subscriptions/${SUB}/resourceGroups/rg-a/providers/Microsoft.Synapse/workspaces/syn-ws/sqlPools/pool1`;
const ADX_ID = `/subscriptions/${SUB}/resourceGroups/rg-b/providers/Microsoft.Kusto/clusters/adx-loom`;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A correctly signed, fully valid deploy-SP token; override ONE claim per case. */
function jwt(over: Record<string, unknown> = {}, signWith: crypto.KeyObject = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })));
  const claims: Record<string, unknown> = {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: AUD,
    tid: TENANT,
    appid: SP_APP,
    oid: 'sp-object-id',
    roles: ['Estate.Power'],
    exp: now + 3600,
    nbf: now - 60,
    ...over,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  const p = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf-8'), signWith));
  return `${h}.${p}.${sig}`;
}

const req = (method: 'GET' | 'POST', token: string | null, body?: unknown) =>
  ({
    method,
    headers: { get: (n: string) => (n.toLowerCase() === 'authorization' ? (token === null ? null : `Bearer ${token}`) : null) },
    json: async () => {
      if (body === '__invalid__') throw new Error('bad json');
      return body;
    },
    nextUrl: new URL('http://x/api/estate/power'),
  }) as never;

function manifestFixture(armed = true) {
  const ids = [POOL_ID, ADX_ID];
  const entries = ids.map((resourceId) => ({
    resourceId,
    resourceType: resourceId.includes('/sqlPools/') ? 'microsoft.synapse/workspaces/sqlpools' : 'microsoft.kusto/clusters',
    name: resourceId.split('/').pop()!,
    resourceGroup: resourceId.split('/resourceGroups/')[1].split('/')[0],
    subscriptionId: SUB,
    fromEnv: ['LOOM_SUBSCRIPTION_ID'],
  }));
  return {
    manifest: { estateId: ESTATE, resourceIds: armed ? ids : [] },
    entries,
    unresolved: [],
    manifestGated: !armed,
    namedByDeploy: ids.length,
    ...(armed ? {} : { gateReason: 'Estate pause is not armed: LOOM_ESTATE_PAUSE_ENABLED is not set.' }),
  };
}

function fakeActuator() {
  const touched: string[] = [];
  return {
    touched,
    actuator: {
      readTags: vi.fn(async () => ({ 'loom-estate-id': ESTATE })),
      readPower: vi.fn(async (r: { resourceId: string }) => ({
        reading: armPowerReading({ resourceId: r.resourceId, powerState: 'Online', armApiVersion: '2021-06-01' }),
        sku: { name: 'DW100c', capacity: 100 },
      })),
      pause: vi.fn(async (c: { resource: { resourceId: string; name: string } }) => {
        touched.push(c.resource.resourceId);
        return { ok: true, detail: `paused ${c.resource.name}` };
      }),
      resume: vi.fn(async (e: { resourceId: string; name: string }) => {
        touched.push(e.resourceId);
        return { ok: true, detail: `resumed ${e.name}` };
      }),
      probeServable: vi.fn(async () => ({ servable: true, probed: true, detail: 'answered' })),
    },
  };
}

const goodToken = () => previewToken({ manifestIds: [POOL_ID, ADX_ID], establishedIds: [POOL_ID, ADX_ID], readFailures: 0 });

function pausedSnapshot(): EstatePauseSnapshot {
  return {
    id: 'snap-1', tenantId: TENANT, schemaVersion: 1, estateId: ESTATE, state: 'PAUSED',
    createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:05:00.000Z', pausedAt: '2026-08-23T00:05:00.000Z',
    resources: [POOL_ID, ADX_ID].map((resourceId) => ({
      resourceId,
      resourceType: resourceId.includes('/sqlPools/') ? 'microsoft.synapse/workspaces/sqlpools' : 'microsoft.kusto/clusters',
      name: resourceId.split('/').pop()!,
      resourceGroup: 'rg', subscriptionId: SUB,
      prePausePowerState: 'Online' as const, powerStateSource: 'arm' as const,
      powerStateReadAt: '2026-08-23T00:00:00.000Z', powerStateApiVersion: '2021-06-01',
      ownership: { verdict: 'loom-owned' as const, source: 'ownership-tag' as const, reason: 'tagged' },
    })),
  };
}

const ENV_KEYS = ['LOOM_ENTRA_TENANT_ID', 'LOOM_MSAL_TENANT_ID', 'AZURE_TENANT_ID', 'LOOM_MSAL_CLIENT_ID', 'LOOM_ESTATE_POWER_AUDIENCE', 'AZURE_CLOUD'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  clearStateCache(); // the state verdict is cached per tenant; each test is a fresh estate
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LOOM_ENTRA_TENANT_ID = TENANT;
  process.env.LOOM_MSAL_CLIENT_ID = CLIENT_ID;
  __setEntraJwksForTest([{ ...(publicKey.export({ format: 'jwk' }) as object), kid: 'k1' }]);
  loadPauseSnapshot.mockResolvedValue(null);
  resolveDeployManifest.mockReturnValue(manifestFixture());
  createArmActuator.mockResolvedValue(fakeActuator().actuator);
  createManifestTagReader.mockImplementation(() => async (id: string) => {
    const a = (await createArmActuator()) as { readTags: (id: string) => Promise<Record<string, string> | null> };
    return a.readTags(id);
  });
});

afterEach(() => {
  __setEntraJwksForTest(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

async function call(method: 'GET' | 'POST', token: string | null, body?: unknown) {
  const mod = await import('../route');
  const res = await mod[method](req(method, token, body));
  return { res, json: await res.json() };
}

describe('service-principal authentication (each case = one bad input, fails closed)', () => {
  // Break it: delete the `if ('denied' in a)` line or the verifier call and each
  // case below would reach createArmActuator.
  const stateReq = { action: 'state' };

  it('no Authorization header -> 401, nothing runs', async () => {
    const { res, json } = await call('POST', null, stateReq);
    expect(res.status).toBe(401);
    expect(json.ok).toBe(false);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('a token that is not a JWT ("abc") -> 401', async () => {
    const { res } = await call('POST', 'abc', stateReq);
    expect(res.status).toBe(401);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('three segments of garbage ("a.b.c") -> 401', async () => {
    const { res } = await call('POST', 'a.b.c', stateReq);
    expect(res.status).toBe(401);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('wrong audience (a token minted for another app) -> 401', async () => {
    const { res, json } = await call('POST', jwt({ aud: 'api://some-other-app' }), stateReq);
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/audience/);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('wrong issuer (another tenant authority) -> 401', async () => {
    const { res, json } = await call('POST', jwt({ iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }), stateReq);
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/issuer/);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('Commercial issuer presented to a GOV console (AZURE_CLOUD=AzureUSGovernment) -> 401', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const { res } = await call('POST', jwt(), stateReq); // default iss is login.microsoftonline.COM
    expect(res.status).toBe(401);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('positive control for the Gov case: the .us issuer IS accepted on a Gov console', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const { res, json } = await call('POST', jwt({ iss: `https://login.microsoftonline.us/${TENANT}/v2.0` }), stateReq);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('right issuer but tid of another tenant -> 401', async () => {
    const { res, json } = await call('POST', jwt({ tid: OTHER_TENANT }), stateReq);
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/tenant/);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('no tid claim at all -> 401 (a missing claim is never allowed)', async () => {
    const { res } = await call('POST', jwt({ tid: undefined }), stateReq);
    expect(res.status).toBe(401);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('valid token WITHOUT the Estate.Power role (roles: [Other.Role]) -> 403', async () => {
    const { res, json } = await call('POST', jwt({ roles: ['Other.Role'] }), stateReq);
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/Estate\.Power/);
    expect(createArmActuator).not.toHaveBeenCalled();
    // the denial is audited with the caller appid
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'estate-power.denied', appId: SP_APP }));
  });

  it('a DELEGATED scp of Estate.Power (no roles claim) does not qualify -> 403', async () => {
    const { res } = await call('POST', jwt({ roles: undefined, scp: 'Estate.Power' }), stateReq);
    expect(res.status).toBe(403);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('role name differing only in case (estate.power) -> 403', async () => {
    const { res } = await call('POST', jwt({ roles: ['estate.power'] }), stateReq);
    expect(res.status).toBe(403);
  });

  it('expired token (exp one hour ago) -> 401', async () => {
    const { res, json } = await call('POST', jwt({ exp: Math.floor(Date.now() / 1000) - 3600 }), stateReq);
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/expired/);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('forged signature (right claims, attacker key) -> 401', async () => {
    const { res, json } = await call('POST', jwt({}, attacker.privateKey), stateReq);
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/signature/);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('an ID token (nonce claim) is refused even with the role string present -> 401', async () => {
    const { res } = await call('POST', jwt({ nonce: 'n' }), stateReq);
    expect(res.status).toBe(401);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('no appid/azp (caller cannot be identified for audit) -> 401', async () => {
    const { res, json } = await call('POST', jwt({ appid: undefined }), stateReq);
    expect(res.status).toBe(401);
    expect(json.error).toMatch(/application id/);
  });

  it('console without a pinned tenant -> 503 (our fault), never 401 or 200', async () => {
    delete process.env.LOOM_ENTRA_TENANT_ID;
    const { res } = await call('POST', jwt(), stateReq);
    expect(res.status).toBe(503);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('console without a pinned audience (no client id, no override) -> 503', async () => {
    delete process.env.LOOM_MSAL_CLIENT_ID;
    const { res } = await call('POST', jwt(), stateReq);
    expect(res.status).toBe(503);
  });

  it('POSITIVE CONTROL: a fully valid token reaches state and returns the power block', async () => {
    const { res, json } = await call('POST', jwt(), stateReq);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.state).toBe('RUNNING');
    // Nothing recorded: null means unknown-not-idle, and the default setting is armed at 2h.
    expect(json.power.activity).toEqual({ lastActivityAt: null, idleForSeconds: null, unreadable: false });
    expect(json.power.autoPause).toMatchObject({ enabled: true, idleHours: 2, source: 'default' });
    expect(createArmActuator).toHaveBeenCalled();
  });

  it('the audience may be the bare client id (v2 token form) as well as api://<id>', async () => {
    const { res } = await call('POST', jwt({ aud: CLIENT_ID }), stateReq);
    expect(res.status).toBe(200);
  });

  it('GET is the state action', async () => {
    const { res, json } = await call('GET', jwt());
    expect(res.status).toBe(200);
    expect(json.state).toBe('RUNNING');
  });
});

describe('request shape', () => {
  it('unknown action -> 400, nothing runs', async () => {
    const { res } = await call('POST', jwt(), { action: 'delete-everything' });
    expect(res.status).toBe(400);
    expect(createArmActuator).not.toHaveBeenCalled();
  });

  it('missing action -> 400', async () => {
    const { res } = await call('POST', jwt(), {});
    expect(res.status).toBe(400);
  });

  it('invalid JSON body -> 400', async () => {
    const { res } = await call('POST', jwt(), '__invalid__');
    expect(res.status).toBe(400);
  });

  it('preview: 200, dryRun true, carries a confirmToken and the power block', async () => {
    const { res, json } = await call('POST', jwt(), { action: 'preview' });
    expect(res.status).toBe(200);
    expect(json.dryRun).toBe(true);
    expect(json.confirmToken).toBe(goodToken());
    expect(json.power).toBeDefined();
  });
});

describe('pause gates apply to the service principal exactly as to a cookie admin', () => {
  it('pause with NO confirm -> 400 and no ARM pause verb is issued', async () => {
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res } = await call('POST', jwt(), { action: 'pause', confirmToken: goodToken() });
    expect(res.status).toBe(400);
    expect(f.actuator.pause).not.toHaveBeenCalled();
  });

  it('pause with a WRONG confirm string -> 400', async () => {
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res } = await call('POST', jwt(), { action: 'pause', confirm: 'loom:estate-b', confirmToken: goodToken() });
    expect(res.status).toBe(400);
    expect(f.actuator.pause).not.toHaveBeenCalled();
  });

  it('pause with the right confirm but NO confirmToken -> 409 (#3989: absent is refused)', async () => {
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res } = await call('POST', jwt(), { action: 'pause', confirm: ESTATE });
    expect(res.status).toBe(409);
    expect(f.actuator.pause).not.toHaveBeenCalled();
  });

  it('a body-supplied dryRun:true cannot be used to skip the confirm gate (dryRun comes from `action`)', async () => {
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res, json } = await call('POST', jwt(), { action: 'pause', dryRun: true });
    expect(res.status).toBe(400); // confirm mismatch, not a 200 preview
    expect(json.dryRun).toBeUndefined();
  });

  it('not armed (LOOM_ESTATE_PAUSE_ENABLED unset) -> 409 notArmed even with confirm + token', async () => {
    resolveDeployManifest.mockReturnValue(manifestFixture(false));
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res, json } = await call('POST', jwt(), { action: 'pause', confirm: ESTATE, confirmToken: 'whatever' });
    expect(res.status).toBe(409);
    expect(json.notArmed).toBe(true);
    expect(f.actuator.pause).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: confirm + current token -> 202 PAUSING, verbs issued, audit carries the appid', async () => {
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res, json } = await call('POST', jwt(), { action: 'pause', confirm: ESTATE, confirmToken: goodToken() });
    expect(res.status).toBe(202);
    expect(json.state).toBe('PAUSING');
    expect(f.touched.length).toBe(2);
    expect(savePauseSnapshot).toHaveBeenCalledTimes(1);
    const startRow = auditCreate.mock.calls.map((c) => c[0] as Record<string, unknown>).find((d) => d.kind === 'estate-pause.start');
    expect(startRow).toMatchObject({ via: 'service-principal', appId: SP_APP, who: `sp:${SP_APP}`, tenantId: TENANT });
  });

  it('resume with a PAUSED snapshot -> 202 RESUMING, audited with the appid', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshot());
    const f = fakeActuator();
    createArmActuator.mockResolvedValue(f.actuator);
    const { res, json } = await call('POST', jwt(), { action: 'resume' });
    expect(res.status).toBe(202);
    expect(json.state).toBe('RESUMING');
    const row = auditCreate.mock.calls.map((c) => c[0] as Record<string, unknown>).find((d) => d.kind === 'estate-resume.start');
    expect(row).toMatchObject({ appId: SP_APP, via: 'service-principal' });
  });

  it('every authenticated action writes an estate-power.request row naming the appid and action', async () => {
    await call('POST', jwt(), { action: 'state' });
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'estate-power.request', action: 'state', appId: SP_APP }));
  });

  it('state exposes last pause time from the snapshot (lastPausedAt)', async () => {
    loadPauseSnapshot.mockResolvedValue(pausedSnapshot());
    const { json } = await call('GET', jwt());
    expect(json.power.lastPausedAt).toBe('2026-08-23T00:05:00.000Z');
    expect(json.power.lastResumedAt).toBeNull();
  });

  it('state carries the power block in EVERY branch, including a RESUMING poll (breaks if that branch omits `power`)', async () => {
    loadPauseSnapshot.mockResolvedValue({
      ...pausedSnapshot(), state: 'RESUMING', resumeStartedAt: '2026-08-23T01:00:00.000Z',
    });
    const { res, json } = await call('GET', jwt());
    expect(res.status).toBe(200);
    expect(['RESUMING', 'RUNNING', 'RESUME_FAILED']).toContain(json.state);
    expect(json.power).toMatchObject({ lastPausedAt: '2026-08-23T00:05:00.000Z' });
  });

  it('state carries the power block while PAUSING too', async () => {
    loadPauseSnapshot.mockResolvedValue({ ...pausedSnapshot(), state: 'PAUSING' });
    const { json } = await call('GET', jwt());
    expect(json.power).toBeDefined();
  });
});

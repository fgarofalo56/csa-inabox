/**
 * ISSUE #2622, GAP 1 — the LAST un-audited Unity Catalog exit.
 *
 * `lib/azure/shortcut-credentials.ts` issues storage-credential and
 * external-location CREATE/DELETE from its own transport. Those are the
 * securables that hand a workload access to a storage account — the closest
 * thing in Unity Catalog to minting access — and until #2622 they produced no
 * Loom audit row. The audit first landed in a FACADE, `lib/azure/uc-securable.ts`,
 * because the file could not be instrumented in place; the #2622 residual
 * instrumented `securableFetch` itself, so BOTH layers record and the facade
 * remains the only permitted importer.
 *
 * ## What this spec is FOR, and why it is not redundant with the CI guard
 *
 * The guard (`scripts/ci/check-unity-audit-chokepoint.mjs`) proves the recorder
 * is CALLED from inside `ucSecurable`'s `finally`. It is a lexical scan, so it
 * cannot prove the call is REACHED, that the row is CORRECT, or that it survives
 * the trip to both sinks — `finally { if (ok) record(…) }` satisfies the guard
 * while dropping every denied call. That half is held here.
 *
 * So nothing below stubs the recorder. Only the RAW transport and the two SINKS
 * are mocked, and the assertions are made on the bytes that reached Cosmos and
 * the SIEM stream. That means a change anywhere in the chain
 *
 *     facade → ucSecurable's finally → recordUnitySecurableAccess
 *            → recordUnityAccess → _auditLog + LoomAudit_CL
 *
 * turns these RED. MUTATION-PROOF: deleting the `recordUnitySecurableAccess(…)`
 * call from `ucSecurable`'s `finally` fails every test in
 * 'the facade EMITS a real audit row' and 'a DENIED mint is recorded'.
 *
 * Most blocks are ATTACKS, not happy paths:
 *   - a GCP service-account PRIVATE KEY reaching Cosmos, the SIEM and — because
 *     a mutation EGRESSES — a third-party webhook, via the upstream error
 *     message (Unity Catalog 400s echo the request body);
 *   - a DENIED mint attempt dropped because the recorder sat on the success path;
 *   - a CREATE recorded at collection scope ('*') because the POST goes to the
 *     collection URL and carries no name.
 *
 * The final block covers the #2622 RESIDUAL: the transport's OWN row. It imports
 * the REAL `shortcut-credentials` module via `vi.importActual` (the module-level
 * `vi.mock` below only replaces it for the facade's consumers) with just
 * `fetchWithTimeout` stubbed, so the assertions are still on bytes that reached
 * the sinks — never on a spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted, because every one of these is referenced from a `vi.mock` factory —
// which vitest lifts above the imports.
const H = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  emitAuditEvent: vi.fn(),
  rawEnsureAws: vi.fn(),
  rawEnsureGcp: vi.fn(),
  rawEnsureLoc: vi.fn(),
  rawDeleteLoc: vi.fn(),
  rawDeleteCred: vi.fn(),
  fetchWithTimeout: vi.fn(),
  session: {
    claims: { oid: 'oid-alice', upn: 'alice@contoso.com', tid: 'tenant-1' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  } as unknown,
}));
const { auditCreate, emitAuditEvent } = H;

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-aad-token', expiresOnTimestamp: Date.now() + 3_600_000 }; }
  }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: async () => ({ items: { create: H.auditCreate } }),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: H.emitAuditEvent }));
vi.mock('@/lib/auth/session', () => ({ getSession: () => H.session }));

// Stubbed for the REAL transport exercised in the last block. `fetchWithTimeout`
// resolves on a 4xx — it does not throw — which is exactly why the transport has
// to read `res.ok` to know it failed.
vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: (...a: unknown[]) => H.fetchWithTimeout(...a),
}));

// ONLY the raw transport is stubbed. The recorder underneath the facade is the
// REAL one — that is what makes these tests proof of an emit rather than proof
// that a spy was called.
vi.mock('../shortcut-credentials', () => ({
  getKeyVaultSecret: vi.fn(),
  keyVaultConfigGate: vi.fn(() => null),
  ensureUcAwsStorageCredential: H.rawEnsureAws,
  ensureUcGcpStorageCredential: H.rawEnsureGcp,
  ensureUcExternalLocation: H.rawEnsureLoc,
  deleteUcExternalLocation: H.rawDeleteLoc,
  deleteUcStorageCredential: H.rawDeleteCred,
}));

import { flushUnityAudit, unitySecurableErrorStatus, UNITY_SECURABLE_ALL } from '../unity-audit';
import { withSecurableRecordedByCaller } from '../securable-audit-context';
import {
  ucSecurable,
  ensureUcAwsStorageCredential,
  ensureUcGcpStorageCredential,
  ensureUcExternalLocation,
  deleteUcExternalLocation,
  deleteUcStorageCredential,
  UC_STORAGE_CREDENTIALS_PATH,
  UC_EXTERNAL_LOCATIONS_PATH,
} from '../uc-securable';

function reset() {
  auditCreate.mockReset();
  emitAuditEvent.mockReset();
  auditCreate.mockResolvedValue({});
  H.rawEnsureAws.mockReset().mockResolvedValue({ name: 'cred' });
  H.rawEnsureGcp.mockReset().mockResolvedValue({ name: 'cred' });
  H.rawEnsureLoc.mockReset().mockResolvedValue({ name: 'loc' });
  H.rawDeleteLoc.mockReset().mockResolvedValue(undefined);
  H.rawDeleteCred.mockReset().mockResolvedValue(undefined);
  H.fetchWithTimeout.mockReset();
  H.session = {
    claims: { oid: 'oid-alice', upn: 'alice@contoso.com', tid: 'tenant-1' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

beforeEach(reset);
afterEach(reset);

/** Every string that left the recorder, across BOTH sinks. */
function everythingWritten(): string {
  return JSON.stringify({ cosmos: auditCreate.mock.calls, siem: emitAuditEvent.mock.calls });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EMIT — WHO / WHAT / WHEN / OUTCOME, on both sinks
// ─────────────────────────────────────────────────────────────────────────────

describe('the facade EMITS a real audit row (#2622 gap 1)', () => {
  it('records actor + target + action for an AWS storage-credential CREATE', async () => {
    await ensureUcAwsStorageCredential({
      name: 'loom_sc_lake1_orders',
      roleArn: 'arn:aws:iam::123456789012:role/loom-read',
      readOnly: true,
      comment: 'Loom shortcut orders',
    } as never);
    await flushUnityAudit();

    // The raw call still happened, unchanged — the facade is transparent.
    expect(H.rawEnsureAws).toHaveBeenCalledTimes(1);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = auditCreate.mock.calls[0][0];
    expect(row).toMatchObject({
      // WHAT
      action: 'unity.storage_credential.create',
      operation: 'storage_credential.create',
      securableType: 'storage_credential',
      securableFqn: 'loom_sc_lake1_orders',
      method: 'POST',
      path: UC_STORAGE_CREDENTIALS_PATH,
      // OUTCOME
      outcome: 'success',
      status: 200,
      // WHO
      actorOid: 'oid-alice',
      actorUpn: 'alice@contoso.com',
      tenantId: 'tenant-1',
      // a CREATE is a state change, so it is flagged as one
      mutation: true,
      itemType: 'loom-unity',
    });
    // WHEN — an ISO-8601 instant, not a placeholder.
    expect(typeof row.at).toBe('string');
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);

    // …and the SAME event reached the SIEM stream.
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    const [ev] = emitAuditEvent.mock.calls[0];
    expect(ev).toMatchObject({
      actorOid: 'oid-alice',
      actorUpn: 'alice@contoso.com',
      action: 'unity.storage_credential.create',
      targetType: 'unity:storage_credential',
      targetId: 'loom_sc_lake1_orders',
      outcome: 'success',
      tenantId: 'tenant-1',
    });
  });

  it('records the GCP storage-credential CREATE the same way', async () => {
    await ensureUcGcpStorageCredential({
      name: 'loom_sc_lake1_gcs',
      serviceAccountJson: { client_email: 'x@y.iam.gserviceaccount.com' },
      readOnly: true,
    } as never);
    await flushUnityAudit();

    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.storage_credential.create',
      securableFqn: 'loom_sc_lake1_gcs',
      outcome: 'success',
    });
  });

  it('records an external-location CREATE', async () => {
    await ensureUcExternalLocation({
      name: 'loom_el_lake1_orders',
      url: 's3://bucket/prefix',
      credentialName: 'loom_sc_lake1_orders',
      readOnly: true,
    } as never);
    await flushUnityAudit();

    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.external_location.create',
      operation: 'external_location.create',
      securableType: 'external_location',
      securableFqn: 'loom_el_lake1_orders',
      method: 'POST',
      path: UC_EXTERNAL_LOCATIONS_PATH,
      outcome: 'success',
    });
  });

  it('records both DELETEs with the securable NAME on the path and the row', async () => {
    await deleteUcExternalLocation('loom_el_lake1_orders', true);
    await deleteUcStorageCredential('loom_sc_lake1_orders', true);
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.external_location.delete',
      securableType: 'external_location',
      securableFqn: 'loom_el_lake1_orders',
      method: 'DELETE',
      path: `${UC_EXTERNAL_LOCATIONS_PATH}/loom_el_lake1_orders`,
      outcome: 'success',
      mutation: true,
    });
    expect(auditCreate.mock.calls[1][0]).toMatchObject({
      action: 'unity.storage_credential.delete',
      securableType: 'storage_credential',
      securableFqn: 'loom_sc_lake1_orders',
      method: 'DELETE',
      outcome: 'success',
    });
  });

  it('writes tenantId, so the row is reachable by the readers that filter on it', async () => {
    // The #2794 defect class: a row that appears to persist and is in fact
    // permanently unreachable because the partition/filter field is absent.
    await deleteUcStorageCredential('loom_sc_x');
    await flushUnityAudit();
    const row = auditCreate.mock.calls[0][0];
    expect(row.tenantId).toBe('tenant-1');
    expect(row.itemId).toBe('loom_sc_x'); // named securable → its own partition
  });

  it('falls back to collection scope, honestly, when the caller has no name', async () => {
    await ucSecurable({ path: UC_STORAGE_CREDENTIALS_PATH, method: 'POST' }, async () => 'ok');
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      securableFqn: UNITY_SECURABLE_ALL,
      operation: 'storage_credential.create',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DENIAL — the row a `catch`-shaped implementation would drop
// ─────────────────────────────────────────────────────────────────────────────

describe('a DENIED mint is recorded even though the call re-throws', () => {
  it('classifies a 403 from the upstream message as `denied`', async () => {
    H.rawEnsureAws.mockRejectedValue(
      new Error("ensureUcAwsStorageCredential failed 403: {\"error_code\":\"PERMISSION_DENIED\"}"),
    );

    await expect(
      ensureUcAwsStorageCredential({ name: 'loom_sc_denied', roleArn: 'arn:aws:iam::1:role/r' } as never),
    ).rejects.toThrow(/failed 403/); // the caller still sees the failure…
    await flushUnityAudit();

    // …AND the row exists. This is the single most valuable row on this surface:
    // who was refused permission to mint storage access.
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.storage_credential.create',
      securableFqn: 'loom_sc_denied',
      outcome: 'denied',
      status: 403,
      actorUpn: 'alice@contoso.com',
      detail: 'http_status=403',
    });
    expect(emitAuditEvent.mock.calls[0][0]).toMatchObject({ outcome: 'denied' });
  });

  it('classifies a 401 as `denied` and a 500 as `failure`', async () => {
    H.rawDeleteCred.mockRejectedValue(new Error('deleteUcStorageCredential failed 401: nope'));
    await expect(deleteUcStorageCredential('a')).rejects.toThrow();
    H.rawDeleteCred.mockRejectedValue(new Error('deleteUcStorageCredential failed 500: boom'));
    await expect(deleteUcStorageCredential('b')).rejects.toThrow();
    await flushUnityAudit();

    expect(auditCreate.mock.calls[0][0]).toMatchObject({ outcome: 'denied', status: 401 });
    expect(auditCreate.mock.calls[1][0]).toMatchObject({ outcome: 'failure', status: 500 });
  });

  it('still records when the status cannot be recovered at all', async () => {
    // An un-parseable error must never DROP a row — it degrades to `failure`
    // with status 0, which is honest rather than absent.
    H.rawDeleteLoc.mockRejectedValue(new Error('socket hang up'));
    await expect(deleteUcExternalLocation('loom_el_x')).rejects.toThrow(/socket hang up/);
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.external_location.delete',
      securableFqn: 'loom_el_x',
      outcome: 'failure',
      status: 0,
    });
  });

  it('an audit-sink outage cannot turn a working call into a failure', async () => {
    auditCreate.mockRejectedValue(new Error('cosmos down'));
    await expect(deleteUcStorageCredential('loom_sc_ok')).resolves.toBeUndefined();
    await flushUnityAudit();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SECRET-LEAK ATTACK — why `detail` is a status code and not the message
// ─────────────────────────────────────────────────────────────────────────────

describe('the upstream error message must never reach an audit row', () => {
  const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----MIIEvQIBADANBgkqhkiG9w0BSup3rSecret-----END PRIVATE KEY-----';

  it('drops a GCP service-account private key echoed back by Unity Catalog', async () => {
    // `ensureUcGcpStorageCredential` POSTs the service-account JSON. A Unity
    // Catalog 400 routinely echoes the request body, and shortcut-credentials.ts
    // throws `<fn> failed <status>: <body>` — so the thrown message can carry a
    // LIVE private key. A CREATE is a mutation, and mutations egress to
    // tenant-registered third-party webhooks, so this row leaving with the
    // message on it could not be recalled.
    H.rawEnsureGcp.mockRejectedValue(
      new Error(`ensureUcGcpStorageCredential failed 400: {"gcp_service_account_key":{"private_key":"${PRIVATE_KEY}"}}`),
    );

    await expect(
      ensureUcGcpStorageCredential({ name: 'loom_sc_gcs', serviceAccountJson: {} } as never),
    ).rejects.toThrow();
    await flushUnityAudit();

    // The row is REAL — actor, securable and outcome are all there…
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.storage_credential.create',
      securableFqn: 'loom_sc_gcs',
      outcome: 'failure',
      status: 400,
      detail: 'http_status=400',
    });
    // …and NOTHING from the message is on it, in EITHER sink.
    const written = everythingWritten();
    expect(written).not.toContain(PRIVATE_KEY);
    expect(written).not.toContain('BEGIN PRIVATE KEY');
    expect(written).not.toContain('Sup3rSecret');
    expect(written).not.toContain('private_key');
  });

  it('drops an AWS role ARN echoed back in the message', async () => {
    const ARN = 'arn:aws:iam::999888777666:role/prod-lake-admin';
    H.rawEnsureAws.mockRejectedValue(new Error(`ensureUcAwsStorageCredential failed 400: bad role ${ARN}`));
    await expect(ensureUcAwsStorageCredential({ name: 'loom_sc_aws', roleArn: ARN } as never)).rejects.toThrow();
    await flushUnityAudit();
    expect(everythingWritten()).not.toContain(ARN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The pure status extractor
// ─────────────────────────────────────────────────────────────────────────────

describe('unitySecurableErrorStatus', () => {
  it('prefers a structured .status', () => {
    expect(unitySecurableErrorStatus(Object.assign(new Error('x'), { status: 403 }))).toBe(403);
  });

  it('recovers the status from the shortcut-credentials message shape', () => {
    expect(unitySecurableErrorStatus(new Error('deleteUcExternalLocation failed 404: not found'))).toBe(404);
    expect(unitySecurableErrorStatus(new Error('ensureUcExternalLocation failed 409: exists'))).toBe(409);
  });

  it('returns 0 rather than guessing', () => {
    expect(unitySecurableErrorStatus(new Error('socket hang up'))).toBe(0);
    expect(unitySecurableErrorStatus(null)).toBe(0);
    expect(unitySecurableErrorStatus('not an error')).toBe(0);
    // Not an HTTP status: must not be mistaken for one.
    expect(unitySecurableErrorStatus(new Error('failed 42: nope'))).toBe(0);
    expect(unitySecurableErrorStatus(new Error('failed 9999'))).toBe(0);
    expect(unitySecurableErrorStatus(Object.assign(new Error('x'), { status: 99 }))).toBe(0);
  });

  it('returns ONLY the code — never a substring of the message', () => {
    const out = unitySecurableErrorStatus(new Error('failed 403: private_key=abc'));
    expect(out).toBe(403);
    expect(typeof out).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2622 RESIDUAL — the TRANSPORT records, and the two layers write ONE row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For three rounds the recorder lived only in the facade, and the guard carried a
 * `KNOWN_UNAUDITED` entry saying so: "a future export added inside this file
 * could reach the catalog without a row of its own". That is what this block
 * closes, and it is the half a lexical guard cannot reach — the guard proves
 * `recordUnitySecurableAccess(` sits inside `securableFetch`'s `finally`, not
 * that a call REACHES it, nor that exactly one row comes out.
 *
 * The real module is pulled in with `importActual`, so these run against the
 * shipped transport rather than the stub the facade tests use.
 */
describe('#2622 residual — securableFetch records its OWN row', () => {
  type RawModule = typeof import('../shortcut-credentials');
  let raw: RawModule;

  const priorEnv = { ...process.env };

  beforeEach(async () => {
    process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.4.azuredatabricks.net';
    raw = await vi.importActual<RawModule>('../shortcut-credentials');
  });
  afterEach(() => { process.env = { ...priorEnv }; });

  /** A `fetchWithTimeout` result: it RESOLVES on a 4xx, it does not throw. */
  function response(status: number, body = '{}'): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }

  it('records a CREATE issued WITHOUT the facade — the hole the KNOWN_UNAUDITED entry named', async () => {
    H.fetchWithTimeout.mockResolvedValue(response(200));

    // Called directly, exactly as a NEW export inside that file would call it.
    await raw.ensureUcAwsStorageCredential({
      name: 'loom_sc_direct',
      roleArn: 'arn:aws:iam::123456789012:role/loom-read',
    });
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.storage_credential.create',
      securableFqn: 'loom_sc_direct',
      method: 'POST',
      path: UC_STORAGE_CREDENTIALS_PATH,
      outcome: 'success',
      status: 200,
      actorOid: 'oid-alice',
      tenantId: 'tenant-1',
      mutation: true,
    });
  });

  it('records a DENIED direct mint — a 403 RESOLVES here, so `res.ok` is what catches it', async () => {
    // The failure mode this pins: `fetchWithTimeout` does not throw on a 4xx, so
    // a transport that only recorded from `catch` — or that passed `error:
    // failure` alone — would file the 403 as a SUCCESS. That row is the one an
    // ATO reviewer hunts for.
    H.fetchWithTimeout.mockResolvedValue(response(403, '{"error_code":"PERMISSION_DENIED"}'));

    await expect(raw.ensureUcExternalLocation({
      name: 'loom_el_direct',
      url: 's3://bucket/prefix',
      credentialName: 'loom_sc_direct',
    })).rejects.toThrow();
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.external_location.create',
      securableFqn: 'loom_el_direct',
      outcome: 'denied',
      status: 403,
    });
  });

  it('records a direct DELETE, with the securable name off the caller params', async () => {
    H.fetchWithTimeout.mockResolvedValue(response(200));
    await raw.deleteUcStorageCredential('loom_sc_direct');
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      method: 'DELETE',
      securableFqn: 'loom_sc_direct',
      outcome: 'success',
    });
  });

  it('records when the TOKEN acquisition fails, before any request leaves', async () => {
    delete process.env.LOOM_DATABRICKS_HOSTNAME;
    // dbxHost() throws inside the try, so the finally is the only thing that can
    // file this — a `catch`-shaped recorder placed after the fetch would not.
    await expect(raw.deleteUcExternalLocation('loom_el_direct')).rejects.toThrow(/LOOM_DATABRICKS_HOSTNAME/);
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ securableFqn: 'loom_el_direct', outcome: 'failure' });
    expect(H.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('writes exactly ONE row when the FACADE calls it — not two', async () => {
    // The de-duplication, asserted end to end rather than by reading the flag.
    // The facade path is the one production uses, so a regression here would
    // double every securable row AND double the third-party webhook fan-out.
    H.fetchWithTimeout.mockResolvedValue(response(200));
    const { ensureUcAwsStorageCredential: viaFacade } = await import('../uc-securable');

    // Route the facade at the REAL raw module for this one call: the module-level
    // vi.mock replaced it with spies for every other test in this file. The
    // suppression rides on an async context, not on an argument, so forwarding
    // the spec alone is enough — which is the property being asserted.
    H.rawEnsureAws.mockImplementation(
      (spec: Parameters<RawModule['ensureUcAwsStorageCredential']>[0]) =>
        raw.ensureUcAwsStorageCredential(spec),
    );

    await viaFacade({ name: 'loom_sc_once', roleArn: 'arn:aws:iam::123456789012:role/r' } as never);
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ securableFqn: 'loom_sc_once', outcome: 'success' });
  });

  it('CONTROL — the suppression is opt-IN: OUTSIDE the context the same call records', async () => {
    // Without this, the test above is satisfied by a transport that never records
    // at all. The mutation is the context wrapper alone, and it must flip the count.
    H.fetchWithTimeout.mockResolvedValue(response(200));
    const spec = { name: 'loom_sc_once', roleArn: 'arn:aws:iam::123456789012:role/r' };

    await raw.ensureUcAwsStorageCredential(spec);
    await flushUnityAudit();
    expect(auditCreate).toHaveBeenCalledTimes(1);

    auditCreate.mockClear();
    await withSecurableRecordedByCaller(() => raw.ensureUcAwsStorageCredential(spec));
    await flushUnityAudit();
    expect(auditCreate).toHaveBeenCalledTimes(0);
  });

  it('the context does NOT leak to a concurrent call outside it', async () => {
    // Why an AsyncLocalStorage and not a module-level flag. With a flag, the
    // suppressed call below would be in flight across the other call's await and
    // would swallow ITS row — a dropped securable row that appears only under
    // concurrency, which is the shape that never reproduces in a test written
    // after the fact. Both calls are started before either resolves.
    H.fetchWithTimeout.mockImplementation(
      async () => new Promise((r) => setTimeout(() => r(response(200)), 5)),
    );

    await Promise.all([
      withSecurableRecordedByCaller(() => raw.deleteUcStorageCredential('suppressed')),
      raw.deleteUcStorageCredential('recorded'),
    ]);
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ securableFqn: 'recorded' });
  });

  it('the upstream 400 body still never reaches the row on the DIRECT path either', async () => {
    // The facade half of this is asserted above. The transport is a second door
    // to the same sink, so it gets the same assertion: a UC 400 echoes the
    // request, and the GCP variant's request carries a service-account
    // private_key. `detail` is the extracted status code and nothing else.
    const echoed = '{"message":"invalid: {\\"private_key\\":\\"-----BEGIN PRIVATE KEY-----AAAA\\"}"}';
    H.fetchWithTimeout.mockResolvedValue(response(400, echoed));

    await expect(raw.ensureUcGcpStorageCredential({
      name: 'loom_sc_gcp_direct',
      serviceAccountJson: {
        client_email: 'sa@p.iam.gserviceaccount.com',
        private_key_id: 'kid',
        private_key: '-----BEGIN PRIVATE KEY-----AAAA',
      },
    })).rejects.toThrow();
    await flushUnityAudit();

    const written = JSON.stringify({ cosmos: auditCreate.mock.calls, siem: emitAuditEvent.mock.calls });
    expect(written).not.toContain('PRIVATE KEY');
    expect(written).not.toContain('private_key');
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ detail: 'http_status=400', status: 400 });
  });
});

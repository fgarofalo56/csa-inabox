/**
 * ISSUE #2622, GAP 1 — the LAST un-audited Unity Catalog exit.
 *
 * `lib/azure/shortcut-credentials.ts` issues storage-credential and
 * external-location CREATE/DELETE from its own private transport. Those are the
 * securables that hand a workload access to a storage account — the closest
 * thing in Unity Catalog to minting access — and until now they produced no Loom
 * audit row. The file cannot be instrumented in place (repo-level
 * credential-path read/write deny), so the audit lives in a FACADE,
 * `lib/azure/uc-securable.ts`, which is now the only permitted importer.
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

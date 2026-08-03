/**
 * ISSUE #2622 — the two un-audited Unity Catalog exits this PR closes.
 *
 * Gap 2: the Databricks **SQL Statement Execution** half. ~25 `executeStatement`
 *        calls carried the governance DDL — `GRANT`/`REVOKE`, ABAC
 *        `CREATE POLICY` / `DROP POLICY`, `ALTER … SET MASK` / `SET ROW FILTER`,
 *        governed tags, `SET TAGS` — and produced no Loom audit row. They now go
 *        through `ucSql`, which records from a `finally`.
 * Gap 3: the Databricks **account plane**. Metastore assignment is an
 *        account-admin mutation on a path no other choke point can even see.
 *
 * Every block here is an ATTACK on the new trail, not a happy path:
 *
 *   - a plaintext `CREATE CONNECTION … OPTIONS (password '…')` reaching Cosmos,
 *     the SIEM, and — because a mutation EGRESSES — a third-party webhook;
 *   - a Databricks error message (which echoes the failing statement) reaching
 *     the same three places;
 *   - a `SELECT` classified as a mutation and fanned out on every catalog read;
 *   - a DENIED statement dropped because the recorder sat on the success path;
 *   - a row written WITHOUT `tenantId`, which `ARRAY_CONTAINS` can never match —
 *     the #2794 defect class, where audit rows appear to persist and are in fact
 *     permanently unreachable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted, because every one of these is referenced from a `vi.mock` factory —
// which vitest lifts above the imports.
const H = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  emitAuditEvent: vi.fn(),
  executeStatement: vi.fn(),
  /** Swapped per test so a tid-less session can be exercised. */
  session: {
    claims: { oid: 'oid-alice', upn: 'alice@contoso.com', tid: 'tenant-1' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  } as unknown,
}));
const { auditCreate, emitAuditEvent, executeStatement } = H;

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

// `ucSql` is the unit under test for the finally semantics, so its transport is
// the only thing stubbed — the recorder underneath is the real one.
vi.mock('../databricks-client', () => ({ executeStatement: H.executeStatement }));

import {
  classifyUnitySqlStatement,
  classifyUnityAccountCall,
  recordUnitySqlAccess,
  recordUnityAccountAccess,
  unitySqlErrorCode,
  unitySqlOutcome,
  isUnityMutation,
  flushUnityAudit,
  SQL_PSEUDO_METHOD,
  UNITY_SECURABLE_ALL,
} from '../unity-audit';
import { ucSql } from '../uc-sql';

function reset() {
  auditCreate.mockReset();
  emitAuditEvent.mockReset();
  executeStatement.mockReset();
  auditCreate.mockResolvedValue({});
  executeStatement.mockResolvedValue({ columns: [], rows: [], rowCount: 0, executionMs: 1 });
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
// THE SECRET-LEAK ATTACK — the reason the classifier's output alphabet is closed
// ─────────────────────────────────────────────────────────────────────────────

describe('the SQL statement text must never reach an audit row', () => {
  const SECRET = 'Sup3rSecret-Lakehouse-Password!';
  const CONNECTION_DDL =
    "CREATE CONNECTION `sqlsrv_prod` TYPE SQLSERVER\n" +
    `OPTIONS (host 'db.example.net', port '1433', user 'loom', password '${SECRET}');`;

  it('writes a row for CREATE CONNECTION without any fragment of the statement', async () => {
    recordUnitySqlAccess({ sql: CONNECTION_DDL, target: 'sqlsrv_prod', warehouseId: 'abc123' });
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const row = auditCreate.mock.calls[0][0];
    // The row is REAL — the operation, the securable and the actor are all there…
    expect(row).toMatchObject({
      action: 'unity.connection.create',
      operation: 'connection.create',
      securableType: 'connection',
      securableFqn: 'sqlsrv_prod',
      method: SQL_PSEUDO_METHOD,
      outcome: 'success',
      actorUpn: 'alice@contoso.com',
    });
    // …and NOTHING from the statement is on it, in EITHER sink.
    const written = everythingWritten();
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain('OPTIONS');
    expect(written).not.toContain('db.example.net');
  });

  it('does not leak the statement through a Databricks error, which echoes it', async () => {
    // This is how the leak would actually happen: `executeStatement` throws with
    // `message` = the server's error text, and Databricks quotes the failing
    // statement back. Copying `err.message` onto the row — which the REST-side
    // recorder legitimately does — would put the password on a webhook.
    const err: Error & { code?: string } = new Error(
      `[PARSE_SYNTAX_ERROR] Syntax error at or near 'OPTIONS': ${CONNECTION_DDL}`,
    );
    err.code = 'PARSE_SYNTAX_ERROR';
    recordUnitySqlAccess({ sql: CONNECTION_DDL, target: 'sqlsrv_prod', error: err });
    await flushUnityAudit();

    const written = everythingWritten();
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain('Syntax error');
    // The failure is still HONEST — the closed error_code token survives.
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      outcome: 'failure',
      detail: 'error_code=PARSE_SYNTAX_ERROR',
    });
  });

  it('refuses an error_code that is not a closed enum token', () => {
    expect(unitySqlErrorCode({ code: 'PERMISSION_DENIED' })).toBe('PERMISSION_DENIED');
    // A driver that put a message — or a statement — on `.code` must yield
    // nothing rather than smuggling text onto the row.
    expect(unitySqlErrorCode({ code: `failed: ${CONNECTION_DDL}` })).toBeUndefined();
    expect(unitySqlErrorCode({ code: 'lower_case' })).toBe('LOWER_CASE'); // upper-cased, still closed
    expect(unitySqlErrorCode({ code: 'has spaces' })).toBeUndefined();
    expect(unitySqlErrorCode({ code: 'X'.repeat(200) })).toBeUndefined();
    expect(unitySqlErrorCode({})).toBeUndefined();
  });

  it('still records the failure when no usable code is present', async () => {
    recordUnitySqlAccess({ sql: 'DROP POLICY `p` ON TABLE a.b.c;', error: new Error(`nope ${SECRET}`) });
    await flushUnityAudit();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(everythingWritten()).not.toContain(SECRET);
    expect(String(auditCreate.mock.calls[0][0].detail)).toMatch(/withheld/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tenantId — the #2794 class: a row that persists but can never be READ
// ─────────────────────────────────────────────────────────────────────────────

describe('every new row carries tenantId UNCONDITIONALLY', () => {
  const tid = (row: Record<string, unknown>) => ({
    present: Object.prototype.hasOwnProperty.call(row, 'tenantId'),
    value: row.tenantId,
  });

  it('stamps tenantId on a SQL row even when the session has no tid claim', async () => {
    // #2794: writers stamped tenantId CONDITIONALLY, so a tid-less session wrote
    // rows with NO tenantId property at all. ARRAY_CONTAINS can never match an
    // absent property, so those rows persisted and were permanently unreachable.
    H.session = { claims: { oid: 'oid-no-tid', upn: 'bob@contoso.com' }, exp: 1 };
    recordUnitySqlAccess({ sql: 'GRANT SELECT ON TABLE a.b.c TO `g`', target: 'a.b.c' });
    await flushUnityAudit();
    const t = tid(auditCreate.mock.calls[0][0]);
    expect(t.present).toBe(true);
    expect(typeof t.value).toBe('string');
    expect(t.value).toBeTruthy();
  });

  it('stamps tenantId on an account-plane row with NO session at all', async () => {
    H.session = null;
    recordUnityAccountAccess({ path: '/workspaces/42/metastore', method: 'PUT', status: 200 });
    await flushUnityAudit();
    const t = tid(auditCreate.mock.calls[0][0]);
    expect(t.present).toBe(true);
    expect(t.value).toBe('system'); // honest, not borrowed from the last human
  });

  it('stamps tenantId on the SIEM event too', async () => {
    H.session = { claims: { oid: 'oid-no-tid', upn: 'bob@contoso.com' }, exp: 1 };
    recordUnitySqlAccess({ sql: 'SHOW POLICIES ON TABLE a.b.c' });
    await flushUnityAudit();
    const ev = emitAuditEvent.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(ev, 'tenantId')).toBe(true);
    expect(ev.tenantId).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary egress — a SQL READ must not leave the estate
// ─────────────────────────────────────────────────────────────────────────────

describe('BOUNDARY EGRESS for the SQL pseudo-method', () => {
  it('does NOT egress a SELECT / SHOW / DESCRIBE', () => {
    // Every SQL statement is a POST to /api/2.0/sql/statements. Recording the
    // real HTTP method would mark every information_schema read as a mutation
    // and ship actor UPN + securable FQN to every registered third-party URL.
    for (const op of ['sql.select', 'sql.show', 'sql.describe', 'policy.list', 'governed-tag.get', 'sql.statement']) {
      expect(isUnityMutation({ method: SQL_PSEUDO_METHOD, operation: op }), op).toBe(false);
    }
  });

  it('DOES egress a governance mutation', () => {
    for (const op of [
      'grant.grant', 'grant.revoke', 'policy.create', 'policy.drop', 'policy.alter',
      'column-mask.set', 'column-mask.drop', 'row-filter.set', 'row-filter.drop',
      'tag.set', 'tag.unset', 'governed-tag.create', 'governed-tag.alter', 'governed-tag.drop',
      'connection.create', 'catalog.create', 'table.create', 'view.drop',
    ]) {
      expect(isUnityMutation({ method: SQL_PSEUDO_METHOD, operation: op }), op).toBe(true);
    }
  });

  it('CONTROL — the HTTP arms are unchanged by the SQL arm', () => {
    // An over-broad edit to isUnityMutation would show up here: the REST rules
    // must still hold in both directions.
    expect(isUnityMutation({ method: 'GET', operation: 'catalog.list' })).toBe(false);
    expect(isUnityMutation({ method: 'GET', operation: 'probe.anonymous-read' })).toBe(false);
    expect(isUnityMutation({ method: 'POST', operation: 'unity.request' })).toBe(true);
    expect(isUnityMutation({ method: 'PATCH', operation: 'grant.update' })).toBe(true);
    expect(isUnityMutation({ method: 'GET', operation: 'catalog.delete' })).toBe(true);
  });

  it('fans a SELECT to the SIEM with the webhook DISABLED and a GRANT with it enabled', async () => {
    recordUnitySqlAccess({ sql: 'SELECT * FROM `a`.`b`.`c` LIMIT 10;', target: 'a.b.c' });
    await flushUnityAudit();
    expect(emitAuditEvent.mock.calls[0][1]).toEqual({ webhook: false });

    reset();
    recordUnitySqlAccess({ sql: 'GRANT SELECT ON TABLE a.b.c TO `analysts`', target: 'a.b.c' });
    await flushUnityAudit();
    expect(emitAuditEvent.mock.calls[0][1]).toEqual({ webhook: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The classifier — grounded in what the pure builders actually emit
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyUnitySqlStatement', () => {
  const cases: Array<[string, string, string]> = [
    ['GRANT SELECT, MODIFY ON TABLE `a`.`b`.`c` TO `analysts`', 'grant.grant', 'grant'],
    ['REVOKE ALL PRIVILEGES ON SCHEMA a.b FROM `x`', 'grant.revoke', 'grant'],
    ['CREATE OR REPLACE POLICY `p`\nON TABLE a.b.c\nROW FILTER a.b.f\nTO `g`\nFOR TABLES;', 'policy.create', 'policy'],
    ['CREATE POLICY `p` ON SCHEMA a.b COLUMN MASK a.b.m TO `g` FOR TABLES;', 'policy.create', 'policy'],
    ['DROP POLICY `p` ON TABLE a.b.c;', 'policy.drop', 'policy'],
    ['SHOW POLICIES ON TABLE a.b.c;', 'policy.list', 'policy'],
    ['SHOW EFFECTIVE POLICIES ON TABLE a.b.c;', 'policy.list', 'policy'],
    ['DESCRIBE POLICY `p` ON TABLE a.b.c;', 'policy.get', 'policy'],
    ['CREATE GOVERNED TAG `pii` ALLOWED_VALUES (\'a\');', 'governed-tag.create', 'governed_tag'],
    ["ALTER GOVERNED TAG `pii` SET DESCRIPTION 'x';", 'governed-tag.alter', 'governed_tag'],
    ["ALTER GOVERNED TAG `pii` SET VALUES ('a', 'b');", 'governed-tag.alter', 'governed_tag'],
    ['DROP GOVERNED TAG `pii`;', 'governed-tag.drop', 'governed_tag'],
    ['SHOW GOVERNED TAGS;', 'governed-tag.list', 'governed_tag'],
    ['DESCRIBE GOVERNED TAG `pii`;', 'governed-tag.get', 'governed_tag'],
    ["ALTER TABLE `a`.`b`.`c` SET TAGS ('pii' = 'high');", 'tag.set', 'tag'],
    ["ALTER SCHEMA `a`.`b` UNSET TAGS ('pii');", 'tag.unset', 'tag'],
    ["ALTER TABLE `a`.`b`.`c` ALTER COLUMN `ssn` SET TAGS ('pii' = 'high');", 'tag.set', 'tag'],
    ['ALTER TABLE `a`.`b`.`c`\nALTER COLUMN `ssn` SET MASK a.b.mask_ssn;', 'column-mask.set', 'column_mask'],
    ['ALTER TABLE `a`.`b`.`c`\nALTER COLUMN `ssn` DROP MASK;', 'column-mask.drop', 'column_mask'],
    ['ALTER TABLE `a`.`b`.`c`\nSET ROW FILTER a.b.f ON (`region`);', 'row-filter.set', 'row_filter'],
    ['ALTER TABLE `a`.`b`.`c`\nDROP ROW FILTER;', 'row-filter.drop', 'row_filter'],
    ['CREATE OR REPLACE FUNCTION a.b.mask_ssn(val STRING)\nRETURN CASE WHEN 1=1 THEN val END;', 'function.create', 'function'],
    ['CREATE OR REPLACE VIEW a.b.mv WITH METRICS LANGUAGE YAML AS $$x$$;', 'view.create', 'view'],
    ['DROP VIEW IF EXISTS a.b.mv;', 'view.drop', 'view'],
    ['SHOW VIEWS IN a.b;', 'view.list', 'view'],
    ['CREATE TABLE a.b.t (id INT) USING ICEBERG;', 'table.create', 'table'],
    ['CREATE CONNECTION `c` TYPE SQLSERVER OPTIONS (host \'h\');', 'connection.create', 'connection'],
    ['CREATE FOREIGN CATALOG `fc` USING CONNECTION `c` OPTIONS (database \'d\');', 'catalog.create', 'catalog'],
    ['SELECT * FROM a.b.c LIMIT 10;', 'sql.select', 'table'],
    ['SELECT * FROM system.access.table_lineage WHERE x = :fn', 'sql.select', 'table'],
  ];

  it.each(cases)('classifies %s', (sql, operation, securableType) => {
    expect(classifyUnitySqlStatement(sql)).toEqual({
      operation, securableType, securableFqn: UNITY_SECURABLE_ALL,
    });
  });

  it('records an un-modelled statement rather than dropping it', () => {
    // Silently skipping is the exact failure LU-3 exists to prevent.
    expect(classifyUnitySqlStatement('MERGE INTO a.b.c USING x ON 1=1')).toEqual({
      operation: 'sql.statement', securableType: 'unknown', securableFqn: UNITY_SECURABLE_ALL,
    });
    expect(classifyUnitySqlStatement('')).toMatchObject({ operation: 'sql.statement' });
    expect(classifyUnitySqlStatement(undefined as unknown as string)).toMatchObject({ operation: 'sql.statement' });
  });

  it('sees through a leading comment, which is how a statement gets disguised', () => {
    expect(classifyUnitySqlStatement('-- routine maintenance\nDROP POLICY `p` ON TABLE a.b.c;'))
      .toMatchObject({ operation: 'policy.drop' });
    expect(classifyUnitySqlStatement('/* nothing to see */ GRANT ALL PRIVILEGES ON CATALOG x TO `y`'))
      .toMatchObject({ operation: 'grant.grant' });
  });

  it('returns ONLY literals from its own table — never a slice of the input', () => {
    const marker = 'CANARY_TOKEN_ea11';
    for (const sql of [
      `GRANT SELECT ON TABLE ${marker} TO \`${marker}\``,
      `CREATE CONNECTION \`${marker}\` TYPE SQLSERVER OPTIONS (password '${marker}')`,
      `MERGE INTO ${marker} USING ${marker} ON 1=1`,
      `ALTER TABLE ${marker} SET TAGS ('${marker}' = '${marker}')`,
    ]) {
      expect(JSON.stringify(classifyUnitySqlStatement(sql))).not.toContain(marker);
    }
  });
});

describe('unitySqlOutcome — a denial is the row an ATO reviewer hunts for', () => {
  it('classifies a UC authorization refusal as denied', () => {
    expect(unitySqlOutcome({ code: 'PERMISSION_DENIED', message: 'x' })).toBe('denied');
    expect(unitySqlOutcome(new Error('INSUFFICIENT_PERMISSIONS: user lacks SELECT'))).toBe('denied');
    expect(unitySqlOutcome({ message: 'executeStatement submit failed 403: forbidden' })).toBe('denied');
    expect(unitySqlOutcome({ status: 401 })).toBe('denied');
  });

  it('does NOT widen denied to cover ordinary failures', () => {
    // Widening `denied` would drown the signal it exists to carry.
    expect(unitySqlOutcome(new Error('TABLE_OR_VIEW_NOT_FOUND'))).toBe('failure');
    expect(unitySqlOutcome({ code: 'PARSE_SYNTAX_ERROR' })).toBe('failure');
    expect(unitySqlOutcome({ message: 'executeStatement submit failed 500: boom' })).toBe('failure');
    expect(unitySqlOutcome(null)).toBe('success');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ucSql — the transport. The `finally` is the whole point.
// ─────────────────────────────────────────────────────────────────────────────

describe('ucSql records from a finally, so a DENIED statement is not dropped', () => {
  it('records a successful statement and passes the result through unchanged', async () => {
    executeStatement.mockResolvedValue({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 7 });
    const r = await ucSql('wh-1', 'SHOW GOVERNED TAGS;');
    expect(r).toEqual({ columns: ['a'], rows: [[1]], rowCount: 1, executionMs: 7 });
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.governed-tag.list', outcome: 'success', path: 'sql:warehouse/wh-1',
    });
  });

  it('records the DENIED row even though it re-throws', async () => {
    const err: Error & { code?: string } = new Error('User is not an owner of Table a.b.c');
    err.code = 'INSUFFICIENT_PERMISSIONS';
    executeStatement.mockRejectedValue(err);

    await expect(ucSql('wh-1', 'DROP POLICY `p` ON TABLE a.b.c;', { target: 'a.b.c' }))
      .rejects.toThrow('User is not an owner');
    await flushUnityAudit();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.policy.drop',
      securableFqn: 'a.b.c',
      outcome: 'denied',
      mutation: true,
      detail: 'error_code=INSUFFICIENT_PERMISSIONS',
    });
  });

  it('forwards catalog / schema / params / onStatementId to the transport unchanged', async () => {
    const onStatementId = vi.fn();
    const params = [{ name: 'fn', value: 'a.b.c', type: 'STRING' as const }];
    await ucSql('wh-2', 'SELECT 1', { catalog: 'cat', schema: 'sch', params, onStatementId });
    expect(executeStatement).toHaveBeenCalledWith('wh-2', 'SELECT 1', 'cat', 'sch', params, onStatementId);
  });

  it('never lets an audit-store outage break the statement', async () => {
    auditCreate.mockRejectedValue(new Error('cosmos down'));
    executeStatement.mockResolvedValue({ columns: [], rows: [], rowCount: 0, executionMs: 1 });
    await expect(ucSql('wh-1', 'SELECT 1')).resolves.toBeTruthy();
    await flushUnityAudit();
  });

  it('drops a warehouse id that is not an opaque token rather than recording it', async () => {
    await ucSql('../../etc/passwd', 'SELECT 1');
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0].path).toBe('sql:warehouse');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The account plane (gap 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyUnityAccountCall', () => {
  it('names metastore ASSIGNMENT as the mutation it is', () => {
    expect(classifyUnityAccountCall('PUT', '/workspaces/4224/metastore')).toEqual({
      operation: 'metastore-assignment.assign',
      securableType: 'metastore_assignment',
      securableFqn: 'workspace:4224',
    });
    expect(classifyUnityAccountCall('DELETE', '/workspaces/4224/metastore')).toMatchObject({
      operation: 'metastore-assignment.unassign',
    });
    expect(classifyUnityAccountCall('GET', '/workspaces/4224/metastore')).toMatchObject({
      operation: 'metastore-assignment.read',
    });
  });

  it('names the metastore list + get', () => {
    expect(classifyUnityAccountCall('GET', '/metastores')).toEqual({
      operation: 'metastore.list', securableType: 'metastore', securableFqn: UNITY_SECURABLE_ALL,
    });
    expect(classifyUnityAccountCall('GET', '/metastores/abc-123')).toMatchObject({
      operation: 'metastore.get', securableFqn: 'abc-123',
    });
    expect(classifyUnityAccountCall('DELETE', '/metastores/abc-123')).toMatchObject({
      operation: 'metastore.delete',
    });
  });

  it('records an un-modelled account path instead of dropping it', () => {
    expect(classifyUnityAccountCall('GET', '/scim/v2/Groups?x=1')).toEqual({
      operation: 'account.request', securableType: 'databricks_account', securableFqn: '/scim/v2/Groups',
    });
    // …and per the affirmative rule that catch-all does NOT egress on a read.
    expect(isUnityMutation({ method: 'GET', operation: 'account.request' })).toBe(false);
    expect(isUnityMutation({ method: 'PUT', operation: 'account.request' })).toBe(true);
  });
});

describe('recordUnityAccountAccess', () => {
  it('records the assignment mutation that previously produced no row at all', async () => {
    recordUnityAccountAccess({ path: '/workspaces/4224/metastore', method: 'PUT', status: 200, durationMs: 5 });
    await flushUnityAudit();
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'unity.metastore-assignment.assign',
      securableFqn: 'workspace:4224',
      backend: 'databricks',
      outcome: 'success',
      mutation: true,
    });
  });

  it('records a 403 "caller is not an account admin" as DENIED', async () => {
    recordUnityAccountAccess({ path: '/workspaces/4224/metastore', method: 'PUT', status: 403 });
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ outcome: 'denied' });
  });

  it('records a non-2xx as a failure even when no error object was thrown', async () => {
    recordUnityAccountAccess({ path: '/metastores', method: 'GET', status: 500 });
    await flushUnityAudit();
    expect(auditCreate.mock.calls[0][0]).toMatchObject({ outcome: 'failure' });
  });

  it('never carries the account id — it is not in the path the transport hands over', async () => {
    recordUnityAccountAccess({ path: '/workspaces/4224/metastore', method: 'GET', status: 200 });
    await flushUnityAudit();
    expect(everythingWritten()).not.toContain('/api/2.0/accounts/');
  });
});

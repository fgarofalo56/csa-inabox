/**
 * N7a — loom-risingwave streaming-SQL client: pure builders + guards + gate.
 *
 * These are the injection-safe DDL builders the editor's pickers feed and the
 * read-only guard the query edge enforces — all unit-testable with no backend.
 * The headline acceptance is a well-formed TWO-STREAM JOIN materialized view.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RisingWaveError,
  assertReadOnlyStreamingSql,
  assertStreamingDdl,
  buildEventHubKafkaSourceSql,
  buildLakeSinkSql,
  buildMaterializedViewSql,
  buildTwoStreamJoinMvSql,
  eventHubKafkaBootstrap,
  isRisingWaveConfigured,
  resolveRisingWaveTarget,
  risingwaveConfigGate,
} from '../risingwave-client';

const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.LOOM_RISINGWAVE_URL;
  delete process.env.LOOM_RISINGWAVE_DATABASE;
  delete process.env.LOOM_RISINGWAVE_USER;
  delete process.env.LOOM_RISINGWAVE_PASSWORD;
  delete process.env.LOOM_EVENTHUB_NAMESPACE;
  delete process.env.LOOM_GCCH;
  delete process.env.LOOM_IL5;
});
afterEach(() => { process.env = { ...SAVED }; });

describe('config gate', () => {
  it('reports the missing var when unset and clears when wired', () => {
    expect(risingwaveConfigGate()).toEqual({ missing: 'LOOM_RISINGWAVE_URL' });
    expect(isRisingWaveConfigured()).toBe(false);
    process.env.LOOM_RISINGWAVE_URL = 'loom-risingwave.internal:4566';
    expect(risingwaveConfigGate()).toBeNull();
    expect(isRisingWaveConfigured()).toBe(true);
  });

  it('resolveRisingWaveTarget throws the honest 503 when unset', () => {
    expect(() => resolveRisingWaveTarget()).toThrowError(RisingWaveError);
  });

  it('parses host:port, a bare host, and a postgres:// URL', () => {
    process.env.LOOM_RISINGWAVE_URL = 'rw.internal:4570';
    expect(resolveRisingWaveTarget()).toMatchObject({ host: 'rw.internal', port: 4570, database: 'dev', user: 'root' });

    process.env.LOOM_RISINGWAVE_URL = 'rw.internal';
    expect(resolveRisingWaveTarget()).toMatchObject({ host: 'rw.internal', port: 4566 });

    process.env.LOOM_RISINGWAVE_URL = 'postgres://svc@rw.internal:5432/prod';
    expect(resolveRisingWaveTarget()).toMatchObject({ host: 'rw.internal', port: 5432, user: 'svc', database: 'prod' });
  });
});

describe('read-only + DDL guards', () => {
  it('admits SELECT / SHOW / EXPLAIN and strips a trailing semicolon', () => {
    expect(assertReadOnlyStreamingSql('SELECT * FROM orders;')).toBe('SELECT * FROM orders');
    expect(assertReadOnlyStreamingSql('  SHOW MATERIALIZED VIEWS ')).toBe('SHOW MATERIALIZED VIEWS');
  });

  it('rejects a write / DDL on the read path and multi-statement scripts', () => {
    expect(() => assertReadOnlyStreamingSql('DROP MATERIALIZED VIEW v')).toThrowError(/read-only/);
    expect(() => assertReadOnlyStreamingSql('DELETE FROM orders')).toThrowError(/read-only/);
    expect(() => assertReadOnlyStreamingSql('SELECT 1; SELECT 2')).toThrowError(/single statement/);
  });

  it('accepts only streaming DDL on the Materialize path', () => {
    expect(assertStreamingDdl('CREATE MATERIALIZED VIEW v AS SELECT 1;')).toMatch(/^CREATE MATERIALIZED VIEW/);
    expect(assertStreamingDdl('DROP SINK s')).toBe('DROP SINK s');
    expect(() => assertStreamingDdl('GRANT ALL ON x TO y')).toThrowError(/only CREATE\/DROP/);
    expect(() => assertStreamingDdl('UPDATE orders SET x = 1')).toThrowError(RisingWaveError);
  });
});

describe('MV-DDL builder — two-stream join (headline acceptance)', () => {
  it('produces a well-formed CREATE MATERIALIZED VIEW joining two streams', () => {
    const sql = buildTwoStreamJoinMvSql({
      name: 'orders_enriched',
      left: 'orders',
      right: 'customers',
      leftKey: 'customer_id',
      rightKey: 'customer_id',
      selectColumns: ['orders.order_id', 'customers.name'],
    });
    // Structural well-formedness: the shape RisingWave maintains incrementally.
    expect(sql).toMatch(/^CREATE MATERIALIZED VIEW "orders_enriched" AS/);
    expect(sql).toContain('FROM "orders"');
    expect(sql).toContain('JOIN "customers"');
    expect(sql).toContain('ON "orders"."customer_id" = "customers"."customer_id"');
    expect(sql).toContain('"orders"."order_id"');
    expect(sql.trim().endsWith(';')).toBe(true);
    // Balanced: exactly one SELECT / FROM / JOIN / ON.
    expect((sql.match(/\bJOIN\b/g) || []).length).toBe(1);
    expect((sql.match(/\bON\b/g) || []).length).toBe(1);
  });

  it('defaults to SELECT * when no columns are given', () => {
    const sql = buildTwoStreamJoinMvSql({ name: 'j', left: 'a', right: 'b', leftKey: 'k', rightKey: 'k' });
    expect(sql).toContain('SELECT *');
  });

  it('rejects an injection attempt in an identifier', () => {
    expect(() => buildTwoStreamJoinMvSql({ name: 'v"; DROP TABLE x; --', left: 'a', right: 'b', leftKey: 'k', rightKey: 'k' }))
      .toThrowError(/not a valid/);
  });

  it('buildMaterializedViewSql refuses a non-SELECT body', () => {
    expect(() => buildMaterializedViewSql({ name: 'v', selectSql: 'DELETE FROM x' })).toThrowError(RisingWaveError);
    expect(buildMaterializedViewSql({ name: 'v', selectSql: 'SELECT 1 AS n' })).toMatch(/CREATE MATERIALIZED VIEW "v" AS/);
  });
});

describe('Event Hubs Kafka source builder', () => {
  it('targets the namespace Kafka endpoint on :9093 with SASL when a connection string is given', () => {
    const sql = buildEventHubKafkaSourceSql({
      name: 'orders',
      namespace: 'loomhub',
      eventHub: 'orders',
      columns: [{ name: 'order_id', type: 'varchar' }, { name: 'amount', type: 'double' }],
      auth: { mode: 'sasl', connectionString: 'Endpoint=sb://loomhub...;SharedAccessKey=abc' },
    }, 'servicebus.windows.net');
    expect(sql).toMatch(/^CREATE SOURCE "orders"/);
    expect(sql).toContain("connector = 'kafka'");
    expect(sql).toContain("properties.bootstrap.server = 'loomhub.servicebus.windows.net:9093'");
    expect(sql).toContain("properties.security.protocol = 'SASL_SSL'");
    expect(sql).toContain("properties.sasl.username = '$ConnectionString'");
    // The connection string is safely quoted, never bare-concatenated.
    expect(sql).toContain("properties.sasl.password = 'Endpoint=sb://loomhub...;SharedAccessKey=abc'");
    expect(sql).toContain('FORMAT PLAIN ENCODE JSON');
  });

  it('rejects a bad event hub / column type', () => {
    expect(() => buildEventHubKafkaSourceSql({ name: 'x', namespace: 'ns', eventHub: 'bad topic!', columns: [{ name: 'a', type: 'int' }] }))
      .toThrowError(/valid Event Hub/);
    expect(() => buildEventHubKafkaSourceSql({ name: 'x', namespace: 'ns', eventHub: 'ok', columns: [{ name: 'a', type: 'int); DROP' }] }))
      .toThrowError(/valid column type/);
  });

  it('eventHubKafkaBootstrap reflects the pinned namespace (or null)', () => {
    expect(eventHubKafkaBootstrap()).toBeNull();
    process.env.LOOM_EVENTHUB_NAMESPACE = 'loomhub';
    expect(eventHubKafkaBootstrap()).toBe('loomhub.servicebus.windows.net:9093');
  });
});

describe('lake sink builder', () => {
  it('writes an abfss Delta location off the deployment lake account', () => {
    const sql = buildLakeSinkSql({
      name: 'orders_sink', from: 'orders_enriched', format: 'delta',
      container: 'gold', path: 'streaming/orders', account: 'stloom',
    }, 'dfs.core.windows.net');
    expect(sql).toMatch(/^CREATE SINK "orders_sink"/);
    expect(sql).toContain('FROM "orders_enriched"');
    expect(sql).toContain("connector = 'deltalake'");
    expect(sql).toContain("location = 'abfss://gold@stloom.dfs.core.windows.net/streaming/orders'");
  });

  it('uses the iceberg connector for iceberg sinks and rejects a bad container', () => {
    const sql = buildLakeSinkSql({ name: 's', from: 'v', format: 'iceberg', container: 'gold', path: 'p', account: 'a' }, 'dfs.core.windows.net');
    expect(sql).toContain("connector = 'iceberg'");
    expect(() => buildLakeSinkSql({ name: 's', from: 'v', format: 'delta', container: 'BAD_CONTAINER', path: 'p', account: 'a' }))
      .toThrowError(/valid storage container/);
  });
});

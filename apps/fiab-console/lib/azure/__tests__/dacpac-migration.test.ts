/**
 * Tests for the SQL DB migration assistant core: the dependency-free ZIP reader
 * + DACPAC model parser + Synapse-Dedicated compatibility assessor + DDL
 * generator. Builds a real PKZIP archive in-memory (zlib deflateRaw) carrying a
 * minimal SSDT-format model.xml, then exercises the full pipeline — no Azure.
 */
import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { readZipEntries, readZipTextEntry, ZipError } from '../zip-reader';
import { parseDacpac, assessModel, assessDacpac, buildDdlPlan } from '../dacpac-migration';

/** Build a single-entry ZIP (deflate, method 8) the way SqlPackage emits one. */
function buildZip(entries: { name: string; content: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.content, 'utf8');
    const compressed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(8, 8); // method = deflate
    lfh.writeUInt16LE(0, 10); // time
    lfh.writeUInt16LE(0, 12); // date
    lfh.writeUInt32LE(crc >>> 0, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra len
    const localEntry = Buffer.concat([lfh, nameBuf, compressed]);
    localParts.push(localEntry);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc >>> 0, 16);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([cdh, nameBuf]));

    offset += localEntry.length;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// Minimal CRC32 fallback for Node versions without zlib.crc32.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

const MODEL_XML = `<?xml version="1.0" encoding="utf-8"?>
<DataSchemaModel Name="SalesDb">
  <Model>
    <Element Type="SqlSchema" Name="[sales]" />
    <Element Type="SqlTable" Name="[sales].[Orders]">
      <Relationship Name="Columns">
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[sales].[Orders].[OrderId]">
            <Property Name="IsIdentity" Value="True" />
            <Property Name="IsNullable" Value="False" />
            <Relationship Name="TypeSpecifier">
              <Entry>
                <Element Type="SqlTypeSpecifier">
                  <Relationship Name="Type"><Entry><References Name="[int]" /></Entry></Relationship>
                </Element>
              </Entry>
            </Relationship>
          </Element>
        </Entry>
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[sales].[Orders].[Notes]">
            <Property Name="IsNullable" Value="True" />
            <Relationship Name="TypeSpecifier">
              <Entry>
                <Element Type="SqlTypeSpecifier">
                  <Property Name="IsMax" Value="True" />
                  <Relationship Name="Type"><Entry><References Name="[nvarchar]" /></Entry></Relationship>
                </Element>
              </Entry>
            </Relationship>
          </Element>
        </Entry>
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[sales].[Orders].[GeoTag]">
            <Property Name="IsNullable" Value="True" />
            <Relationship Name="TypeSpecifier">
              <Entry>
                <Element Type="SqlTypeSpecifier">
                  <Relationship Name="Type"><Entry><References Name="[geography]" /></Entry></Relationship>
                </Element>
              </Entry>
            </Relationship>
          </Element>
        </Entry>
      </Relationship>
    </Element>
    <Element Type="SqlView" Name="[sales].[vOrders]">
      <Property Name="QueryScript">CREATE VIEW [sales].[vOrders] AS SELECT OrderId FROM sales.Orders FOR XML AUTO</Property>
    </Element>
    <Element Type="SqlProcedure" Name="[dbo].[GetOrders]">
      <Property Name="BodyScript">CREATE PROCEDURE [dbo].[GetOrders] AS SELECT * FROM sales.Orders;</Property>
    </Element>
    <Element Type="SqlForeignKeyConstraint" Name="[sales].[FK_Orders_Customers]" />
  </Model>
</DataSchemaModel>`;

describe('zip-reader', () => {
  it('reads a deflate ZIP entry round-trip', () => {
    const zip = buildZip([{ name: 'model.xml', content: MODEL_XML }]);
    const entries = readZipEntries(zip);
    expect(entries.has('model.xml')).toBe(true);
    expect(entries.get('model.xml')!.toString('utf8')).toContain('SalesDb');
  });

  it('resolves entries case-insensitively by leaf', () => {
    const zip = buildZip([{ name: 'Model.xml', content: '<x/>' }]);
    expect(readZipTextEntry(zip, 'model.xml')).toContain('<x');
  });

  it('throws ZipError on a non-zip buffer', () => {
    expect(() => readZipEntries(Buffer.from('not a zip at all'))).toThrow(ZipError);
  });
});

describe('parseDacpac', () => {
  it('parses schemas, tables, columns and scripted objects', () => {
    const zip = buildZip([{ name: 'model.xml', content: MODEL_XML }]);
    const model = parseDacpac(zip);
    expect(model.databaseName).toBe('SalesDb');
    expect(model.schemas).toContain('sales');

    const orders = model.tables.find((t) => t.name === 'Orders');
    expect(orders).toBeTruthy();
    expect(orders!.schema).toBe('sales');
    expect(orders!.columns.map((c) => c.name)).toEqual(['OrderId', 'Notes', 'GeoTag']);

    const orderId = orders!.columns[0];
    expect(orderId.baseType).toBe('int');
    expect(orderId.isIdentity).toBe(true);
    expect(orderId.nullable).toBe(false);

    const notes = orders!.columns[1];
    expect(notes.baseType).toBe('nvarchar');
    expect(notes.dataType).toBe('[nvarchar](max)');

    expect(model.scripted.map((s) => s.name).sort()).toEqual(['GetOrders', 'vOrders']);
    expect(model.constraints.length).toBe(1);
  });

  it('throws DacpacError when model.xml is missing', () => {
    const zip = buildZip([{ name: 'Origin.xml', content: '<x/>' }]);
    expect(() => parseDacpac(zip)).toThrow(/model\.xml/);
  });
});

describe('assessModel', () => {
  it('flags unsupported geography type as a blocker', () => {
    const zip = buildZip([{ name: 'model.xml', content: MODEL_XML }]);
    const model = parseDacpac(zip);
    const findings = assessModel(model);
    const geo = findings.find((f) => f.object.endsWith('GeoTag'));
    expect(geo).toBeTruthy();
    expect(geo!.severity).toBe('blocker');
    expect(geo!.rule).toBe('unsupported-type');
  });

  it('flags FOR XML in a view as a blocker and FK constraint as a warning', () => {
    const zip = buildZip([{ name: 'model.xml', content: MODEL_XML }]);
    const { findings } = assessDacpac(zip);
    expect(findings.some((f) => f.rule === 'for-xml' && f.severity === 'blocker')).toBe(true);
    expect(findings.some((f) => f.rule === 'constraint' && f.severity === 'warning')).toBe(true);
  });
});

describe('buildDdlPlan', () => {
  it('generates ordered idempotent DDL and skips blocked objects/columns', () => {
    const zip = buildZip([{ name: 'model.xml', content: MODEL_XML }]);
    const model = parseDacpac(zip);
    const findings = assessModel(model);
    const plan = buildDdlPlan(model, findings);

    const kinds = plan.statements.map((s) => s.kind);
    // Schema before table before scripted objects.
    expect(kinds.indexOf('schema')).toBeLessThan(kinds.indexOf('table'));

    const tableStmt = plan.statements.find((s) => s.kind === 'table' && s.object === 'sales.Orders');
    expect(tableStmt).toBeTruthy();
    expect(tableStmt!.sql).toContain('CREATE TABLE [sales].[Orders]');
    expect(tableStmt!.sql).toContain('IDENTITY(1,1)');
    // GeoTag (geography) is a blocker → excluded from the column list.
    expect(tableStmt!.sql).not.toContain('[GeoTag]');
    expect(tableStmt!.sql).toContain('DISTRIBUTION = ROUND_ROBIN');

    // The FOR XML view is blocked → emitted as a skipped, commented statement.
    const view = plan.statements.find((s) => s.object === 'sales.vOrders');
    expect(view!.skipped).toBe(true);

    // The clean procedure is replayed as CREATE OR ALTER.
    const proc = plan.statements.find((s) => s.object === 'dbo.GetOrders');
    expect(proc!.sql).toContain('CREATE OR ALTER PROCEDURE');
  });
});

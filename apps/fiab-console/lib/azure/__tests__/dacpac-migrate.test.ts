/**
 * dacpac-migrate tests — build a real DACPAC in-process (PKZIP via writeZip)
 * with a model.xml that exercises supported + unsupported dedicated-pool
 * features, then parse / scan / generate DDL. No Azure calls (deployToSynapse is
 * not exercised here — the TDS client is stubbed at the synapse layer elsewhere).
 */
import { describe, it, expect, vi } from 'vitest';

// dacpac-migrate transitively imports synapse-sql-client → @azure/identity.
// Stub the credential chain so the import never reaches the real SDK (pnpm
// symlink paths don't resolve under the worktree junction).
vi.mock('@azure/identity', async () => {
  class Cred {
    async getToken() {
      return { token: 'test-token', expiresOnTimestamp: Date.now() + 3600_000 };
    }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
// mssql pulls in tedious → @azure/identity → tslib, which doesn't resolve under
// the worktree's junctioned pnpm store. The parse/scan/generate functions under
// test never touch the TDS path, so a stub is sufficient.
vi.mock('mssql', async () => ({
  default: { NVarChar: () => ({}), MAX: 'max', ConnectionPool: class {}, Request: class {} },
  NVarChar: () => ({}),
  MAX: 'max',
  ConnectionPool: class {},
  Request: class {},
}));

import { writeZip } from '../zip';
import {
  parseDacpac,
  parseDacpacWithBodies,
  scanCompatibility,
  generateDeployScript,
  friendlyName,
} from '../dacpac-migrate';

/** A representative DacFx model.xml fragment. */
const MODEL_XML = `<?xml version="1.0" encoding="utf-8"?>
<DataSchemaModel>
  <Model>
    <Element Type="SqlSchema" Name="[sales]" />
    <Element Type="SqlTable" Name="[dbo].[Orders]">
      <Relationship Name="Columns">
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[dbo].[Orders].[Id]">
            <Relationship Name="TypeSpecifier"><Entry><Element Type="SqlTypeSpecifier">
              <Relationship Name="Type"><Entry><References Name="[int]" /></Entry></Relationship>
            </Element></Entry></Relationship>
          </Element>
        </Entry>
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[dbo].[Orders].[Geo]">
            <Relationship Name="TypeSpecifier"><Entry><Element Type="SqlTypeSpecifier">
              <Relationship Name="Type"><Entry><References Name="[geometry]" /></Entry></Relationship>
            </Element></Entry></Relationship>
          </Element>
        </Entry>
        <Entry>
          <Element Type="SqlComputedColumn" Name="[dbo].[Orders].[Total]" />
        </Entry>
      </Relationship>
    </Element>
    <Element Type="SqlTable" Name="[sales].[Region]">
      <Relationship Name="Columns">
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[sales].[Region].[Code]">
            <Relationship Name="TypeSpecifier"><Entry><Element Type="SqlTypeSpecifier">
              <Relationship Name="Type"><Entry><References Name="[nvarchar]" /></Entry></Relationship>
            </Element></Entry></Relationship>
          </Element>
        </Entry>
      </Relationship>
    </Element>
    <Element Type="SqlForeignKeyConstraint" Name="[dbo].[FK_Orders_Region]" />
    <Element Type="SqlDmlTrigger" Name="[dbo].[trg_Orders]" />
    <Element Type="SqlSequence" Name="[dbo].[OrderSeq]" />
    <Element Type="SqlView" Name="[dbo].[vOrders]">
      <Property Name="QueryScript"><![CDATA[CREATE VIEW dbo.vOrders AS SELECT Id FROM dbo.Orders]]></Property>
    </Element>
    <Element Type="SqlProcedure" Name="[dbo].[GetOrders]">
      <Property Name="BodyScript"><![CDATA[CREATE PROCEDURE dbo.GetOrders AS SELECT * FROM dbo.Orders]]></Property>
    </Element>
  </Model>
</DataSchemaModel>`;

const METADATA_XML = `<?xml version="1.0"?>
<DacType><Name>SourceDb</Name><Version>1.2.0.0</Version><Description>Test source</Description></DacType>`;

function buildDacpac(): Buffer {
  return writeZip([
    { name: 'model.xml', data: Buffer.from(MODEL_XML, 'utf-8') },
    { name: 'DacMetadata.xml', data: Buffer.from(METADATA_XML, 'utf-8') },
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf-8') },
  ]);
}

describe('friendlyName', () => {
  it('unwraps bracketed model names', () => {
    expect(friendlyName('[dbo].[Orders]')).toBe('dbo.Orders');
    expect(friendlyName('[dbo].[Orders].[Id]')).toBe('dbo.Orders.Id');
    expect(friendlyName('plain')).toBe('plain');
  });
});

describe('parseDacpac', () => {
  it('enumerates objects, columns and metadata from a real zipped DACPAC', () => {
    const parsed = parseDacpac(buildDacpac());
    expect(parsed.metadata.name).toBe('SourceDb');
    expect(parsed.metadata.version).toBe('1.2.0.0');
    expect(parsed.counts['SqlTable']).toBe(2);
    expect(parsed.counts['SqlView']).toBe(1);
    expect(parsed.counts['SqlProcedure']).toBe(1);
    expect(parsed.counts['SqlForeignKeyConstraint']).toBe(1);
    // Columns flattened: Orders(Id, Geo, Total) + Region(Code) = 4 total.
    expect(parsed.columns.length).toBe(4);
    const geo = parsed.columns.find((c) => c.name === 'Geo');
    expect(geo?.dataType).toBe('geometry');
    const computed = parsed.columns.find((c) => c.name === 'Total');
    expect(computed?.computed).toBe(true);
  });

  it('rejects non-zip bytes with a descriptive error', () => {
    expect(() => parseDacpac(Buffer.from('not a zip'))).toThrow(/dacpac/i);
  });

  it('rejects a zip without model.xml', () => {
    const bad = writeZip([{ name: 'other.xml', data: Buffer.from('<x/>') }]);
    expect(() => parseDacpac(bad)).toThrow(/model\.xml/i);
  });
});

describe('scanCompatibility', () => {
  it('flags FK / trigger / sequence / computed / geometry with remediations', () => {
    const report = scanCompatibility(parseDacpac(buildDacpac()));
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain('foreign-key');
    expect(rules).toContain('unsupported-object:SqlDmlTrigger');
    expect(rules).toContain('unsupported-object:SqlSequence');
    expect(rules).toContain('computed-column');
    expect(rules).toContain('unsupported-type:geometry');
    // All unsupported items are auto-remediated (dropped/remapped) → deployable.
    expect(report.deployable).toBe(true);
    expect(report.blockers).toBe(0);
    expect(report.warnings).toBeGreaterThan(0);
    // Every finding carries a remediation string.
    for (const f of report.findings) expect(f.remediation.length).toBeGreaterThan(0);
  });
});

describe('generateDeployScript', () => {
  it('emits dedicated-pool CREATE TABLE with distribution + index and remaps types', () => {
    const parsed = parseDacpacWithBodies(buildDacpac());
    const gen = generateDeployScript(parsed, { distribution: 'ROUND_ROBIN' });
    // Schema sales created (dbo skipped).
    expect(gen.script).toMatch(/CREATE SCHEMA \[sales\]/);
    expect(gen.script).not.toMatch(/CREATE SCHEMA \[dbo\]/);
    // Orders table created with distribution + CCI.
    expect(gen.script).toMatch(/CREATE TABLE \[dbo\]\.\[Orders\]/);
    expect(gen.script).toMatch(/DISTRIBUTION = ROUND_ROBIN/);
    expect(gen.script).toMatch(/CLUSTERED COLUMNSTORE INDEX/);
    // geometry remapped to varbinary(max); computed column NOT emitted.
    expect(gen.script).toMatch(/\[Geo\] varbinary\(max\)/);
    expect(gen.script).not.toMatch(/\[Total\]/);
    // View + procedure bodies emitted from recovered scripts.
    expect(gen.script).toMatch(/CREATE VIEW dbo\.vOrders/);
    expect(gen.script).toMatch(/CREATE PROCEDURE dbo\.GetOrders/);
    // FK / trigger / sequence never appear in the DDL.
    expect(gen.script).not.toMatch(/FOREIGN KEY|TRIGGER|SEQUENCE/i);
  });

  it('honors HEAP + idempotent guards', () => {
    const parsed = parseDacpacWithBodies(buildDacpac());
    const gen = generateDeployScript(parsed, { index: 'HEAP', ifNotExists: true });
    expect(gen.script).toMatch(/HEAP/);
    expect(gen.script).toMatch(/IF OBJECT_ID\('\[dbo\]\.\[Orders\]'\) IS NULL/);
  });
});

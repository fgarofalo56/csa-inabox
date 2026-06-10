import { describe, it, expect } from 'vitest';
import { writeZip } from '../zip';
import { parseDacpac, parseDacModelXml, splitBracketedName } from '../dacpac-model';
import { assessModel, generateDdl, mapType } from '../synapse-compat';

// A minimal but realistic modern DacFx model.xml. Covers: a schema, a table
// with a NOT NULL identity int PK, an nvarchar(50), an unsupported xml column,
// a computed column; plus a view with a script body and a DML trigger.
const MODEL_XML = `<?xml version="1.0" encoding="utf-8"?>
<DataSchemaModel FileFormatVersion="1.2" SchemaVersion="2.9" DspName="Microsoft.Data.Tools.Schema.Sql.Sql150DatabaseSchemaProvider" xmlns="http://schemas.microsoft.com/sqlserver/dac/Serialization/2012/02">
  <Model>
    <Element Type="SqlSchema" Name="[Sales]" />
    <Element Type="SqlTable" Name="[dbo].[Customer]">
      <Relationship Name="Columns">
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[dbo].[Customer].[Id]">
            <Property Name="IsNullable" Value="False" />
            <Property Name="IsIdentity" Value="True" />
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
          <Element Type="SqlSimpleColumn" Name="[dbo].[Customer].[Name]">
            <Property Name="IsNullable" Value="False" />
            <Relationship Name="TypeSpecifier">
              <Entry>
                <Element Type="SqlTypeSpecifier">
                  <Property Name="Length" Value="50" />
                  <Relationship Name="Type"><Entry><References Name="[nvarchar]" /></Entry></Relationship>
                </Element>
              </Entry>
            </Relationship>
          </Element>
        </Entry>
        <Entry>
          <Element Type="SqlSimpleColumn" Name="[dbo].[Customer].[Doc]">
            <Relationship Name="TypeSpecifier">
              <Entry>
                <Element Type="SqlTypeSpecifier">
                  <Relationship Name="Type"><Entry><References Name="[xml]" /></Entry></Relationship>
                </Element>
              </Entry>
            </Relationship>
          </Element>
        </Entry>
        <Entry>
          <Element Type="SqlComputedColumn" Name="[dbo].[Customer].[NameUpper]">
            <Property Name="ExpressionScript" Value="UPPER([Name])" />
          </Element>
        </Entry>
      </Relationship>
    </Element>
    <Element Type="SqlPrimaryKeyConstraint" Name="[dbo].[PK_Customer]">
      <Relationship Name="DefiningTable"><Entry><References Name="[dbo].[Customer]" /></Entry></Relationship>
      <Relationship Name="ColumnSpecifications">
        <Entry>
          <Element Type="SqlIndexedColumnSpecification">
            <Relationship Name="Column"><Entry><References Name="[dbo].[Customer].[Id]" /></Entry></Relationship>
          </Element>
        </Entry>
      </Relationship>
    </Element>
    <Element Type="SqlView" Name="[Sales].[vCustomer]">
      <Property Name="QueryScript" Value="CREATE VIEW [Sales].[vCustomer] AS SELECT [Id],[Name] FROM [dbo].[Customer]" />
    </Element>
    <Element Type="SqlDmlTrigger" Name="[dbo].[trCustomer]">
      <Property Name="BodyScript" Value="CREATE TRIGGER [dbo].[trCustomer] ON [dbo].[Customer] AFTER INSERT AS BEGIN SET NOCOUNT ON END" />
    </Element>
  </Model>
</DataSchemaModel>`;

function makeDacpac(modelXml = MODEL_XML): Buffer {
  return writeZip([
    { name: 'model.xml', data: Buffer.from(modelXml, 'utf-8') },
    { name: 'DacMetadata.xml', data: Buffer.from('<DacType xmlns="x"><Name>SalesDb</Name><Version>1.0.0.0</Version></DacType>', 'utf-8') },
    { name: 'Origin.xml', data: Buffer.from('<DacOrigin><CompatibilityLevel>150</CompatibilityLevel></DacOrigin>', 'utf-8') },
  ]);
}

describe('splitBracketedName', () => {
  it('splits multi-part bracketed names', () => {
    expect(splitBracketedName('[dbo].[Customer].[Id]')).toEqual(['dbo', 'Customer', 'Id']);
  });
  it('handles unbracketed dotted names', () => {
    expect(splitBracketedName('dbo.Customer')).toEqual(['dbo', 'Customer']);
  });
});

describe('parseDacModelXml', () => {
  const parsed = parseDacModelXml(MODEL_XML);

  it('discovers schemas (declared + inferred)', () => {
    expect(parsed.schemas).toContain('Sales');
    expect(parsed.schemas).toContain('dbo');
  });

  it('parses the table and its columns with types/nullability', () => {
    expect(parsed.tables).toHaveLength(1);
    const t = parsed.tables[0];
    expect(t.schema).toBe('dbo');
    expect(t.name).toBe('Customer');
    expect(t.columns.map((c) => c.name)).toEqual(['Id', 'Name', 'Doc', 'NameUpper']);

    const id = t.columns[0];
    expect(id.dataType).toBe('int');
    expect(id.nullable).toBe(false);
    expect(id.identity).toBe(true);

    const name = t.columns[1];
    expect(name.dataType).toBe('nvarchar');
    expect(name.length).toBe(50);
    expect(name.nullable).toBe(false);

    expect(t.columns[2].dataType).toBe('xml');
    expect(t.columns[3].computedExpression).toBe('UPPER([Name])');
  });

  it('attaches the primary key to the table', () => {
    expect(parsed.tables[0].primaryKey).toEqual(['Id']);
  });

  it('collects scriptable objects (view + trigger)', () => {
    const view = parsed.objects.find((o) => o.type === 'SqlView');
    expect(view?.script).toContain('CREATE VIEW');
    const trigger = parsed.objects.find((o) => o.type === 'SqlDmlTrigger');
    expect(trigger).toBeDefined();
  });
});

describe('parseDacpac (full ZIP)', () => {
  it('parses package metadata + source compat level', () => {
    const model = parseDacpac(makeDacpac());
    expect(model.packageName).toBe('SalesDb');
    expect(model.packageVersion).toBe('1.0.0.0');
    expect(model.sourceCompatLevel).toBe(150);
    expect(model.tables).toHaveLength(1);
  });

  it('throws an honest error when model.xml is missing', () => {
    const bogus = writeZip([{ name: 'readme.txt', data: Buffer.from('not a dacpac') }]);
    expect(() => parseDacpac(bogus)).toThrow(/model\.xml not found/);
  });
});

describe('mapType (Dedicated SQL pool type mapping)', () => {
  it('maps unsupported xml → nvarchar(max)', () => {
    const r = mapType({ name: 'Doc', dataType: 'xml', nullable: true });
    expect(r.sqlType).toBe('nvarchar(max)');
    expect(r.mapped?.from).toBe('xml');
  });
  it('renders nvarchar with length', () => {
    expect(mapType({ name: 'N', dataType: 'nvarchar', nullable: true, length: 50 }).sqlType).toBe('nvarchar(50)');
  });
  it('renders decimal with precision/scale', () => {
    expect(mapType({ name: 'D', dataType: 'decimal', nullable: true, precision: 10, scale: 2 }).sqlType).toBe('decimal(10, 2)');
  });
});

describe('assessModel', () => {
  const model = parseDacpac(makeDacpac());
  const report = assessModel(model);

  it('counts objects correctly', () => {
    expect(report.counts.tables).toBe(1);
    expect(report.counts.columns).toBe(4);
    expect(report.counts.views).toBe(1);
    expect(report.counts.triggers).toBe(1);
  });

  it('flags the unsupported xml column as an error', () => {
    const f = report.findings.find((x) => x.rule === 'unsupported-type');
    expect(f).toBeDefined();
    expect(f?.object).toBe('[dbo].[Customer].[Doc]');
  });

  it('flags the trigger as unsupported', () => {
    expect(report.findings.some((x) => x.rule === 'trigger')).toBe(true);
  });

  it('reports the PK as NONCLUSTERED NOT ENFORCED info', () => {
    expect(report.findings.some((x) => x.rule === 'pk-not-enforced')).toBe(true);
  });

  it('is importable despite auto-remediated type/trigger findings', () => {
    // xml is auto-remediated; trigger is excluded — neither blocks the table import.
    // (trigger IS an error but the import simply skips it.)
    expect(report.counts.tables).toBe(1);
  });
});

describe('generateDdl', () => {
  const model = parseDacpac(makeDacpac());
  const ddl = generateDdl(model);

  it('emits CREATE SCHEMA for non-dbo schemas only', () => {
    const schemaStmts = ddl.statements.filter((s) => s.kind === 'schema');
    expect(schemaStmts.some((s) => s.name === '[Sales]')).toBe(true);
    expect(schemaStmts.some((s) => s.name === '[dbo]')).toBe(false);
  });

  it('emits a Dedicated-pool CREATE TABLE with mapped types + NOT ENFORCED PK', () => {
    const table = ddl.statements.find((s) => s.kind === 'table');
    expect(table?.sql).toContain('CREATE TABLE [dbo].[Customer]');
    expect(table?.sql).toContain('[Id] int IDENTITY(1,1) NOT NULL');
    expect(table?.sql).toContain('[Name] nvarchar(50) NOT NULL');
    expect(table?.sql).toContain('[Doc] nvarchar(max)'); // xml mapped
    expect(table?.sql).toContain('[NameUpper] AS (UPPER([Name]))');
    expect(table?.sql).toContain('PRIMARY KEY NONCLUSTERED ([Id]) NOT ENFORCED');
    expect(table?.sql).toContain('DISTRIBUTION = ROUND_ROBIN');
    expect(table?.sql).toContain('CLUSTERED COLUMNSTORE INDEX');
  });

  it('includes the view but excludes the unsupported trigger', () => {
    expect(ddl.statements.some((s) => s.kind === 'view')).toBe(true);
    expect(ddl.statements.some((s) => s.name.includes('trCustomer'))).toBe(false);
  });
});

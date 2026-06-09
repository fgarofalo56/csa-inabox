import { describe, it, expect } from 'vitest';
import {
  parseRdlMetadata, extractParams, extractDataSources, extractDataSets,
  resolveParamValues, buildSections, paginateSections, RdlRenderError,
  type RdlSection,
} from '../rdl-parse';
import { parseXml, type XmlObject } from '../rdl-xml';

const RDL_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition">
  <Description>Sales by State</Description>
  <DataSources>
    <DataSource Name="LoomSynapse">
      <ConnectionProperties>
        <DataProvider>SQL</DataProvider>
        <ConnectString>Data Source=loom-ondemand.sql.azuresynapse.net</ConnectString>
      </ConnectionProperties>
    </DataSource>
  </DataSources>
  <DataSets>
    <DataSet Name="Sales">
      <Query>
        <DataSourceName>LoomSynapse</DataSourceName>
        <CommandText>SELECT State, Amount FROM dbo.Sales WHERE State = @State</CommandText>
      </Query>
    </DataSet>
  </DataSets>
  <ReportParameters>
    <ReportParameter Name="State">
      <DataType>String</DataType>
      <Prompt>Pick a state</Prompt>
      <DefaultValue><Values><Value>WA</Value></Values></DefaultValue>
      <ValidValues><ParameterValues>
        <ParameterValue><Label>Washington</Label><Value>WA</Value></ParameterValue>
        <ParameterValue><Label>Oregon</Label><Value>OR</Value></ParameterValue>
      </ParameterValues></ValidValues>
    </ReportParameter>
  </ReportParameters>
  <Body>
    <ReportItems>
      <Tablix Name="SalesTablix"><DataSetName>Sales</DataSetName></Tablix>
    </ReportItems>
  </Body>
</Report>`;

function report(): XmlObject {
  return parseXml(RDL_FIXTURE).Report as XmlObject;
}

describe('paginated-report-renderer — parseRdlMetadata', () => {
  it('parses params + dataset count from a valid RDL', () => {
    const m = parseRdlMetadata(RDL_FIXTURE);
    expect(m.params).toHaveLength(1);
    expect(m.datasetCount).toBe(1);
    expect(m.report.Body).toBeDefined();
  });
  it('throws RdlRenderError on a non-RDL document', () => {
    expect(() => parseRdlMetadata('<NotAReport/>')).toThrow(RdlRenderError);
  });
});

describe('paginated-report-renderer — extractors', () => {
  it('extractParams reads type, prompt, default, valid values', () => {
    const [p] = extractParams(report());
    expect(p.name).toBe('State');
    expect(p.dataType).toBe('String');
    expect(p.prompt).toBe('Pick a state');
    expect(p.defaultValue).toEqual(['WA']);
    expect(p.validValues).toEqual([
      { label: 'Washington', value: 'WA' },
      { label: 'Oregon', value: 'OR' },
    ]);
  });

  it('extractDataSources reads provider + connect string', () => {
    const ds = extractDataSources(report()).get('LoomSynapse');
    expect(ds?.extension).toBe('SQL');
    expect(ds?.connectionString).toContain('azuresynapse');
  });

  it('extractDataSets reads source name + command text', () => {
    const ds = extractDataSets(report()).get('Sales');
    expect(ds?.dataSourceName).toBe('LoomSynapse');
    expect(ds?.commandText).toContain('@State');
  });
});

describe('paginated-report-renderer — resolveParamValues', () => {
  const specs = extractParams(report());
  it('uses the user value when supplied', () => {
    expect(resolveParamValues(specs, { State: ['OR'] })).toEqual([{ name: 'State', value: 'OR' }]);
  });
  it('falls back to the RDL default when not supplied', () => {
    expect(resolveParamValues(specs, {})).toEqual([{ name: 'State', value: 'WA' }]);
  });
});

describe('paginated-report-renderer — buildSections + pagination', () => {
  it('binds a tablix section to its dataset result rows', () => {
    const datasets = new Map([['Sales', { columns: ['State', 'Amount'], rows: [['WA', 10], ['WA', 20]] }]]);
    const sections = buildSections(report(), datasets);
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe('tablix');
    expect(sections[0].columns.map((c) => c.header)).toEqual(['State', 'Amount']);
    expect(sections[0].rows.map((r) => r.cells)).toEqual([['WA', 10], ['WA', 20]]);
    expect(sections[0].totalRows).toBe(2);
  });

  it('paginates 120 rows into 3 pages of 50', () => {
    const sec: RdlSection = {
      kind: 'tablix', name: 'T', dataSetName: 'Sales',
      columns: [{ header: 'n' }],
      rows: Array.from({ length: 120 }, (_, i) => ({ cells: [i] })),
      totalRows: 120,
    };
    const pages = paginateSections([sec], 50);
    expect(pages).toHaveLength(3);
    expect(pages[0].sections[0].rows).toHaveLength(50);
    expect(pages[2].sections[0].rows).toHaveLength(20);
    expect(pages[0].pageNumber).toBe(1);
  });

  it('always yields at least one page', () => {
    expect(paginateSections([], 50)).toHaveLength(1);
  });
});

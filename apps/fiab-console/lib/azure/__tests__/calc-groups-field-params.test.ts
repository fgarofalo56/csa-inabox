/**
 * Backend contract tests for the Calculation Groups + Field Parameters helpers:
 *   - buildCalcGroupTmsl    TMSL createOrReplace for a calculationGroup table
 *   - buildFieldParamTmsl   TMSL createOrReplace for a NAMEOF() calc table
 *   - buildFieldParamDax    the { ("Label", NAMEOF(...), n), ... } body
 *   - buildTmslExecuteEnvelope  SOAP/XMLA Execute envelope shape + escaping
 *   - executeTmsl           POSTs the envelope to the AAS XMLA HTTP endpoint
 *   - aas{XmlaHost,ServerName}  parse asazure:// URIs
 *   - aasAvailabilityGate   gov-cloud honest gate
 *   - getFabricModelDefinition / updateFabricModelDefinition  Fabric REST shape
 *
 * Stubs @azure/identity + global.fetch — no live tenant required. Per
 * no-vaporware, the tests exercise the real code path, not a mock of it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  buildCalcGroupTmsl,
  buildFieldParamTmsl,
  buildFieldParamDax,
  buildTmslExecuteEnvelope,
  executeTmsl,
  aasXmlaHost,
  aasServerName,
  aasAvailabilityGate,
  AasError,
} from '../aas-client';
import {
  getFabricModelDefinition,
  updateFabricModelDefinition,
  type TmslCalcGroup,
  type FieldParamDef,
} from '../powerbi-client';

const realFetch = global.fetch;
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const out = await handler(String(url), init);
    if (out instanceof Response) return out;
    const status = out?._status || 200;
    const text = typeof out === 'string' ? out : (out === undefined ? '' : JSON.stringify(out));
    return new Response(text, { status });
  }) as any;
}
afterEach(() => { global.fetch = realFetch; vi.unstubAllEnvs(); });

const SAMPLE_CG: TmslCalcGroup = {
  name: 'Time Intelligence',
  precedence: 10,
  items: [
    { name: 'Current', expression: 'SELECTEDMEASURE()' },
    { name: 'YTD', expression: "CALCULATE(SELECTEDMEASURE(), DATESYTD('Date'[Date]))", formatStringDefinition: 'SELECTEDMEASUREFORMATSTRING()', ordinal: 1 },
  ],
};

const SAMPLE_FP: FieldParamDef = {
  name: 'Metric Selector',
  fields: [
    { displayName: 'Total Sales', fieldRef: "'Sales'[Amount]", order: 0 },
    { displayName: 'Order Count', fieldRef: "'Sales'[OrderCount]", order: 1 },
  ],
};

describe('buildCalcGroupTmsl', () => {
  it('emits a createOrReplace with precedence, items, format string + the Name/Ordinal columns', () => {
    const tmsl = JSON.parse(buildCalcGroupTmsl('AdventureWorks', SAMPLE_CG));
    expect(tmsl.createOrReplace.object).toEqual({ database: 'AdventureWorks', table: 'Time Intelligence' });
    const t = tmsl.createOrReplace.table;
    expect(t.name).toBe('Time Intelligence');
    expect(t.calculationGroup.precedence).toBe(10);
    expect(t.calculationGroup.calculationItems).toHaveLength(2);
    expect(t.calculationGroup.calculationItems[0]).toMatchObject({ name: 'Current', expression: 'SELECTEDMEASURE()' });
    // Dynamic format string is wrapped in { expression }
    expect(t.calculationGroup.calculationItems[1].formatStringDefinition).toEqual({ expression: 'SELECTEDMEASUREFORMATSTRING()' });
    expect(t.calculationGroup.calculationItems[1].ordinal).toBe(1);
    // mandatory Name (string) + Ordinal (int64, hidden) columns
    const cols = t.columns;
    expect(cols[0]).toMatchObject({ name: 'Time Intelligence', dataType: 'string', sourceColumn: 'Name', sortByColumn: 'Ordinal' });
    expect(cols[1]).toMatchObject({ name: 'Ordinal', dataType: 'int64', isHidden: true });
    // calculationGroup partition source
    expect(t.partitions[0].source).toEqual({ type: 'calculationGroup' });
  });
});

describe('buildFieldParamDax', () => {
  it('builds the NAMEOF rows with escaped labels + order', () => {
    const dax = buildFieldParamDax(SAMPLE_FP);
    expect(dax).toContain('("Total Sales", NAMEOF(\'Sales\'[Amount]), 0)');
    expect(dax).toContain('("Order Count", NAMEOF(\'Sales\'[OrderCount]), 1)');
    expect(dax.trim().startsWith('{')).toBe(true);
    expect(dax.trim().endsWith('}')).toBe(true);
  });

  it('escapes double quotes in display names', () => {
    const dax = buildFieldParamDax({ name: 'P', fields: [{ displayName: 'Net "USD"', fieldRef: "'T'[C]", order: 0 }] });
    expect(dax).toContain('"Net ""USD"""');
  });
});

describe('buildFieldParamTmsl', () => {
  it('emits a calculated partition using NAMEOF + the 3 positional columns', () => {
    const tmsl = JSON.parse(buildFieldParamTmsl('AdventureWorks', SAMPLE_FP));
    const t = tmsl.createOrReplace.table;
    expect(t.name).toBe('Metric Selector');
    expect(t.partitions[0].source.type).toBe('calculated');
    expect(t.partitions[0].source.expression).toContain('NAMEOF(\'Sales\'[Amount])');
    expect(t.columns.map((c: any) => c.sourceColumn)).toEqual(['[Value1]', '[Value2]', '[Value3]']);
    expect(t.columns[1]).toMatchObject({ name: 'Fields', isHidden: true });
    expect(t.columns[2]).toMatchObject({ name: 'Order', isHidden: true });
    expect(t.annotations).toContainEqual({ name: 'PBI_ResultType', value: 'Table' });
  });
});

describe('buildTmslExecuteEnvelope', () => {
  it('wraps TMSL in a SOAP Execute envelope with Catalog + XML-escaped statement', () => {
    const env = buildTmslExecuteEnvelope('{"a":"<x> & \'y\'"}', 'DB1');
    expect(env).toContain('urn:schemas-microsoft-com:xml-analysis');
    expect(env).toContain('<Catalog>DB1</Catalog>');
    // statement angle brackets + ampersand escaped so the SOAP body stays valid
    expect(env).toContain('&lt;x&gt;');
    expect(env).toContain('&amp;');
    expect(env).not.toContain('<x>');
  });
});

describe('aas URI parsing', () => {
  it('extracts host + server from an asazure:// URI', () => {
    const uri = 'asazure://eastus2.asazure.windows.net/myserver';
    expect(aasXmlaHost(uri)).toBe('eastus2.asazure.windows.net');
    expect(aasServerName(uri)).toBe('myserver');
  });
});

describe('executeTmsl', () => {
  it('POSTs the SOAP envelope to the XMLA HTTP endpoint with the SOAPAction header', async () => {
    let url = ''; let method = ''; let headers: any; let body = '';
    mockFetch((u, init) => {
      url = u; method = (init?.method as string) || 'GET'; headers = init?.headers; body = String(init?.body || '');
      return '<Envelope><Body><ExecuteResponse><return><root/></return></ExecuteResponse></Body></Envelope>';
    });
    const out = await executeTmsl('asazure://eastus2.asazure.windows.net/myserver', 'DB1', '{"createOrReplace":{}}');
    expect(out).toEqual({ ok: true });
    expect(url).toBe('https://eastus2.asazure.windows.net/servers/myserver/');
    expect(method).toBe('POST');
    expect((headers as any).soapaction).toContain('Execute');
    expect(body).toContain('<Catalog>DB1</Catalog>');
  });

  it('throws AasError on a TMSL <Error> in a 200 SOAP response', async () => {
    mockFetch(() => '<Envelope><Body><Error><Description>bad TMSL</Description></Error></Body></Envelope>');
    await expect(executeTmsl('asazure://r.asazure.windows.net/s', 'DB', '{}')).rejects.toBeInstanceOf(AasError);
  });

  it('throws AasError on a non-2xx HTTP response', async () => {
    mockFetch(() => ({ _status: 403 }));
    await expect(executeTmsl('asazure://r.asazure.windows.net/s', 'DB', '{}')).rejects.toMatchObject({ status: 403 });
  });
});

describe('aasAvailabilityGate', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  it('returns null in Commercial (AAS available)', () => {
    vi.stubEnv('LOOM_CLOUD', 'Commercial');
    vi.stubEnv('AZURE_CLOUD', 'AzureCloud');
    expect(aasAvailabilityGate()).toBeNull();
  });
  it('returns a gate in GCC-High (AAS unavailable)', () => {
    vi.stubEnv('LOOM_CLOUD', 'GCC-High');
    const gate = aasAvailabilityGate();
    expect(gate?.unavailable).toBe(true);
    expect(gate?.cloud).toBe('GCC-High');
    expect(gate?.detail).toContain('Loom-native');
  });
});

describe('Fabric model definition (opt-in)', () => {
  it('getFabricModelDefinition POSTs getDefinition with format=TMSL on the Fabric base', async () => {
    let url = ''; let method = '';
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; return { definition: { parts: [] } }; });
    await getFabricModelDefinition('ws-1', 'model-9');
    expect(url).toContain('api.fabric.microsoft.com');
    expect(url).toContain('/workspaces/ws-1/semanticModels/model-9/getDefinition');
    expect(url).toContain('format=TMSL');
    expect(method).toBe('POST');
  });

  it('updateFabricModelDefinition POSTs updateDefinition wrapping parts in { definition: { parts } }', async () => {
    let url = ''; let method = ''; let body: any;
    mockFetch((u, init) => { url = u; method = (init?.method as string) || 'GET'; body = JSON.parse(String(init?.body || '{}')); return undefined; });
    const parts = [{ path: 'model.bim', payload: 'eyJ9', payloadType: 'InlineBase64' as const }];
    const out = await updateFabricModelDefinition('ws-1', 'model-9', parts);
    expect(out).toEqual({ ok: true });
    expect(url).toContain('/workspaces/ws-1/semanticModels/model-9/updateDefinition');
    expect(method).toBe('POST');
    expect(body.definition.parts).toEqual(parts);
  });
});

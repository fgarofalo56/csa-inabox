/**
 * Contract tests for the Azure Analysis Services DirectQuery binder client
 * (aas-client). Per .claude/rules/no-vaporware.md these assert the real shapes:
 *   - buildDqTmsl() emits a single DataSource ("LoomDQSource") + one
 *     DirectQuery partition per table (pure function — no mocks).
 *   - the SQL vs ADX connection protocol split (tds / kusto).
 *   - aasConfigGate() honest-gates on each missing env var.
 *   - command() shapes the XMLA Execute SOAP envelope and raises on a SOAP
 *     <Fault> — fetch + credential stubbed only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.AAS.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { buildDqTmsl, aasConfigGate, command, applyDqSource, AasError } from '../aas-client';

const AAS_ENV = ['LOOM_AAS_SERVER', 'LOOM_AAS_REGION', 'LOOM_AAS_MODEL', 'LOOM_CLOUD', 'AZURE_CLOUD'];
function clearEnv() { for (const k of AAS_ENV) delete process.env[k]; }
function setConfigured() {
  process.env.LOOM_AAS_SERVER = 'loom-aas';
  process.env.LOOM_AAS_REGION = 'eastus2';
  process.env.LOOM_AAS_MODEL = 'LoomModel';
}

beforeEach(clearEnv);
afterEach(clearEnv);

describe('buildDqTmsl — DirectQuery TMSL command sequence', () => {
  it('emits one DataSource (LoomDQSource) followed by one partition per table', () => {
    process.env.LOOM_AAS_MODEL = 'SalesModel';
    const cmds = buildDqTmsl('ws-ondemand.sql.azuresynapse.net', 'master', ['Orders', 'Customers'], 'synapse-serverless');
    expect(cmds).toHaveLength(3);
    const ds = (cmds[0] as any).createOrReplace.dataSource;
    expect(ds.name).toBe('LoomDQSource');
    expect(ds.connectionDetails.protocol).toBe('tds');
    expect(ds.connectionDetails.address.server).toBe('ws-ondemand.sql.azuresynapse.net');
    expect((cmds[0] as any).createOrReplace.parentObject.database).toBe('SalesModel');
  });

  it('sets every partition to directQuery / full / LoomDQSource with a SELECT source', () => {
    const cmds = buildDqTmsl('srv', 'db', ['Orders'], 'azure-sql');
    const p = (cmds[1] as any).createOrReplace.partition;
    expect(p.mode).toBe('directQuery');
    expect(p.dataView).toBe('full');
    expect(p.source.type).toBe('query');
    expect(p.source.dataSource).toBe('LoomDQSource');
    expect(p.source.query).toBe('SELECT * FROM [dbo].[Orders]');
  });

  it('uses the kusto protocol + native table reference for ADX sources', () => {
    const cmds = buildDqTmsl('adx.eastus2.kusto.windows.net', 'loomdb', ['Events'], 'adx');
    expect((cmds[0] as any).createOrReplace.dataSource.connectionDetails.protocol).toBe('kusto');
    expect((cmds[1] as any).createOrReplace.partition.source.query).toBe('Events');
  });
});

describe('aasConfigGate — honest gate per missing env var', () => {
  it('gates on LOOM_AAS_SERVER first', () => {
    expect(aasConfigGate()?.missing).toBe('LOOM_AAS_SERVER');
  });
  it('gates on LOOM_AAS_REGION when only server is set', () => {
    process.env.LOOM_AAS_SERVER = 'loom-aas';
    expect(aasConfigGate()?.missing).toBe('LOOM_AAS_REGION');
  });
  it('gates on LOOM_AAS_MODEL when server+region set', () => {
    process.env.LOOM_AAS_SERVER = 'loom-aas';
    process.env.LOOM_AAS_REGION = 'eastus2';
    expect(aasConfigGate()?.missing).toBe('LOOM_AAS_MODEL');
  });
  it('returns null when fully configured', () => {
    setConfigured();
    expect(aasConfigGate()).toBeNull();
  });
});

describe('command — XMLA Execute SOAP envelope', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('throws not_configured AasError when AAS env is missing (no fetch)', async () => {
    const spy = vi.fn();
    global.fetch = spy as any;
    await expect(command({ createOrReplace: {} })).rejects.toMatchObject({ code: 'not_configured', missing: 'LOOM_AAS_SERVER' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('POSTs the TMSL statement inside an XMLA Execute envelope to the gov-correct host', async () => {
    setConfigured();
    process.env.LOOM_CLOUD = 'GCC-High';
    let captured: { url: string; init: any } | null = null;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      captured = { url: String(url), init };
      return new Response('<return xmlns="urn:schemas-microsoft-com:xml-analysis"><root/></return>', { status: 200 });
    }) as any;

    await command({ createOrReplace: { parentObject: { database: 'LoomModel' } } });
    expect(captured!.url).toBe('https://eastus2.asazure.usgovcloudapi.net/servers/loom-aas/models/LoomModel/xmla');
    expect(captured!.init.headers.soapaction).toContain('Execute');
    expect(captured!.init.body).toContain('<Statement>');
    expect(captured!.init.body).toContain('<Catalog>LoomModel</Catalog>');
    // The TMSL JSON is XML-escaped inside <Statement>.
    expect(captured!.init.body).toContain('createOrReplace');
  });

  it('raises AasError on a SOAP fault', async () => {
    setConfigured();
    global.fetch = vi.fn(async () => new Response('<SOAP-ENV:Fault><faultstring>model not found</faultstring></SOAP-ENV:Fault>', { status: 200 })) as any;
    await expect(command({ createOrReplace: {} })).rejects.toBeInstanceOf(AasError);
  });
});

describe('applyDqSource — sends DataSource then partitions in order', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('issues one XMLA POST per TMSL command', async () => {
    setConfigured();
    const calls: string[] = [];
    global.fetch = vi.fn(async (_url: any, init?: any) => {
      calls.push(String(init?.body || ''));
      return new Response('<return/>', { status: 200 });
    }) as any;
    await applyDqSource({ sourceType: 'synapse-serverless', server: 'srv', database: 'master', tables: ['A', 'B'] });
    // 1 DataSource + 2 partitions = 3 commands.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('dataSource');
    expect(calls[1]).toContain('directQuery');
  });
});

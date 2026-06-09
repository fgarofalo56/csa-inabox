/**
 * aas-client unit tests — pure SOAP/TMSL builders + DAX validator + config
 * gate. No network, no Azure SDK calls (the credential chain is never reached
 * because every tested function is pure or env-only).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the credential chain so importing aas-client (which pulls @azure/identity)
// resolves under the vitest ESM/pnpm setup. None of the tested functions reach a
// real token request — they are pure builders / env-only.
vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
    ClientSecretCredential: Cred,
  };
});

import {
  buildExecuteEnvelope,
  buildDiscoverEnvelope,
  parseDiscoverRows,
  extractSoapFault,
  buildRoleTmsl,
  buildSetRolesTmsl,
  validateRlsDax,
  parseAasServer,
  resolveBackend,
  aasConfigGate,
  type AasRole,
} from '../aas-roles';

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});
beforeEach(() => {
  // Clean slate — remove every var the client reads.
  for (const k of [
    'LOOM_AAS_SERVER',
    'LOOM_AAS_DB',
    'LOOM_AAS_CLIENT_ID',
    'LOOM_AAS_CLIENT_SECRET',
    'LOOM_POWERBI_XMLA_ENDPOINT',
    'LOOM_CLOUD',
    'AZURE_CLOUD',
    'LOOM_CLOUD_BOUNDARY',
  ]) {
    delete process.env[k];
  }
});

describe('buildExecuteEnvelope', () => {
  it('embeds the TMSL statement + catalog and omits impersonation when not asked', () => {
    const env = buildExecuteEnvelope('{"refresh":{}}', 'MyDb');
    expect(env).toContain('<Statement>{&quot;refresh&quot;:{}}</Statement>');
    expect(env).toContain('<Catalog>MyDb</Catalog>');
    expect(env).not.toContain('<EffectiveUserName>');
    expect(env).not.toContain('<Roles>');
    expect(env).toContain('urn:schemas-microsoft-com:xml-analysis');
  });

  it('adds EffectiveUserName + Roles when impersonating', () => {
    const env = buildExecuteEnvelope('EVALUATE Sales', 'MyDb', {
      effectiveUserName: 'u@contoso.com',
      roles: 'Sales East',
    });
    expect(env).toContain('<EffectiveUserName>u@contoso.com</EffectiveUserName>');
    expect(env).toContain('<Roles>Sales East</Roles>');
  });
});

describe('buildDiscoverEnvelope', () => {
  it('emits the DMV request type and catalog', () => {
    const env = buildDiscoverEnvelope('TMSCHEMA_ROLES', 'MyDb');
    expect(env).toContain('<RequestType>TMSCHEMA_ROLES</RequestType>');
    expect(env).toContain('<Catalog>MyDb</Catalog>');
  });
});

describe('parseDiscoverRows', () => {
  it('extracts multiple rows with namespace-stripped keys', () => {
    const soap =
      '<root><row><ID>1</ID><Name>Sales</Name></row>' +
      '<row><ID>2</ID><Name>HR</Name></row></root>';
    const rows = parseDiscoverRows(soap);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ ID: '1', Name: 'Sales' });
    expect(rows[1].Name).toBe('HR');
  });
});

describe('extractSoapFault', () => {
  it('detects a SOAP faultstring', () => {
    const soap =
      '<Envelope><Body><Fault><faultstring>bad TMSL</faultstring></Fault></Body></Envelope>';
    expect(extractSoapFault(soap)).toBe('bad TMSL');
  });
  it('detects an inline AS Error Description', () => {
    const soap = '<return><Error ErrorCode="1" Description="Role exists" /></return>';
    expect(extractSoapFault(soap)).toBe('Role exists');
  });
  it('returns null for a clean response', () => {
    expect(extractSoapFault('<return><root/></return>')).toBeNull();
  });
});

describe('validateRlsDax', () => {
  it('accepts a static membership boolean', () => {
    expect(validateRlsDax('[Region] = "East"').ok).toBe(true);
  });
  it('accepts BLANK()', () => {
    expect(validateRlsDax('BLANK()').ok).toBe(true);
  });
  it('accepts a dynamic USERPRINCIPALNAME filter', () => {
    expect(validateRlsDax('USERPRINCIPALNAME() = [UserEmail]').ok).toBe(true);
  });
  it('rejects empty', () => {
    expect(validateRlsDax('').ok).toBe(false);
  });
  it('rejects a query-shaped expression', () => {
    expect(validateRlsDax('EVALUATE Sales').ok).toBe(false);
  });
  it('rejects a semicolon', () => {
    expect(validateRlsDax('[A]=1; [B]=2').ok).toBe(false);
  });
  it('rejects unbalanced parens', () => {
    expect(validateRlsDax('([Region] = "East"').ok).toBe(false);
  });
});

describe('buildRoleTmsl', () => {
  it('emits filterExpression + table OLS + column OLS', () => {
    const role: AasRole = {
      name: 'East',
      modelPermission: 'read',
      tablePermissions: [
        { name: 'Sales', filterExpression: '[Region] = "East"' },
        { name: 'Secret', metadataPermission: 'none' },
        {
          name: 'Customer',
          columnPermissions: [
            { name: 'SSN', metadataPermission: 'none' },
            { name: 'Name', metadataPermission: 'read' },
          ],
        },
      ],
    };
    const tmsl = buildRoleTmsl(role) as any;
    expect(tmsl.name).toBe('East');
    expect(tmsl.modelPermission).toBe('read');
    const tp = tmsl.tablePermissions;
    expect(tp).toHaveLength(3);
    expect(tp[0]).toEqual({ name: 'Sales', filterExpression: '[Region] = "East"' });
    expect(tp[1]).toEqual({ name: 'Secret', metadataPermission: 'none' });
    // Only the 'none' column survives (read is the default, not serialized).
    expect(tp[2].columnPermissions).toEqual([{ name: 'SSN', metadataPermission: 'none' }]);
  });

  it('drops a table permission that grants nothing special (full access)', () => {
    const role: AasRole = {
      name: 'All',
      modelPermission: 'read',
      tablePermissions: [{ name: 'Sales', filterExpression: '   ', metadataPermission: 'read' }],
    };
    const tmsl = buildRoleTmsl(role) as any;
    expect(tmsl.tablePermissions).toBeUndefined();
  });
});

describe('buildSetRolesTmsl', () => {
  it('wraps roles in a createOrReplace database command', () => {
    const tmsl = buildSetRolesTmsl('MyDb', [
      { name: 'East', modelPermission: 'read', tablePermissions: [{ name: 'Sales', filterExpression: '[R]="E"' }] },
    ]) as any;
    expect(tmsl.createOrReplace.object.database).toBe('MyDb');
    expect(tmsl.createOrReplace.database.name).toBe('MyDb');
    expect(tmsl.createOrReplace.database.roles).toHaveLength(1);
    expect(tmsl.createOrReplace.database.roles[0].name).toBe('East');
  });
});

describe('parseAasServer', () => {
  it('parses region + server from an asazure URL', () => {
    expect(parseAasServer('asazure://eastus.asazure.windows.net/myserver')).toEqual({
      region: 'eastus',
      serverName: 'myserver',
    });
  });
  it('returns null on garbage', () => {
    expect(parseAasServer('not-a-url')).toBeNull();
    expect(parseAasServer(undefined)).toBeNull();
  });
});

describe('resolveBackend', () => {
  it('prefers AAS and derives the XMLA endpoint + scope', () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus.asazure.windows.net/myserver';
    process.env.LOOM_AAS_CLIENT_ID = 'spn';
    const rb = resolveBackend();
    expect(rb.backend).toBe('aas');
    expect(rb.endpointUrl).toBe('https://eastus.asazure.windows.net/xmla');
    expect(rb.defaultCatalog).toBe('myserver');
    expect(rb.scope).toBe('https://eastus.asazure.windows.net/.default');
  });

  it('falls back to the Power BI XMLA endpoint', () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'powerbi://api.powerbi.com/v1.0/myorg/Sales';
    const rb = resolveBackend();
    expect(rb.backend).toBe('powerbi-xmla');
    expect(rb.endpointUrl).toBe('https://api.powerbi.com/v1.0/myorg/Sales/xmla');
    expect(rb.scope).toContain('/powerbi/api/.default');
  });

  it('throws 501 when nothing is configured', () => {
    expect(() => resolveBackend()).toThrowError(/No Analysis-Services/);
  });
});

describe('aasConfigGate', () => {
  it('gates when no backend is set', () => {
    const gate = aasConfigGate();
    expect(gate?.missing).toBe('LOOM_AAS_SERVER');
  });
  it('gates the AAS path when the SPN client id is missing', () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus.asazure.windows.net/srv';
    expect(aasConfigGate()?.missing).toBe('LOOM_AAS_CLIENT_ID');
  });
  it('returns null when the Power BI XMLA endpoint is set', () => {
    process.env.LOOM_POWERBI_XMLA_ENDPOINT = 'powerbi://api.powerbi.com/v1.0/myorg/Sales';
    expect(aasConfigGate()).toBeNull();
  });
  it('returns null when AAS server + SPN are both set', () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus.asazure.windows.net/srv';
    process.env.LOOM_AAS_CLIENT_ID = 'spn';
    expect(aasConfigGate()).toBeNull();
  });
  it('always gates in the DoD boundary', () => {
    process.env.LOOM_CLOUD = 'DoD';
    process.env.LOOM_AAS_SERVER = 'asazure://usdodeast.asazure.usgovcloudapi.net/srv';
    process.env.LOOM_AAS_CLIENT_ID = 'spn';
    expect(aasConfigGate()?.detail).toMatch(/DoD/);
  });
});

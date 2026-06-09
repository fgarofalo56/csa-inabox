/**
 * Azure Analysis Services (AAS) client — issues TMSL commands against an AAS
 * tabular model over the HTTPS data-plane so a Loom semantic model can be put
 * into **DirectQuery** storage mode against a live Azure source (Synapse
 * Serverless / Dedicated, Azure SQL, or Azure Data Explorer).
 *
 * Why AAS and not Power BI / Fabric: AAS is the Azure-native managed tabular
 * engine. Binding a DirectQuery partition through AAS needs NO Fabric capacity
 * and NO Power BI workspace (no-fabric-dependency.md) — it is the default
 * Azure-native backend for the semantic-model item's DQ surface. The Power BI
 * `UpdateDatasources` REST path remains an opt-in alternative for tenants that
 * have a Premium / Fabric XMLA endpoint, but it is never on the default path.
 *
 * Transport: TMSL commands are wrapped in the XMLA `Execute` SOAP envelope and
 * POSTed to `…/models/{db}/xmla`. This needs only `fetch` + a UAMI Bearer
 * token — no ADOMD.NET / msolap native dependency. (XMLA-over-HTTP is the same
 * protocol the AS client libraries speak; the Statement carries the TMSL JSON.)
 *
 * Auth: the standard Loom UAMI credential chain. The Console UAMI must be an
 * Analysis Services *server administrator* on the AAS server — that assignment
 * is an out-of-band tenant action (az CLI / portal) surfaced honestly in the
 * editor MessageBar (no-vaporware.md), not something bicep can grant via RBAC.
 *
 * Config gates (honest-gate when unset):
 *   LOOM_AAS_SERVER  bare server name (no region / suffix), e.g. "loom-aas"
 *   LOOM_AAS_REGION  Azure region of the server, e.g. "eastus2"
 *   LOOM_AAS_MODEL   tabular model (database) name on the server
 *
 * Cloud: aasScope() + aasServerBase() from cloud-endpoints resolve the gov
 * suffix (asazure.usgovcloudapi.net) automatically.
 *
 * Docs (grounded in Microsoft Learn):
 *   TMSL partition object:  https://learn.microsoft.com/analysis-services/tmsl/partitions-object-tmsl
 *   TMSL DataSources:       https://learn.microsoft.com/analysis-services/tmsl/datasources-object-tmsl
 *   XMLA Execute method:    https://learn.microsoft.com/analysis-services/xmla/xml-elements-methods-execute
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { aasScope, aasServerBase } from './cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class AasError extends Error {
  status: number;
  body?: unknown;
  code?: string;
  missing?: string;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
  }
}

/** The four Azure-native DirectQuery source families the binder supports. */
export type DqSourceType = 'synapse-serverless' | 'synapse-dedicated' | 'azure-sql' | 'adx';

export interface DqSourceConfig {
  sourceType: DqSourceType;
  /** Source server FQDN (TDS host or ADX cluster host). */
  server: string;
  /** Database / pool name on the source. */
  database: string;
  /** Key Vault secret NAME holding source credentials (optional — UAMI is default). */
  secretRef?: string;
  /** Tables bound into DirectQuery mode. */
  tables: string[];
  /** ISO timestamp of the last successful apply. */
  appliedAt?: string;
}

/**
 * Honest config gate — returns `{ missing, detail }` when the AAS env vars are
 * absent, else `null`. The BFF surfaces this as `{ ok:false, code:'not_configured' }`
 * and the editor renders a Fluent MessageBar with the exact var to set.
 */
export function aasConfigGate(): { missing: string; detail: string } | null {
  if (!process.env.LOOM_AAS_SERVER) return {
    missing: 'LOOM_AAS_SERVER',
    detail: 'Set LOOM_AAS_SERVER (bare server name, e.g. "loom-aas"), LOOM_AAS_REGION (e.g. "eastus2") and LOOM_AAS_MODEL to enable DirectQuery source binding via Azure Analysis Services. The Console UAMI must also be an Analysis Services server administrator on that server.',
  };
  if (!process.env.LOOM_AAS_REGION) return {
    missing: 'LOOM_AAS_REGION',
    detail: 'Set LOOM_AAS_REGION (Azure region of the AAS server, e.g. "eastus2") alongside LOOM_AAS_SERVER.',
  };
  if (!process.env.LOOM_AAS_MODEL) return {
    missing: 'LOOM_AAS_MODEL',
    detail: 'Set LOOM_AAS_MODEL (the tabular model / database name on the AAS server).',
  };
  return null;
}

function serverBase(): string {
  const server = process.env.LOOM_AAS_SERVER!;
  const region = process.env.LOOM_AAS_REGION!;
  return aasServerBase(region, server);
}

function modelBase(): string {
  return `${serverBase()}/models/${encodeURIComponent(process.env.LOOM_AAS_MODEL!)}`;
}

async function getToken(): Promise<string> {
  const t = await credential.getToken(aasScope());
  if (!t?.token) throw new AasError('Failed to acquire AAD token for Azure Analysis Services', 401);
  return t.token;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send one TMSL command to the AAS XMLA endpoint via a SOAP `Execute` envelope.
 * The TMSL JSON statement is carried as the `<Statement>` value with `Catalog`
 * set to the model/db. A SOAP `<Fault>` in the response is raised as AasError.
 */
export async function command(tmsl: object): Promise<void> {
  const gate = aasConfigGate();
  if (gate) {
    const e = new AasError(gate.detail, 503);
    e.code = 'not_configured';
    e.missing = gate.missing;
    throw e;
  }

  const model = process.env.LOOM_AAS_MODEL!;
  const token = await getToken();
  const stmt = JSON.stringify(tmsl);

  const soapBody = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    '  <SOAP-ENV:Body>',
    '    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">',
    '      <Command>',
    `        <Statement>${escapeXml(stmt)}</Statement>`,
    '      </Command>',
    '      <Properties>',
    '        <PropertyList>',
    `          <Catalog>${escapeXml(model)}</Catalog>`,
    '        </PropertyList>',
    '      </Properties>',
    '    </Execute>',
    '  </SOAP-ENV:Body>',
    '</SOAP-ENV:Envelope>',
  ].join('\n');

  const res = await fetch(`${modelBase()}/xmla`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: soapBody,
    cache: 'no-store',
  });

  const text = await res.text();
  // XMLA returns 200 even for TMSL errors carried in a SOAP <Fault> / <Error>.
  if (!res.ok || /<(\w+:)?fault/i.test(text) || /<Error\b/i.test(text)) {
    const fault =
      text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i)?.[1] ||
      text.match(/<Error[^>]*\bDescription="([^"]*)"/i)?.[1] ||
      text.slice(0, 400);
    throw new AasError(`AAS XMLA command failed: ${fault}`, res.ok ? 500 : res.status, text);
  }
}

/**
 * Build the TMSL command sequence that puts the given tables into DirectQuery
 * mode against a single source:
 *   1. createOrReplace the DQ DataSource (always named "LoomDQSource" — TMSL
 *      restricts a DirectQuery model to exactly one source).
 *   2. createOrReplace each table partition with mode="directQuery",
 *      dataView="full", and a query source pointing at "LoomDQSource".
 *
 * Pure function — no I/O — so it is unit-testable without mocks.
 *
 * @param server      source FQDN (TDS host, or ADX cluster host for adx)
 * @param database    database / pool on the source
 * @param tables      tables to bind in DirectQuery mode
 * @param sourceType  drives the source-query dialect + connection protocol
 */
export function buildDqTmsl(
  server: string,
  database: string,
  tables: string[],
  sourceType: DqSourceType,
): object[] {
  const model = process.env.LOOM_AAS_MODEL || 'LoomModel';
  const dsName = 'LoomDQSource';
  const isAdx = sourceType === 'adx';

  const datasourceCommand = {
    createOrReplace: {
      parentObject: { database: model },
      dataSource: {
        name: dsName,
        type: 'structured',
        connectionDetails: {
          protocol: isAdx ? 'kusto' : 'tds',
          address: { server, database },
        },
        // Service-identity (UAMI) OAuth — the AAS server admin identity reaches
        // the source. For TDS sources the UAMI must be a SQL login; for ADX a
        // database viewer. Honest-gated in the UI when the grant is missing.
        credential: { AuthenticationKind: 'ServiceAccount', kind: 'OAuth2' },
      },
    },
  };

  const partitionCommands = tables.map((table) => ({
    createOrReplace: {
      parentObject: { database: model, table },
      partition: {
        name: table,
        mode: 'directQuery',
        dataView: 'full',
        source: {
          type: 'query',
          query: isAdx ? table : `SELECT * FROM [dbo].[${table}]`,
          dataSource: dsName,
        },
      },
    },
  }));

  return [datasourceCommand, ...partitionCommands];
}

/**
 * Apply DirectQuery source binding to the configured AAS model: createOrReplace
 * the DataSource, then each table partition in DirectQuery mode. Each TMSL
 * command is sent individually (DataSource must exist before the partitions
 * that reference it). DQ models hold no cached data, so NO refresh is issued.
 */
export async function applyDqSource(config: DqSourceConfig): Promise<void> {
  const commands = buildDqTmsl(config.server, config.database, config.tables, config.sourceType);
  for (const cmd of commands) {
    await command(cmd);
  }
}

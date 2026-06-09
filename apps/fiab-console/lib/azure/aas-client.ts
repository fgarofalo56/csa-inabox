/**
 * aas-client — Analysis-Services tabular-engine client for the semantic-model
 * RLS + OLS Security tab.
 *
 * WHAT IT DOES
 * ------------
 * Authors model **roles** (row-level filters + object-level permissions) and
 * runs **test-as-role** DAX probes through the Analysis-Services XMLA protocol
 * (XMLA-over-HTTP / SOAP). Two interchangeable backends, both Azure-native
 * tabular engines, selected by env (no Fabric workspace required on the default
 * path):
 *
 *   1. **Azure Analysis Services** — `LOOM_AAS_SERVER=asazure://<region>.<suffix>/<srv>`.
 *      Authenticated with a dedicated service principal (UAMI cannot auth to
 *      AAS) via `LOOM_AAS_CLIENT_ID` + `LOOM_AAS_CLIENT_SECRET`. Needs NO
 *      Fabric / Power BI tenant at all.
 *   2. **Power BI Premium / Fabric XMLA endpoint** — `LOOM_POWERBI_XMLA_ENDPOINT=
 *      powerbi://api.powerbi.com/v1.0/myorg/<Workspace>`. Opt-in (Fabric-family);
 *      authenticated with the Console UAMI. Service principals CAN execute TMSL
 *      (createOrReplace roles) but CANNOT be added as role *members* — the UI
 *      surfaces that honestly.
 *
 * TMSL CONTRACT (Microsoft Learn — Tabular Model Scripting Language Roles object)
 *   - `roles[].tablePermissions[].filterExpression` — a DAX **boolean**
 *     expression = the RLS row filter ("" / absent = full table access).
 *   - `roles[].tablePermissions[].metadataPermission = "none"` — OLS: hides the
 *     entire table from members of the role.
 *   - `roles[].tablePermissions[].columnPermissions[].metadataPermission =
 *     "none"` — OLS: hides a single column.
 *   - test-as-role uses the XMLA connection properties `EffectiveUserName`
 *     (a real Entra UPN) + `Roles` to impersonate.
 *
 * No mocks. Every method issues a real XMLA HTTP request; errors are wrapped in
 * `AasError` (status + body) for the BFF to surface verbatim per no-vaporware.md.
 */

import {
  ClientSecretCredential,
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { aasSuffix, pbiXmlaScope, aasScope, detectLoomCloud } from './cloud-endpoints';

export { validateRlsDax } from './aas-dax-validate';

export class AasError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

// ============================================================
// Role / permission types (mirror the TMSL Roles object)
// ============================================================

export type MetadataPermission = 'read' | 'none';

export interface AasColumnPermission {
  name: string;
  metadataPermission: MetadataPermission;
}

export interface AasRoleTablePermission {
  /** Table name. */
  name: string;
  /** RLS DAX boolean filter. Empty / absent = no filter (full row access). */
  filterExpression?: string;
  /** OLS table-level visibility. 'none' hides the entire table. */
  metadataPermission?: MetadataPermission;
  /** OLS column-level visibility. */
  columnPermissions?: AasColumnPermission[];
}

export interface AasRoleMember {
  memberName: string;
  memberType?: 'user' | 'group' | 'auto';
}

export interface AasRole {
  name: string;
  description?: string;
  /** Power BI XMLA only supports 'read' for model permission. */
  modelPermission: 'read';
  tablePermissions?: AasRoleTablePermission[];
  members?: AasRoleMember[];
}

// ============================================================
// Backend selection + config gate
// ============================================================

type Backend = 'aas' | 'powerbi-xmla';

interface ResolvedBackend {
  backend: Backend;
  /** XMLA HTTP endpoint URL (POST target). */
  endpointUrl: string;
  /** Default catalog (AAS db name / Power BI dataset placeholder). */
  defaultCatalog: string;
  /** AAD scope to request. */
  scope: string;
  /** Region (AAS only) — used to scope the AAS token audience. */
  region?: string;
}

/**
 * Parse `LOOM_AAS_SERVER = asazure://<region>.<suffix>/<server>` into its parts.
 * Returns null when the value is absent or malformed.
 */
export function parseAasServer(
  server: string | undefined,
): { region: string; serverName: string } | null {
  if (!server) return null;
  const m = server.match(/^asazure:\/\/([^.]+)\.[^/]+\/(.+)$/i);
  if (!m) return null;
  return { region: m[1], serverName: m[2] };
}

/**
 * Resolve the active backend from env. Throws AasError(501) when neither
 * backend is configured (the BFF turns that into an honest config-gate).
 */
export function resolveBackend(): ResolvedBackend {
  const xmla = process.env.LOOM_POWERBI_XMLA_ENDPOINT;
  const aasServer = process.env.LOOM_AAS_SERVER;

  // Prefer an explicit AAS server (no Fabric/Power BI dependency) when present.
  if (aasServer) {
    const parsed = parseAasServer(aasServer);
    if (!parsed) {
      throw new AasError(
        `LOOM_AAS_SERVER is malformed: "${aasServer}". Expected asazure://<region>.${aasSuffix()}/<serverName>.`,
        500,
      );
    }
    return {
      backend: 'aas',
      endpointUrl: `https://${parsed.region}.${aasSuffix()}/xmla`,
      defaultCatalog: process.env.LOOM_AAS_DB || parsed.serverName,
      scope: aasScope(parsed.region),
      region: parsed.region,
    };
  }

  if (xmla) {
    // powerbi://api.powerbi.com/v1.0/myorg/<Workspace>  →  https://…/xmla
    const httpForm = xmla.replace(/^powerbi:\/\//i, 'https://').replace(/\/+$/, '');
    return {
      backend: 'powerbi-xmla',
      endpointUrl: `${httpForm}/xmla`,
      defaultCatalog: '',
      scope: pbiXmlaScope(),
    };
  }

  throw new AasError(
    'No Analysis-Services tabular engine is configured for RLS/OLS authoring.',
    501,
  );
}

/**
 * aasConfigGate — honest infra-gate for the Security tab. Returns a structured
 * `{ missing, detail }` when the tab cannot reach a tabular engine, else null.
 *
 * - DoD (IL6): AAS is not offered in the DoD boundary → always gated.
 * - Neither `LOOM_AAS_SERVER` nor `LOOM_POWERBI_XMLA_ENDPOINT` set → gated.
 * - AAS path missing its SPN client id → gated (UAMI cannot auth to AAS).
 */
export function aasConfigGate(): { missing: string; detail: string } | null {
  if (detectLoomCloud() === 'DoD') {
    return {
      missing: 'LOOM_CLOUD',
      detail:
        'Azure Analysis Services is not available in the DoD (IL6) boundary, and ' +
        'the Power BI XMLA endpoint is not reachable there. RLS/OLS role authoring ' +
        'is unavailable in this cloud.',
    };
  }
  const aasServer = process.env.LOOM_AAS_SERVER;
  const xmla = process.env.LOOM_POWERBI_XMLA_ENDPOINT;
  if (!aasServer && !xmla) {
    return {
      missing: 'LOOM_AAS_SERVER',
      detail:
        'No Analysis-Services tabular engine is configured. Set LOOM_AAS_SERVER ' +
        '(asazure://<region>.' +
        aasSuffix() +
        '/<server>, with LOOM_AAS_CLIENT_ID + LOOM_AAS_CLIENT_SECRET for the AAS ' +
        'admin service principal) to author RLS/OLS roles against an Azure Analysis ' +
        'Services model — no Fabric/Power BI tenant required. Alternatively opt into ' +
        'a Power BI Premium / Fabric capacity by setting LOOM_POWERBI_XMLA_ENDPOINT ' +
        '(powerbi://api.powerbi.com/v1.0/myorg/<Workspace>) with XMLA Read-Write ' +
        'enabled on the capacity and the Console UAMI a Member on the workspace. ' +
        'Deploy the AAS server with platform/fiab/bicep/modules/admin-plane/analysis-services.bicep.',
    };
  }
  if (aasServer && !process.env.LOOM_AAS_CLIENT_ID) {
    return {
      missing: 'LOOM_AAS_CLIENT_ID',
      detail:
        'LOOM_AAS_SERVER is set but LOOM_AAS_CLIENT_ID is missing. Azure Analysis ' +
        'Services does not accept a managed identity as a server admin, so a ' +
        'dedicated service principal is required. Set LOOM_AAS_CLIENT_ID + ' +
        'LOOM_AAS_CLIENT_SECRET (or LOOM_AAS_CERT path) to the AAS admin SPN, and ' +
        'add it to asAdministrators on the server (analysis-services.bicep does this ' +
        'via aasSpnClientId).',
    };
  }
  return null;
}

// ============================================================
// Credentials + token
// ============================================================

let _cred: TokenCredential | undefined;

function credentialFor(backend: Backend): TokenCredential {
  if (backend === 'aas') {
    // AAS requires a real SPN (UAMI is not supported as an AAS admin).
    const tenantId = process.env.LOOM_AAS_TENANT_ID || process.env.AZURE_TENANT_ID;
    const clientId = process.env.LOOM_AAS_CLIENT_ID;
    const secret = process.env.LOOM_AAS_CLIENT_SECRET;
    if (tenantId && clientId && secret) {
      return new ClientSecretCredential(tenantId, clientId, secret);
    }
    // No explicit SPN — fall back to the ambient chain for local dev
    // (`az login`). aasConfigGate() already blocks the deployed path.
    return new DefaultAzureCredential();
  }
  // Power BI XMLA — Console UAMI chained with DefaultAzureCredential.
  if (!_cred) {
    const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    _cred = uamiClientId
      ? new ChainedTokenCredential(
          new ManagedIdentityCredential({ clientId: uamiClientId }),
          new DefaultAzureCredential(),
        )
      : new DefaultAzureCredential();
  }
  return _cred;
}

async function getToken(rb: ResolvedBackend): Promise<string> {
  const t = await credentialFor(rb.backend).getToken(rb.scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${rb.scope}`, 401);
  return t.token;
}

// ============================================================
// XMLA SOAP builders (pure — unit-tested without network)
// ============================================================

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ExecuteEnvelopeOpts {
  effectiveUserName?: string;
  roles?: string;
}

/**
 * Build the XMLA `Execute` SOAP envelope. `statement` is either a TMSL JSON
 * command string (role authoring) or a DAX query (test-as-role). Optional
 * `EffectiveUserName` + `Roles` properties impersonate a role.
 */
export function buildExecuteEnvelope(
  statement: string,
  catalog: string,
  opts: ExecuteEnvelopeOpts = {},
): string {
  const props: string[] = [];
  if (catalog) props.push(`<Catalog>${xmlEscape(catalog)}</Catalog>`);
  if (opts.effectiveUserName) {
    props.push(`<EffectiveUserName>${xmlEscape(opts.effectiveUserName)}</EffectiveUserName>`);
  }
  if (opts.roles) props.push(`<Roles>${xmlEscape(opts.roles)}</Roles>`);
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    `<Command><Statement>${xmlEscape(statement)}</Statement></Command>` +
    `<Properties><PropertyList>${props.join('')}</PropertyList></Properties>` +
    '</Execute></Body></Envelope>'
  );
}

/** Build the XMLA `Discover` SOAP envelope for a tabular DMV rowset. */
export function buildDiscoverEnvelope(
  requestType: string,
  catalog: string,
  restrictions: Record<string, string> = {},
): string {
  const restrictionXml = Object.entries(restrictions)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/"><Body>' +
    '<Discover xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    `<RequestType>${xmlEscape(requestType)}</RequestType>` +
    `<Restrictions><RestrictionList>${restrictionXml}</RestrictionList></Restrictions>` +
    `<Properties><PropertyList>${catalog ? `<Catalog>${xmlEscape(catalog)}</Catalog>` : ''}</PropertyList></Properties>` +
    '</Discover></Body></Envelope>'
  );
}

/** Extract a SOAP `<faultstring>` (XMLA error) when the response is a Fault. */
export function extractSoapFault(soap: string): string | null {
  const fault = soap.match(/<(?:\w+:)?Fault\b[\s\S]*?<faultstring>([\s\S]*?)<\/faultstring>/i);
  if (fault) return fault[1].trim();
  // Analysis Services also returns inline <Error> elements with Description.
  const err = soap.match(/<Error\b[^>]*\bDescription="([^"]*)"/i);
  if (err) return err[1];
  const exc = soap.match(/<Exception\b[^>]*\bMessage="([^"]*)"/i);
  if (exc) return exc[1];
  return null;
}

/** Parse `<row>…</row>` rowset elements from an XMLA Discover/Execute response. */
export function parseDiscoverRows(soap: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const rowMatch of soap.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const obj: Record<string, string> = {};
    for (const field of rowMatch[1].matchAll(/<([\w:.]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      // Strip namespace prefix from the element name for friendlier keys.
      const key = field[1].replace(/^[\w]+:/, '');
      obj[key] = field[2];
    }
    rows.push(obj);
  }
  return rows;
}

// ============================================================
// TMSL builders (pure)
// ============================================================

/** Build a single role's TMSL object from an AasRole. */
export function buildRoleTmsl(role: AasRole): Record<string, unknown> {
  const tablePermissions = (role.tablePermissions || [])
    .filter(
      (tp) =>
        (tp.filterExpression && tp.filterExpression.trim()) ||
        tp.metadataPermission === 'none' ||
        (tp.columnPermissions || []).some((c) => c.metadataPermission === 'none'),
    )
    .map((tp) => {
      const out: Record<string, unknown> = { name: tp.name };
      if (tp.filterExpression && tp.filterExpression.trim()) {
        out.filterExpression = tp.filterExpression.trim();
      }
      if (tp.metadataPermission) out.metadataPermission = tp.metadataPermission;
      const cols = (tp.columnPermissions || []).filter((c) => c.metadataPermission === 'none');
      if (cols.length) {
        out.columnPermissions = cols.map((c) => ({
          name: c.name,
          metadataPermission: c.metadataPermission,
        }));
      }
      return out;
    });

  const out: Record<string, unknown> = {
    name: role.name,
    modelPermission: role.modelPermission || 'read',
  };
  if (role.description) out.description = role.description;
  if (tablePermissions.length) out.tablePermissions = tablePermissions;
  if (role.members && role.members.length) {
    out.members = role.members.map((m) => ({
      memberName: m.memberName,
      ...(m.memberType ? { memberType: m.memberType } : {}),
    }));
  }
  return out;
}

/**
 * Build the TMSL `createOrReplace` command that replaces the database's full
 * `roles` array. This is the supported single-shot role-set deploy.
 */
export function buildSetRolesTmsl(catalog: string, roles: AasRole[]): Record<string, unknown> {
  return {
    createOrReplace: {
      object: { database: catalog },
      database: {
        name: catalog,
        roles: roles.map(buildRoleTmsl),
      },
    },
  };
}

// ============================================================
// RLS DAX validator — re-exported from the pure aas-dax-validate module
// (above) so the client Security tab and the BFF share one implementation.
// ============================================================

// ============================================================
// XMLA HTTP execution
// ============================================================

async function postXmla(rb: ResolvedBackend, envelope: string): Promise<string> {
  const token = await getToken(rb);
  let res: Response;
  try {
    res = await fetch(rb.endpointUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/xml; charset=utf-8',
        soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
      },
      body: envelope,
      cache: 'no-store',
    });
  } catch (e: any) {
    throw new AasError(
      `XMLA request to ${rb.endpointUrl} failed: ${e?.message || String(e)}`,
      502,
      undefined,
      rb.endpointUrl,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const fault = extractSoapFault(text);
    throw new AasError(
      fault || text || `XMLA HTTP ${res.status}`,
      res.status,
      text,
      rb.endpointUrl,
    );
  }
  // Even with HTTP 200 the engine can return a SOAP Fault body.
  const fault = extractSoapFault(text);
  if (fault) throw new AasError(fault, 400, text, rb.endpointUrl);
  return text;
}

/** Send a raw TMSL command (createOrReplace / alter / etc.). */
export async function command(
  catalog: string,
  tmsl: Record<string, unknown>,
  opts?: ExecuteEnvelopeOpts,
): Promise<void> {
  const rb = resolveBackend();
  const cat = catalog || rb.defaultCatalog;
  await postXmla(rb, buildExecuteEnvelope(JSON.stringify(tmsl), cat, opts));
}

/**
 * Read the model's roles (+ row filters + OLS permissions + members) via the
 * tabular DMV Discover requests, joined by role/table id.
 */
export async function getRoles(catalog: string): Promise<AasRole[]> {
  const rb = resolveBackend();
  const cat = catalog || rb.defaultCatalog;

  const [rolesXml, tpXml, cpXml, memXml] = await Promise.all([
    postXmla(rb, buildDiscoverEnvelope('TMSCHEMA_ROLES', cat)),
    postXmla(rb, buildDiscoverEnvelope('TMSCHEMA_TABLE_PERMISSIONS', cat)).catch(() => ''),
    postXmla(rb, buildDiscoverEnvelope('TMSCHEMA_COLUMN_PERMISSIONS', cat)).catch(() => ''),
    postXmla(rb, buildDiscoverEnvelope('TMSCHEMA_ROLE_MEMBERSHIPS', cat)).catch(() => ''),
  ]);

  const roleRows = parseDiscoverRows(rolesXml);
  const tpRows = tpXml ? parseDiscoverRows(tpXml) : [];
  const cpRows = cpXml ? parseDiscoverRows(cpXml) : [];
  const memRows = memXml ? parseDiscoverRows(memXml) : [];

  // table-permission id → its column permissions
  const colsByTp = new Map<string, AasColumnPermission[]>();
  for (const c of cpRows) {
    const tpId = c.TablePermissionID || c.TablePermissionId;
    if (!tpId) continue;
    const list = colsByTp.get(tpId) || [];
    list.push({
      name: c.Name || c.ColumnName || '',
      metadataPermission: (c.MetadataPermission || 'read').toLowerCase() === 'none' ? 'none' : 'read',
    });
    colsByTp.set(tpId, list);
  }

  // role id → table permissions
  const tpByRole = new Map<string, AasRoleTablePermission[]>();
  for (const tp of tpRows) {
    const roleId = tp.RoleID || tp.RoleId;
    if (!roleId) continue;
    const tpId = tp.ID || tp.Id;
    const list = tpByRole.get(roleId) || [];
    list.push({
      name: tp.Name || tp.TableName || '',
      filterExpression: tp.FilterExpression || undefined,
      metadataPermission:
        (tp.MetadataPermission || 'read').toLowerCase() === 'none' ? 'none' : 'read',
      columnPermissions: tpId ? colsByTp.get(tpId) : undefined,
    });
    tpByRole.set(roleId, list);
  }

  // role id → members
  const memByRole = new Map<string, AasRoleMember[]>();
  for (const m of memRows) {
    const roleId = m.RoleID || m.RoleId;
    if (!roleId) continue;
    const list = memByRole.get(roleId) || [];
    list.push({ memberName: m.MemberName || m.MemberID || '' });
    memByRole.set(roleId, list);
  }

  return roleRows.map((r) => {
    const roleId = r.ID || r.Id || '';
    return {
      name: r.Name || '',
      description: r.Description || undefined,
      modelPermission: 'read' as const,
      tablePermissions: tpByRole.get(roleId) || [],
      members: memByRole.get(roleId) || [],
    };
  });
}

/** Replace the model's full set of roles in one createOrReplace command. */
export async function setRoles(catalog: string, roles: AasRole[]): Promise<void> {
  const rb = resolveBackend();
  const cat = catalog || rb.defaultCatalog;
  await postXmla(rb, buildExecuteEnvelope(JSON.stringify(buildSetRolesTmsl(cat, roles)), cat));
}

/**
 * Run a DAX query impersonating a role (EffectiveUserName + Roles). Returns the
 * rowset rows — the test-as-role receipt that proves the RLS filter is applied
 * and OLS-hidden columns are absent. The DAX is wrapped in EVALUATE only when
 * the caller didn't already pass a query statement.
 */
export async function testAsRole(
  catalog: string,
  daxQuery: string,
  opts: { effectiveUserName: string; roles: string },
): Promise<Array<Record<string, string>>> {
  const rb = resolveBackend();
  const cat = catalog || rb.defaultCatalog;
  const statement = /^\s*(EVALUATE|DEFINE)\b/i.test(daxQuery) ? daxQuery : `EVALUATE ${daxQuery}`;
  const xml = await postXmla(
    rb,
    buildExecuteEnvelope(statement, cat, {
      effectiveUserName: opts.effectiveUserName,
      roles: opts.roles,
    }),
  );
  return parseDiscoverRows(xml);
}

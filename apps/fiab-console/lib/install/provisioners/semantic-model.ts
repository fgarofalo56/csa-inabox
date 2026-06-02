/**
 * Phase 2 — Semantic Model provisioner.
 *
 * Real REST: Fabric POST /v1/workspaces/{ws}/semanticModels with the
 * bundle's TMDL/TMSL packed as InlineBase64 in the definition parts.
 * Fabric materializes the model in the workspace; the model is then
 * queryable via XMLA + visible to reports.
 *
 * TMDL push for measures+relationships is the long-form payload — we
 * serialize the bundle SemanticModelContent into a minimal model.bim
 * (TMSL JSON) part and a definition.pbism part.  Fabric accepts either
 * format on create; we use TMSL for simplicity (no MSOLAP dependency).
 *
 * Power BI fallback (no Fabric workspace bound):
 *   When this Loom workspace has no Fabric workspace, the model is created in
 *   Power BI directly via the supported REST authoring path — a *push* dataset
 *   (POST /groups/{ws}/datasets) with typed columns, measures, and
 *   relationships — then seeded with sample rows (POST .../rows) so the
 *   import-mode model is immediately queryable. No XMLA / AAS dependency.
 *   The target Power BI workspace is LOOM_DEFAULT_POWERBI_WORKSPACE, or — if
 *   unset — the sole workspace the Console UAMI can see, else resolved by name.
 *
 * Remediation gates:
 *   - No Fabric AND no resolvable Power BI workspace → bind/set a target.
 *   - 401/403 → UAMI not a Contributor / SP not tenant-authorized; admin fix.
 */
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import {
  PowerBiError,
  POWERBI_SP_HINT,
  createPushDataset,
  listWorkspaces,
  postPushRows,
  type CreatePushDatasetRequest,
  type PushColumn,
  type PushColumnType,
  type PushRelationship,
  type PushTable,
} from '@/lib/azure/powerbi-client';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import type { Provisioner, ProvisionResult } from './types';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://api.fabric.microsoft.com/.default');
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401);
  return t.token;
}

function buildTmsl(content: any, displayName: string): string {
  const tables = Array.isArray(content?.tables) ? content.tables : [];
  const measures = Array.isArray(content?.measures) ? content.measures : [];
  const relationships = Array.isArray(content?.relationships) ? content.relationships : [];
  return JSON.stringify({
    name: displayName,
    compatibilityLevel: 1567,
    model: {
      culture: 'en-US',
      tables: tables.map((t: any) => ({
        name: t.name,
        columns: (t.columns || []).map((c: any) => ({ name: c.name, dataType: c.dataType, sourceColumn: c.name })),
        measures: measures.filter((m: any) => m.table === t.name).map((m: any) => ({
          name: m.name, expression: m.expression, ...(m.formatString ? { formatString: m.formatString } : {}),
        })),
      })),
      // Power BI / Tabular permits only ONE active relationship between any two
      // tables. Bundles must declare a valid active set (the SemanticModelContent
      // schema has no active/inactive flag, so each table-pair appears at most
      // once as active). If a bundle ever carries an explicit `isActive: false`
      // (additive, optional), we honor it so a role-playing inactive relationship
      // can be emitted for USERELATIONSHIP use. TMSL `isActive` defaults to true.
      // https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
      relationships: relationships.map((r: any, i: number) => ({
        name: `rel${i}`,
        fromTable: r.from.split('.')[0], fromColumn: r.from.split('.')[1] || 'Id',
        toTable: r.to.split('.')[0], toColumn: r.to.split('.')[1] || 'Id',
        crossFilteringBehavior: 'oneDirection',
        ...(r.isActive === false ? { isActive: false } : {}),
      })),
    },
  }, null, 2);
}

// ============================================================
// Power BI push-dataset fallback (no Fabric workspace bound)
// ============================================================

/**
 * Normalize the bundle's loose dataType strings (`string`/`String`,
 * `int64`/`Int64`, `dateTime`/`DateTime`, `decimal`/`Decimal`, …) onto the
 * exact PascalCase types the Power BI push-dataset API requires. Unknown types
 * fall back to `String` (always representable). `Currency` maps to `Decimal`.
 */
function toPushColumnType(raw: unknown): PushColumnType {
  const s = String(raw ?? 'string').trim().toLowerCase();
  switch (s) {
    case 'int64':
    case 'integer':
    case 'int':
    case 'whole':
    case 'wholenumber':
      return 'Int64';
    case 'double':
    case 'float':
    case 'real':
      return 'Double';
    case 'decimal':
    case 'currency':
    case 'fixeddecimal':
      return 'Decimal';
    case 'boolean':
    case 'bool':
      return 'Boolean';
    case 'datetime':
    case 'date':
    case 'time':
      return 'DateTime';
    default:
      return 'String';
  }
}

/** Map SemanticModelContent → a Power BI push-dataset create request. */
function buildPushDataset(content: any, name: string): CreatePushDatasetRequest {
  const rawTables = Array.isArray(content?.tables) ? content.tables : [];
  const measures = Array.isArray(content?.measures) ? content.measures : [];
  const relationships = Array.isArray(content?.relationships) ? content.relationships : [];

  const tables: PushTable[] = rawTables.map((t: any) => {
    const columns: PushColumn[] = (t.columns || []).map((c: any) => ({
      name: c.name,
      dataType: toPushColumnType(c.dataType),
      ...(c.formatString ? { formatString: c.formatString } : {}),
    }));
    const tableMeasures = measures
      .filter((m: any) => m.table === t.name && m.expression)
      .map((m: any) => ({
        name: m.name,
        expression: m.expression,
        ...(m.formatString ? { formatString: m.formatString } : {}),
      }));
    return {
      name: t.name,
      columns: columns.length ? columns : [{ name: 'Id', dataType: 'Int64' as PushColumnType }],
      ...(tableMeasures.length ? { measures: tableMeasures } : {}),
    };
  });

  // Push datasets accept only ACTIVE relationships at create time; honor an
  // explicit isActive:false by dropping it (USERELATIONSHIP inactive rels are
  // an XMLA/Desktop concern not expressible on push datasets).
  const rels: PushRelationship[] = relationships
    .filter((r: any) => r?.from && r?.to && r.isActive !== false)
    .map((r: any, i: number) => ({
      name: `rel${i}`,
      fromTable: r.from.split('.')[0],
      fromColumn: r.from.split('.')[1] || 'Id',
      toTable: r.to.split('.')[0],
      toColumn: r.to.split('.')[1] || 'Id',
      crossFilteringBehavior: 'OneDirection' as const,
    }));

  return {
    name,
    defaultMode: 'Push',
    tables,
    ...(rels.length ? { relationships: rels } : {}),
  };
}

/**
 * Generate a small set of representative sample rows per table so the
 * import-mode push model is immediately queryable (no empty-model state).
 * Values are typed to match each column so Power BI accepts the POST /rows.
 * Labeled SAMPLE in the step log — this is install-time seed data, not a mock
 * standing in for a real backend call (the create + POST /rows are real REST).
 */
function sampleRowsFor(table: PushTable, count = 5): Array<Record<string, unknown>> {
  const base = new Date('2024-01-01T00:00:00Z').getTime();
  return Array.from({ length: count }, (_, i) => {
    const row: Record<string, unknown> = {};
    for (const col of table.columns) {
      switch (col.dataType) {
        case 'Int64':
          row[col.name] = i + 1;
          break;
        case 'Double':
          row[col.name] = Math.round((i + 1) * 10.5 * 100) / 100;
          break;
        case 'Decimal':
          row[col.name] = Math.round((i + 1) * 99.99 * 100) / 100;
          break;
        case 'Boolean':
          row[col.name] = i % 2 === 0;
          break;
        case 'DateTime':
          row[col.name] = new Date(base + i * 86400000).toISOString();
          break;
        default:
          row[col.name] = `${col.name} ${i + 1}`;
      }
    }
    return row;
  });
}

/** Resolve the Power BI workspace to author the push model in. */
async function resolvePowerBiWorkspace(): Promise<{ id?: string; candidates: string[] }> {
  const fromEnv = process.env.LOOM_DEFAULT_POWERBI_WORKSPACE || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
  if (fromEnv) return { id: fromEnv, candidates: [] };
  // No explicit target — list what the Console UAMI can see. A Power BI
  // workspace IS a "group" id; if exactly one is visible we use it.
  const groups = await listWorkspaces();
  const candidates = groups.map((g) => `${g.name}=${g.id}`);
  if (groups.length === 1) return { id: groups[0].id, candidates };
  return { id: undefined, candidates };
}

/**
 * Create the semantic model in Power BI as a push dataset and seed sample rows
 * for the import-mode tables. Used when no Fabric workspace is bound.
 */
async function provisionViaPowerBi(input: any, steps: string[]): Promise<ProvisionResult> {
  let pbi: { id?: string; candidates: string[] };
  try {
    pbi = await resolvePowerBiWorkspace();
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Power BI ${e.status}: cannot list workspaces to host the semantic model.`,
          remediation: POWERBI_SP_HINT,
          link: 'https://app.powerbi.com',
        },
        steps,
      };
    }
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), steps };
  }

  if (!pbi.id) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No Fabric workspace bound, and no Power BI workspace target could be resolved.',
        remediation:
          'Bind a Fabric workspace via /admin/workspaces > Bind capacity, OR set ' +
          'LOOM_DEFAULT_POWERBI_WORKSPACE to a Power BI workspace id the Console UAMI ' +
          'is a Member/Contributor of. ' +
          (pbi.candidates.length
            ? `Workspaces visible to the Console identity: ${pbi.candidates.join(', ')}.`
            : 'The Console identity currently sees no Power BI workspaces (grant it access).'),
        link: '/admin/workspaces',
      },
      steps,
    };
  }
  const ws = pbi.id;
  steps.push(`No Fabric workspace; creating model in Power BI workspace ${ws} as a push dataset.`);

  const request = buildPushDataset(input.content, input.displayName);
  if (!request.tables.length) {
    return { status: 'failed', error: 'Semantic model content has no tables to author.', steps };
  }
  steps.push(`Push dataset payload: ${request.tables.length} table(s), ${request.relationships?.length || 0} relationship(s).`);

  let created: { id: string; name: string };
  try {
    created = await createPushDataset(ws, request);
  } catch (e) {
    if (e instanceof PowerBiError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Power BI ${e.status}: cannot create the semantic model.`,
          remediation: POWERBI_SP_HINT,
          link: `https://app.powerbi.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), steps };
  }
  steps.push(`Created push dataset ${created.id}.`);

  // Seed SAMPLE rows so the import-mode model is immediately queryable.
  let seeded = 0;
  for (const table of request.tables) {
    const rows = sampleRowsFor(table);
    try {
      await postPushRows(ws, created.id, table.name, rows);
      seeded += rows.length;
    } catch (e) {
      // Non-fatal: the model exists and is valid even if seeding a table fails
      // (e.g. a column type Power BI rejects). Surface it honestly in the log.
      steps.push(`SAMPLE seed skipped for ${table.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  steps.push(`Seeded ${seeded} SAMPLE row(s) across ${request.tables.length} table(s).`);

  return {
    status: 'created',
    resourceId: created.id,
    secondaryIds: { powerbiWorkspaceId: ws, mode: 'powerbi-push' },
    steps,
  };
}

export const semanticModelProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    // No Fabric workspace — author the model directly in Power BI as a push
    // dataset and seed sample rows. Honest-gate only if no PBI target resolves.
    return provisionViaPowerBi(input, steps);
  }
  const tmsl = buildTmsl(input.content, input.displayName);
  steps.push(`Built TMSL payload (${tmsl.length} bytes).`);

  const definition = {
    parts: [
      {
        path: 'model.bim',
        payload: Buffer.from(tmsl, 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
      {
        path: 'definition.pbism',
        payload: Buffer.from(JSON.stringify({ version: '4.0', settings: {} }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
      {
        path: '.platform',
        payload: Buffer.from(JSON.stringify({
          $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
          metadata: { type: 'SemanticModel', displayName: input.displayName },
          config: { version: '2.0' },
        }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64' as const,
      },
    ],
  };

  const tok = await token();
  const res = await fetch(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/semanticModels`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: input.displayName, description: `Installed from ${input.appId}`, definition }),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch {}

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'remediation',
      gate: {
        reason: `Fabric ${res.status}: cannot create semantic model.`,
        remediation: fabricHint(res.status) || 'Add UAMI as Contributor on this Fabric workspace.',
        link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
      },
      steps,
    };
  }
  if (!res.ok && res.status !== 202) {
    return { status: 'failed', error: `Fabric ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body || text).slice(0, 300)}`, steps };
  }
  steps.push(`POST semanticModels ${res.status} OK.`);
  return {
    status: 'created',
    resourceId: body?.id || `${ws}/${input.displayName}`,
    secondaryIds: { fabricWorkspaceId: ws },
    steps,
  };
};

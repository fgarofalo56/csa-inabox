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
 * Remediation gates:
 *   - target.fabricWorkspaceId missing → bind workspace.
 *   - 401/403 → UAMI not a Contributor; admin must add.
 */
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
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

export const semanticModelProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No bound Fabric workspace.',
        remediation: 'Bind a Fabric workspace, or set LOOM_DEFAULT_FABRIC_WORKSPACE.',
        link: '/admin/workspaces',
      },
      steps,
    };
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

/**
 * Phase 2 — Power BI Report provisioner.
 *
 * Closes the gap where itemType 'report' had no provisioner and would bind to
 * a semantic model over empty tables. This creates a REAL Fabric Report item
 * with the documented PBIR (enhanced report format) definition, bound
 * **byConnection** to the bundle's semantic model so the report opens against
 * the live, seeded Gold tables.
 *
 * Real REST (grounded in Microsoft Learn):
 *   GET  /v1/workspaces/{ws}/semanticModels         → resolve the model id
 *   POST /v1/workspaces/{ws}/reports                 → create report w/ definition
 * Definition parts (PBIR):
 *   definition.pbir                  datasetReference.byConnection
 *                                    connectionString = "semanticmodelid=<id>"
 *   definition/report.json           report root (pages list)
 *   definition/pages/<n>/page.json   per-page layout
 *   definition/pages/<n>/visuals/<v>/visual.json  per-visual
 *   .platform                        item metadata
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/report-definition
 *   https://learn.microsoft.com/power-bi/developer/projects/projects-report#report-files
 *   https://learn.microsoft.com/rest/api/fabric/report/items
 *
 * The report MUST bind byConnection (not byPath) when deployed via REST — per
 * the PBIR docs only `semanticmodelid=<id>` is needed.
 *
 * Honest gates (per .claude/rules/no-vaporware.md):
 *   - Default backend is Loom-native (no Fabric). Power BI report authoring is
 *     opt-in only (LOOM_SEMANTIC_BACKEND=powerbi + a bound workspace).
 *   - Semantic model not found in workspace    → the model item must be
 *       provisioned first (it is, by the semantic-model provisioner). Surfaces
 *       remediation if the model id can't be resolved this pass.
 *   - 401/403 from Fabric                      → UAMI not Contributor.
 */
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

const FABRIC_BASE = process.env.LOOM_FABRIC_BASE || 'https://api.fabric.microsoft.com/v1';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function token(): Promise<string> {
  const t = await credential.getToken('https://api.fabric.microsoft.com/.default');
  if (!t?.token) throw new FabricError('Failed to acquire AAD token', 401);
  return t.token;
}

function b64(obj: unknown): string {
  return Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8').toString('base64');
}

/** Deterministic 20-hex id from a string (PBIR page/visual folder names). */
function shortId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return (hex + hex + hex).slice(0, 20);
}

/**
 * Map a bundle visual {type,title,field,config} into the minimal PBIR
 * visual.json shape. We carry the title + a visualType so the surface is real
 * and re-openable in Power BI; the exact field-well projection is normalized
 * by Power BI on first open (the byConnection model supplies the columns).
 */
function buildVisualJson(visual: any, position: number): object {
  const visualType = String(visual.type || 'card');
  return {
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/1.0.0/schema.json',
    name: shortId(`${visual.title}-${position}`),
    position: {
      x: (position % 3) * 420,
      y: Math.floor(position / 3) * 320 + 80,
      z: position,
      width: 400,
      height: 280,
      tabOrder: position,
    },
    visual: {
      visualType,
      drillFilterOtherVisuals: true,
      ...(visual.title
        ? {
            visualContainerObjects: {
              title: [
                {
                  properties: {
                    text: {
                      expr: {
                        Literal: { Value: `'${String(visual.title).replace(/'/g, "''")}'` },
                      },
                    },
                  },
                },
              ],
            },
          }
        : {}),
    },
  };
}

function buildReportDefinitionParts(
  content: any,
  displayName: string,
  semanticModelId: string,
): Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> {
  const pages: any[] = Array.isArray(content?.pages) ? content.pages : [];
  const parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> = [];

  // definition.pbir — bind byConnection to the workspace semantic model.
  parts.push({
    path: 'definition.pbir',
    payload: b64({
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
      version: '4.0',
      datasetReference: { byConnection: { connectionString: `semanticmodelid=${semanticModelId}` } },
    }),
    payloadType: 'InlineBase64',
  });

  // definition/report.json — root with ordered page references.
  const pageOrder = pages.map((p, i) => p?.name ? shortId(`${p.name}-${i}`) : shortId(`page-${i}`));
  parts.push({
    path: 'definition/report.json',
    payload: b64({
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/2.0.0/schema.json',
      themeCollection: { baseTheme: { name: 'CY24SU10' } },
      pages: { pageOrder, activePageName: pageOrder[0] || '' },
    }),
    payloadType: 'InlineBase64',
  });

  // definition/version.json — required PBIR metadata part.
  parts.push({
    path: 'definition/version.json',
    payload: b64({
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json',
      version: '2.0.0',
      datasetReference: { byConnection: { connectionString: `semanticmodelid=${semanticModelId}` } },
    }),
    payloadType: 'InlineBase64',
  });

  // Per page: page.json + per-visual visual.json.
  pages.forEach((page, pi) => {
    const pageName = pageOrder[pi];
    parts.push({
      path: `definition/pages/${pageName}/page.json`,
      payload: b64({
        $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.0.0/schema.json',
        name: pageName,
        displayName: page?.name || `Page ${pi + 1}`,
        displayOption: 'FitToPage',
        height: 720,
        width: 1280,
      }),
      payloadType: 'InlineBase64',
    });
    const visuals: any[] = Array.isArray(page?.visuals) ? page.visuals : [];
    visuals.forEach((v, vi) => {
      const vName = shortId(`${v.title}-${vi}`);
      parts.push({
        path: `definition/pages/${pageName}/visuals/${vName}/visual.json`,
        payload: b64(buildVisualJson(v, vi)),
        payloadType: 'InlineBase64',
      });
    });
  });

  // pages.json — page-folder ordering manifest (PBIR pages container).
  parts.push({
    path: 'definition/pages/pages.json',
    payload: b64({
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json',
      pageOrder,
      activePageName: pageOrder[0] || '',
    }),
    payloadType: 'InlineBase64',
  });

  // .platform — item metadata.
  parts.push({
    path: '.platform',
    payload: b64({
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
      metadata: { type: 'Report', displayName },
      config: { version: '2.0' },
    }),
    payloadType: 'InlineBase64',
  });

  return parts;
}

/** Resolve the semantic model the report should bind to. Preference:
 *  1. explicit content.semanticModelName / content.semanticModel
 *  2. a workspace semantic model whose displayName matches the report's
 *     (minus a trailing "Report") — falls back to the only model present. */
async function resolveSemanticModelId(
  ws: string,
  tok: string,
  reportDisplayName: string,
  content: any,
): Promise<{ id?: string; candidates: string[] }> {
  const res = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/semanticModels`, {
    headers: { authorization: `Bearer ${tok}` },
    cache: 'no-store',
  });
  if (!res.ok) return { id: undefined, candidates: [] };
  const j = await res.json().catch(() => null);
  const models: any[] = Array.isArray(j?.value) ? j.value : [];
  const candidates = models.map((m) => m.displayName).filter(Boolean);
  const want = String(content?.semanticModelName || content?.semanticModel || '').toLowerCase();
  if (want) {
    const exact = models.find((m) => (m.displayName || '').toLowerCase() === want);
    if (exact?.id) return { id: exact.id, candidates };
  }
  // Heuristic: report named "<X> Report" binds to model "<X>" / containing X.
  const base = reportDisplayName.replace(/\s*report$/i, '').trim().toLowerCase();
  const byBase =
    models.find((m) => (m.displayName || '').toLowerCase() === base) ||
    models.find((m) => base && (m.displayName || '').toLowerCase().includes(base)) ||
    (models.length === 1 ? models[0] : undefined);
  return { id: byBase?.id, candidates };
}

/**
 * Azure-native DEFAULT: Loom-native report.
 *
 * A Loom report is a surface that renders its pages/visuals by querying the
 * bound Loom-native semantic model (which in turn queries the warehouse/
 * lakehouse over SQL). The report definition (pages, visuals, field bindings)
 * lives on the Cosmos item and renders in the Loom report viewer — no Power BI
 * / Fabric workspace required (no-fabric-dependency.md).
 */
async function provisionLoomNativeReport(input: any, steps: string[]): Promise<ProvisionResult> {
  const content = input.content as any;
  const pages: any[] = Array.isArray(content?.pages) ? content.pages : (Array.isArray(content?.sections) ? content.sections : []);
  const visuals = pages.reduce((n, p) => n + (Array.isArray(p?.visuals) ? p.visuals.length : 0), 0);
  const model = content?.semanticModel || content?.datasetName || content?.model || 'its semantic model';
  steps.push(`Loom-native report: ${pages.length || 1} page(s), ${visuals} visual(s), bound to ${typeof model === 'string' ? model : 'its semantic model'}. Renders in the Loom report viewer over the warehouse via SQL — no Power BI / Fabric workspace required.`);
  // Optional server-side rendering (PDF / image export) via the BI render
  // Function (LOOM_BI_RENDER_FUNCTION_NAME, deployed alongside the BI stack).
  // When unset the report still renders interactively client-side in the viewer.
  const renderFn = process.env.LOOM_BI_RENDER_FUNCTION_NAME;
  steps.push(renderFn
    ? `Server-side render/export available via Function "${renderFn}".`
    : 'Server-side render/export not configured (LOOM_BI_RENDER_FUNCTION_NAME unset) — interactive viewer only.');
  return {
    status: 'created',
    resourceId: input.cosmosItemId,
    secondaryIds: { backend: 'loom-native', pages: String(pages.length), visuals: String(visuals) },
    steps,
  };
}

export const reportProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  // Reports follow the semantic model's backend. Power BI / Fabric reports are
  // opt-in only (Fabric-family) AND require a bound workspace; the DEFAULT is
  // the Azure-native Loom-native report viewer — never gate on Fabric.
  const backend = input.target.semanticBackend || 'loom-native';
  // Power BI / Fabric report authoring is opt-in (Fabric-family) AND needs a
  // bound workspace; the DEFAULT is the Azure-native Loom-native report viewer.
  if (backend !== 'powerbi' || !ws) {
    if (backend === 'powerbi' && !ws) {
      steps.push('Report backend is powerbi but no workspace bound — using the Azure-native Loom-native report viewer.');
    } else {
      steps.push('Provisioning report on the Azure-native Loom-native backend.');
    }
    return provisionLoomNativeReport(input, steps);
  }
  steps.push(`Power BI / Fabric report workspace: ${ws} (opt-in).`);

  let tok: string;
  try {
    tok = await token();
  } catch (e: any) {
    return {
      status: 'remediation',
      gate: { reason: 'Could not acquire a Fabric token.', remediation: fabricHint(401) || 'Configure the Console UAMI.', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
      steps,
    };
  }

  // Resolve the semantic model to bind to.
  const resolved = await resolveSemanticModelId(ws, tok, input.displayName, input.content);
  if (!resolved.id) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No semantic model found in the workspace to bind the report to.',
        remediation:
          'The report binds to its semantic model byConnection. Ensure the semantic-model item ' +
          'provisions first (it installs alongside this report), then re-run install. ' +
          (resolved.candidates.length ? `Models present: ${resolved.candidates.join(', ')}.` : 'No semantic models are present yet.'),
        link: `https://app.fabric.microsoft.com/groups/${ws}/list`,
      },
      steps,
    };
  }
  steps.push(`Binding report to semantic model ${resolved.id}.`);

  const parts = buildReportDefinitionParts(input.content, input.displayName, resolved.id);
  steps.push(`Built PBIR definition (${parts.length} parts).`);

  // Idempotency: reuse an existing report with the same displayName.
  const listRes = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/reports`, {
    headers: { authorization: `Bearer ${tok}` },
    cache: 'no-store',
  });
  if (listRes.status === 401 || listRes.status === 403) {
    return {
      status: 'remediation',
      gate: { reason: `Fabric ${listRes.status}: not authorized to list reports.`, remediation: fabricHint(listRes.status) || 'Add the Console UAMI as a Contributor.', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
      steps,
    };
  }
  let existing: any[] = [];
  if (listRes.ok) {
    const j = await listRes.json().catch(() => null);
    existing = Array.isArray(j?.value) ? j.value : [];
  }
  const match = existing.find((r: any) => (r.displayName || '').toLowerCase() === input.displayName.toLowerCase());

  if (match?.id) {
    const upd = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/reports/${encodeURIComponent(match.id)}/updateDefinition`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ definition: { parts } }),
      cache: 'no-store',
    });
    if (!upd.ok && upd.status !== 202) {
      const t = await upd.text();
      return resolveInfraResidual(`Fabric report updateDefinition ${upd.status}: ${t.slice(0, 300)}`, fabricHint(upd.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace (and bind it to a capacity).', { status: upd.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
    }
    steps.push(`Updated report ${match.id}.`);
    return { status: 'exists', resourceId: match.id, secondaryIds: { fabricWorkspaceId: ws, semanticModelId: resolved.id }, steps };
  }

  const createRes = await fetchWithTimeout(`${FABRIC_BASE}/workspaces/${encodeURIComponent(ws)}/reports`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: input.displayName, description: `Installed from ${input.appId}`, definition: { parts } }),
    cache: 'no-store',
  });
  if (createRes.status === 401 || createRes.status === 403) {
    return {
      status: 'remediation',
      gate: { reason: `Fabric ${createRes.status}: cannot create report.`, remediation: fabricHint(createRes.status) || 'Add the Console UAMI as a Contributor.', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
      steps,
    };
  }
  if (!createRes.ok && createRes.status !== 202) {
    const t = await createRes.text();
    return resolveInfraResidual(`Fabric reports ${createRes.status}: ${t.slice(0, 300)}`, fabricHint(createRes.status) || 'Add the Console UAMI as a Contributor on this Fabric workspace (and bind it to a capacity).', { status: createRes.status, link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
  }
  let body: any = null;
  try { body = await createRes.clone().json(); } catch {}
  steps.push(`Created report ${body?.id || '(long-running)'}.`);
  return {
    status: 'created',
    resourceId: body?.id || `${ws}/${input.displayName}`,
    secondaryIds: { fabricWorkspaceId: ws, semanticModelId: resolved.id },
    steps,
  };
};

/**
 * /api/items/semantic-model/workspace-pane
 *
 * Workspace-level pane backing the /semantic-model "Deploy" surface.
 *
 *  GET  → { ok, serverName, region, aasDatabases: AasDatabaseLite[],
 *           loomModels: LoomModelLite[], deploy: DeployCapability, gate? }
 *
 *         aasDatabases  — the REAL tabular databases on the env-pinned Azure
 *                         Analysis Services server (ARM, api-version 2017-08-01,
 *                         via listDatabases()). NEVER hard-coded — an empty list
 *                         is honest when the server has no databases.
 *         loomModels    — tenant-owned Loom-native semantic-model items from
 *                         Cosmos (the no-Fabric default backend), so the pane
 *                         renders even when AAS is unconfigured / unavailable.
 *         deploy        — which writeback backend the Deploy button can use:
 *                         'aas-xmla' (LOOM_AAS_XMLA_ENDPOINT set), 'fabric'
 *                         (LOOM_SEMANTIC_MODEL_BACKEND=fabric, opt-in), or
 *                         'unavailable' with an honest hint.
 *         gate          — honest config / availability gate (AAS unconfigured,
 *                         or AAS not available in GCC-High / DoD). The 200
 *                         body still carries loomModels so the pane is usable.
 *
 *  POST { action:'deploy', modelId, database } →
 *         Deploys the model's TMSL to the real tabular engine:
 *           • aasConfig().available          → executeAasXmla(tmsl, database)
 *           • fabricWriteEnabled() + ws bound → updateFabricSemanticModelTmsl(...)
 *           • neither                        → 200 { ok:false, deployUnavailable }
 *         The TMSL is built from the Loom-native item's stored tables +
 *         relationships via buildModelBimTmsl — no Fabric/Power BI read needed.
 *
 * Per .claude/rules/no-fabric-dependency.md the Azure-native path is the DEFAULT;
 * Fabric is strictly opt-in. Per .claude/rules/no-vaporware.md every value is a
 * real Azure / Cosmos read — no mocks, no `return []` placeholders, and Deploy
 * calls a real XMLA / Fabric REST write (honest gate when neither is configured).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDatabases, aasServerConfigGate, envAasServerName, envAasServerRegion, AasError,
  type AasDatabaseLite,
} from '@/lib/azure/aas-server-client';
import {
  aasConfig, fabricWriteEnabled, executeAasXmla, updateFabricSemanticModelTmsl,
  aasConfigGate, buildModelBimTmsl,
  type TmslTable, type TmslRelationship,
} from '@/lib/azure/aas-client';
import {
  listContentBackedItems, loadContentBackedItem, semanticModelDetailFromContent,
  cosmosIdFromLoomId, LOOM_ID_PREFIX,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LoomModelLite {
  /** loom:<cosmosId> — the id the model BFF + Deploy understand. */
  id: string;
  name: string;
  tableCount: number;
}

type DeployCapability =
  | { backend: 'aas-xmla'; available: true }
  | { backend: 'fabric'; available: true }
  | { backend: 'unavailable'; available: false; hint: string };

function deployCapability(): DeployCapability {
  if (aasConfig().available) return { backend: 'aas-xmla', available: true };
  if (fabricWriteEnabled()) return { backend: 'fabric', available: true };
  return {
    backend: 'unavailable',
    available: false,
    hint:
      'Set LOOM_AAS_XMLA_ENDPOINT to deploy to Azure Analysis Services (the Azure-native default), '
      + 'or set LOOM_SEMANTIC_MODEL_BACKEND=fabric to opt into a Fabric/Power BI workspace. '
      + 'Until then, model structure is stored with the item and emitted as TMSL at provision time.',
  };
}

async function loomModelsFor(tenantId: string): Promise<LoomModelLite[]> {
  const items = await listContentBackedItems('semantic-model', 'semantic-model', tenantId);
  return items.map((it) => {
    const detail = semanticModelDetailFromContent(it);
    return {
      id: `${LOOM_ID_PREFIX}${it.id}`,
      name: it.displayName,
      tableCount: detail?.tables?.length ?? 0,
    };
  });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;

  // Loom-native models are always available (the no-Fabric default), regardless
  // of whether an AAS server is configured — load them first so the pane is
  // usable even behind an honest AAS gate.
  const loomModels = await loomModelsFor(tenantId);
  const deploy = deployCapability();

  // GCC-High / DoD: AAS is not an Azure Government service. Surface the honest
  // availability gate; the pane still lists Loom-native models from Cosmos.
  const availGate = aasConfigGate();
  if (availGate && availGate.missing === 'AAS_NOT_IN_GOV') {
    return NextResponse.json({
      ok: true,
      serverName: '',
      region: '',
      aasDatabases: [] as AasDatabaseLite[],
      loomModels,
      deploy,
      gate: { kind: 'unavailable', missing: availGate.missing, detail: availGate.reason },
    });
  }

  // Commercial / GCC: honest config gate when the AAS server env vars are unset.
  const cfgGate = aasServerConfigGate();
  if (cfgGate) {
    return NextResponse.json({
      ok: true,
      serverName: '',
      region: '',
      aasDatabases: [] as AasDatabaseLite[],
      loomModels,
      deploy,
      gate: { kind: 'config', missing: cfgGate.missing, detail: cfgGate.detail },
    });
  }

  try {
    const aasDatabases = await listDatabases();
    const out = {
      ok: true as const,
      serverName: envAasServerName(),
      region: envAasServerRegion(),
      aasDatabases,
      loomModels,
      deploy,
    };
    try { console.info(`[sm/workspace-pane.GET] receipt: ${JSON.stringify(out).slice(0, 300)}`); } catch { /* noop */ }
    return NextResponse.json(out);
  } catch (e: any) {
    // A live ARM error (permission / transient) is surfaced as a gate so the
    // pane renders a precise MessageBar instead of an empty grid — Loom-native
    // models are still listed.
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({
      ok: true,
      serverName: envAasServerName(),
      region: envAasServerRegion(),
      aasDatabases: [] as AasDatabaseLite[],
      loomModels,
      deploy,
      gate: { kind: 'error', missing: 'AAS_LIST_FAILED', detail: e?.message || String(e), status },
    });
  }
}

interface DeployBody {
  action?: string;
  modelId?: string;
  database?: string;
  /** Fabric backend only (opt-in): the bound workspace id. */
  workspaceId?: string;
}

/** Map a stored Loom-native relationship to a TMSL relationship. */
function toTmslRelationship(r: any, i: number): TmslRelationship | null {
  if (!r?.fromTable || !r?.fromColumn || !r?.toTable || !r?.toColumn) return null;
  return {
    name: String(r.name || `rel${i}`).replace(/[^A-Za-z0-9_]/g, '_'),
    fromTable: r.fromTable,
    fromColumn: r.fromColumn,
    toTable: r.toTable,
    toColumn: r.toColumn,
    fromCardinality: 'many',
    toCardinality: 'one',
    crossFilteringBehavior: /both/i.test(String(r.crossFilteringBehavior || '')) ? 'bothDirections' : 'oneDirection',
    isActive: true,
  };
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;
  const body = (await req.json().catch(() => ({}))) as DeployBody;

  const action = (body.action || '').trim();
  if (action !== 'deploy') {
    return NextResponse.json({ ok: false, error: `unsupported action "${action}" (expected "deploy")` }, { status: 400 });
  }

  const modelId = (body.modelId || '').trim();
  const database = (body.database || '').trim();
  if (!modelId) return NextResponse.json({ ok: false, error: 'modelId is required' }, { status: 400 });

  // Build the TMSL from the Loom-native item's stored structure (the no-Fabric
  // default source of truth). This is the same model.bim the provisioner emits.
  const item = await loadContentBackedItem(cosmosIdFromLoomId(modelId), 'semantic-model', tenantId);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'semantic-model item not found (or not owned by this tenant)' }, { status: 404 });
  }
  const detail = semanticModelDetailFromContent(item);
  if (!detail) {
    return NextResponse.json({ ok: false, error: 'this item has no semantic-model content to deploy' }, { status: 422 });
  }
  const modelName = detail.dataset.name || item.displayName || 'SemanticModel';
  const tmslTables: TmslTable[] = (detail.tables || []).map((t: any) => ({
    name: t.name,
    columns: (t.columns || []).map((c: any) => ({ name: c.name, dataType: c.dataType || 'string' })),
  }));
  const tmslRels: TmslRelationship[] = (detail.relationships || [])
    .map((r: any, i: number) => toTmslRelationship(r, i))
    .filter((r): r is TmslRelationship => r !== null);
  const tmsl = buildModelBimTmsl(modelName, tmslTables, tmslRels, []);

  // Azure-native DEFAULT: deploy to the AAS XMLA endpoint when configured.
  if (aasConfig().available) {
    const target = database || modelName;
    const r = await executeAasXmla(tmsl, target);
    return NextResponse.json(
      { ok: r.ok, backend: 'aas-xmla', database: target, ...(r.error ? { error: r.error } : {}), tmslApplied: r.ok },
      { status: r.ok ? 200 : 502 },
    );
  }

  // Opt-in Fabric backend (LOOM_SEMANTIC_MODEL_BACKEND=fabric + bound workspace).
  if (fabricWriteEnabled()) {
    const workspaceId = (body.workspaceId || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || '').trim();
    if (!workspaceId) {
      return NextResponse.json({
        ok: false,
        backend: 'fabric',
        deployUnavailable: true,
        hint: 'The Fabric backend is selected (LOOM_SEMANTIC_MODEL_BACKEND=fabric) but no workspace is bound. Set LOOM_DEFAULT_FABRIC_WORKSPACE or pass workspaceId.',
      });
    }
    const r = await updateFabricSemanticModelTmsl(workspaceId, cosmosIdFromLoomId(modelId), tmsl);
    return NextResponse.json(
      { ok: r.ok, backend: 'fabric', workspaceId, ...(r.error ? { error: r.error } : {}), tmslApplied: r.ok },
      { status: r.ok ? 200 : 502 },
    );
  }

  // Neither backend configured — honest gate (200, not a 4xx) so the pane shows
  // a precise remediation MessageBar. The structure is already stored with the
  // item and is emitted as TMSL at provision time (no data is lost).
  return NextResponse.json({
    ok: false,
    deployUnavailable: true,
    hint:
      'No live tabular-engine writeback is configured. Set LOOM_AAS_XMLA_ENDPOINT to deploy to Azure '
      + 'Analysis Services (Azure-native default), or LOOM_SEMANTIC_MODEL_BACKEND=fabric to opt into Fabric. '
      + 'The model structure is stored with this item and emitted as TMSL at provision time.',
  });
}

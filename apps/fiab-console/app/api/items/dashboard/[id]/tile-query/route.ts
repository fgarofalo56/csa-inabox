/**
 * POST /api/items/dashboard/[id]/tile-query
 *
 * Executes a single dashboard tile's query on demand and returns tabular
 * { columns, rows }. Three tile kinds, each on a REAL Azure backend
 * (no-vaporware.md) — Azure-native by default (no-fabric-dependency.md):
 *
 *   kind=streaming-adx | kusto  → Azure Data Explorer (ADX) Kusto query.
 *     Pure Azure-native; works with NO Power BI / Fabric workspace. This is the
 *     default streaming-tile backend (Event Hub events land in an ADX table via
 *     a data connection; the tile queries that table).
 *
 *   kind=dax                    → DAX EVALUATE statement. Backend dispatch:
 *     - LOOM_SEMANTIC_BACKEND=analysis-services → Azure Analysis Services XMLA
 *       (`*.asazure.*` host) — Azure-native, no Power BI workspace required.
 *     - otherwise → Power BI REST executeDatasetQueries (opt-in Fabric-family
 *       path; requires a Power BI group + dataset the user explicitly selected).
 *
 *   nlPrompt set (any DAX kind) → Copilot edge: resolveAoaiTarget() → AOAI
 *     chat-completions generates the DAX first (same pattern as the KQL
 *     queryset assist edge), then the generated DAX runs on the dispatched
 *     backend. Returns `generatedQuery` so the UI can show + edit it.
 *
 * Every unconfigured backend surfaces an HONEST gate (`code` + `hint` + exact
 * env var) instead of erroring — the editor renders a Fluent MessageBar.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import {
  executeDatasetQueries,
  PowerBiError,
  powerbiConfigGate,
} from '@/lib/azure/powerbi-client';
import { executeQuery, KustoError, kustoConfigGate, defaultDatabase } from '@/lib/azure/kusto-client';
import { executeDax, AasError, aasConfigGate, resolveAasTarget } from '@/lib/azure/aas-client';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

type TileKind = 'dax' | 'kusto' | 'streaming-adx';
const MAX_ROWS = 1_000;

// ---------- AOAI credential (identical pattern to the KQL assist edge) -------
// ACA-first UAMI chain (see lib/azure/arm-credential.ts — the ACA MI token bug).
const credential = uamiArmCredential();

async function aoaiToken(): Promise<string> {
  const audience = process.env.LOOM_AOAI_AUDIENCE || 'https://cognitiveservices.azure.com';
  const t = await credential.getToken(`${audience}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

/** NL → DAX via the Loom AOAI deployment. Returns the generated DAX (no fences). */
async function generateDax(nlPrompt: string, datasetSchema: string): Promise<string> {
  const target = await resolveAoaiTarget();
  const token = await aoaiToken();
  const apiVersion = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(
    target.deployment,
  )}/chat/completions?api-version=${apiVersion}`;
  const schemaSection = datasetSchema.trim()
    ? `\n\nThe semantic model exposes these tables/columns (ground your DAX in them, do not invent names):\n${datasetSchema}`
    : '';
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a DAX query expert for Power BI / Analysis Services tabular models. ' +
        'Given a natural-language question, generate a SINGLE runnable DAX query for the ' +
        'EVALUATE statement. Return ONLY the DAX — no markdown fences, no explanation, no ' +
        'leading language tag. The query MUST start with EVALUATE (you may precede it with ' +
        'DEFINE MEASURE blocks).' +
        schemaSection,
    },
    { role: 'user' as const, content: nlPrompt },
  ];
  const callWithTemp = (temp?: number) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages, ...(temp !== undefined ? { temperature: temp } : {}), max_tokens: 1200 }),
    });
  let res = await callWithTemp(0.1);
  if (res.status === 400) {
    const txt = await res.text();
    if (/temperature|top_p/i.test(txt) && /unsupported_value|does not support|default \(1\)/i.test(txt)) {
      res = await callWithTemp(undefined);
    } else {
      throw new Error(`AOAI 400: ${txt.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AOAI ${res.status}: ${txt.slice(0, 300)}`);
  }
  const j = await res.json();
  const raw: string = j?.choices?.[0]?.message?.content ?? '';
  return raw.replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

/** Normalize Power BI executeQueries rows (array of objects) to columns + rows. */
function shapePbiResult(resp: Awaited<ReturnType<typeof executeDatasetQueries>>): { columns: string[]; rows: unknown[][] } {
  const table = resp?.results?.[0]?.tables?.[0];
  const objRows = table?.rows ?? [];
  if (objRows.length === 0) return { columns: [], rows: [] };
  const columns = Object.keys(objRows[0]);
  const rows = objRows.slice(0, MAX_ROWS).map((o) => columns.map((c) => o[c]));
  return { columns, rows };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  await ctx.params; // keep the dynamic segment (parity with sibling routes)

  const body = await req.json().catch(() => ({}));
  const kind = body?.kind as TileKind | undefined;
  if (!kind || !['dax', 'kusto', 'streaming-adx'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'kind must be dax | kusto | streaming-adx' }, { status: 400 });
  }
  const nlPrompt = String(body?.nlPrompt || '').trim();
  let query = String(body?.query || '').trim();
  const started = Date.now();

  // ---- DAX (Q&A or pinned-measure) ----
  if (kind === 'dax') {
    let generatedQuery: string | undefined;
    if (nlPrompt) {
      try {
        generatedQuery = await generateDax(nlPrompt, String(body?.datasetSchema || ''));
        query = generatedQuery;
      } catch (e: any) {
        const code = e instanceof NoAoaiDeploymentError ? 'no_aoai' : 'aoai_error';
        return NextResponse.json(
          {
            ok: false,
            code,
            error: e?.message || String(e),
            hint:
              'Copilot → DAX needs an Azure OpenAI deployment. Set LOOM_AOAI_ENDPOINT + ' +
              'LOOM_AOAI_DEPLOYMENT (deploy the AI Foundry project — ' +
              'platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true). ' +
              'You can still type DAX manually and Run.',
          },
          { status: 503 },
        );
      }
    }
    if (!query) return NextResponse.json({ ok: false, error: 'query (or nlPrompt) is required for dax tiles' }, { status: 400 });

    const semanticBackend = (process.env.LOOM_SEMANTIC_BACKEND || '').toLowerCase();
    if (semanticBackend === 'analysis-services') {
      // Azure-native DAX path (no Power BI workspace required).
      const gate = aasConfigGate();
      if (gate) {
        return NextResponse.json({ ok: false, code: 'aas_gate', error: `AAS not configured: ${gate.missing}`, hint: gate.hint }, { status: 503 });
      }
      try {
        const { server, model } = resolveAasTarget();
        const r = await executeDax(server, model, query);
        return NextResponse.json({ ok: true, columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, executionMs: r.executionMs, generatedQuery });
      } catch (e: any) {
        const status = e instanceof AasError ? e.status : 502;
        return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
      }
    }

    // Power BI REST DAX path (opt-in Fabric-family; user-selected dataset).
    const workspaceId = String(body?.workspaceId || '').trim();
    const datasetId = String(body?.datasetId || '').trim();
    const pbiGate = powerbiConfigGate();
    if (pbiGate) {
      return NextResponse.json({ ok: false, code: 'pbi_gate', error: pbiGate.detail, hint: `Set ${pbiGate.missing}, or set LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER to run DAX on Azure Analysis Services instead.` }, { status: 503 });
    }
    if (isGovCloud()) {
      // Power BI US Gov has limited executeQueries parity — steer to ADX / AAS.
      return NextResponse.json(
        {
          ok: false,
          code: 'pbi_gov_unsupported',
          error: 'Power BI executeQueries (DAX) is not reliably available on Power BI US Gov.',
          hint: 'Use a Streaming (ADX/KQL) tile, or set LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER to run DAX on Azure Analysis Services (asazure.usgovcloudapi.net).',
        },
        { status: 503 },
      );
    }
    if (!workspaceId || !datasetId) {
      return NextResponse.json({ ok: false, error: 'workspaceId and datasetId are required for Power BI dax tiles' }, { status: 400 });
    }
    try {
      const resp = await executeDatasetQueries(workspaceId, datasetId, query);
      const { columns, rows } = shapePbiResult(resp);
      return NextResponse.json({ ok: true, columns, rows, rowCount: rows.length, truncated: rows.length >= MAX_ROWS, executionMs: Date.now() - started, generatedQuery });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), generatedQuery }, { status });
    }
  }

  // ---- ADX / KQL (streaming + ad-hoc) ----
  if (!query) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });
  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'kusto_gate', error: `ADX not configured: ${gate.missing}`, hint: 'Set LOOM_KUSTO_CLUSTER_URI to the Azure Data Explorer cluster URI that ingests your Event Hub / streaming data.' },
      { status: 503 },
    );
  }
  const database = String(body?.database || '').trim() || defaultDatabase();
  try {
    const r = await executeQuery(database, query);
    return NextResponse.json({ ok: true, columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, executionMs: r.executionMs, visualization: r.visualization });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

/**
 * Notebook Copilot edges (F21) — inline cell code-assist for the Synapse
 * Notebook editor, powered by the SAME Loom build-assist AOAI deployment the
 * cross-item Copilot uses (resolveAoaiTarget). NO Fabric Copilot dependency:
 * the chat model is the AI Foundry project (`aifndry-loom-<location>`, `chat`
 * deployment) already provisioned by platform/fiab/bicep/modules/ai/
 * foundry-project.bicep and wired into admin-plane/main.bicep as
 * LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.
 *
 * Three modes, all grounded in the T2 lakehouse schema context (bronze/silver/
 * gold ADLS containers + Synapse serverless databases) plus the current cell:
 *   - generate : NL description → runnable PySpark / Spark SQL / SparkR cell
 *   - explain  : a grounded plain-English description of the cell
 *   - fix      : a corrected cell given its error traceback
 *
 * Real backend (per no-vaporware.md): every call hits AOAI chat-completions
 * with an AAD bearer token (cognitiveservices scope) — no mocks, no canned
 * strings. When AOAI is not configured the route returns an honest 503
 * `code:'no_aoai'` gate naming the exact env vars to set; the editor surfaces
 * it in a Fluent MessageBar and stays fully functional for Livy run + save.
 *
 * Azure-native by default (per no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. No Fabric / Power BI host is contacted.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { serverlessTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { cogScope } from '@/lib/azure/cloud-endpoints';
import { buildAssistMessages, type InCellMode } from '@/lib/copilot/notebook-tools';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getLastLivyError } from '@/lib/azure/synapse-livy-client';

type AssistMode = InCellMode; // 'generate' | 'explain' | 'fix' | 'comments' | 'optimize'
const ASSIST_MODES: AssistMode[] = ['generate', 'explain', 'fix', 'comments', 'optimize'];

// ---------- Credential (identical pattern to copilot-orchestrator) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  // Boundary-aware AOAI audience: cogScope() returns .us for Gov (GCC-High /
  // DoD), .com for Commercial / GCC. LOOM_AOAI_AUDIENCE (set per-cloud by
  // admin-plane/main.bicep) overrides when present.
  const audience = process.env.LOOM_AOAI_AUDIENCE;
  const scope = audience ? `${audience.replace(/\/+$/, '')}/.default` : cogScope();
  const t = await credential.getToken(scope);
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- T2 lakehouse schema grounding (soft-fail, never blocks) ----------
async function buildServerSchemaContext(): Promise<string> {
  const parts: string[] = [];
  const bronze = process.env.LOOM_BRONZE_URL;
  const silver = process.env.LOOM_SILVER_URL;
  const gold = process.env.LOOM_GOLD_URL;
  if (bronze) parts.push(`Bronze ADLS container: ${bronze}`);
  if (silver) parts.push(`Silver ADLS container: ${silver}`);
  if (gold) parts.push(`Gold ADLS container: ${gold}`);

  if (process.env.LOOM_SYNAPSE_WORKSPACE) {
    try {
      const r = await executeQuery(
        serverlessTarget('master'),
        'SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name',
      );
      const dbs = r.rows.map((row: unknown[]) => String(row[0])).filter(Boolean);
      if (dbs.length) parts.push(`Synapse Serverless databases: ${dbs.join(', ')}`);
    } catch {
      /* serverless pool cold / not granted — schema context is optional */
    }
  }
  return parts.join('\n');
}

// ---------- Per-mode messages: shared with the in-cell popover ----------
// buildAssistMessages lives in lib/copilot/notebook-tools.ts so the client and
// this route stay aligned from one canonical source (no duplicated prompts).

/**
 * Pull the real last error for this notebook's live Spark session from Livy.
 * Loads the notebook item (Cosmos) to read state.sparkSession {pool,id}, then
 * asks Livy for the most recent error statement. Soft-fails to '' so /fix can
 * return an honest "run the cell first" gate instead of throwing. Azure-native:
 * Synapse Livy is the default backend; no Fabric workspace is required.
 */
async function liveLivyErrorText(notebookId: string, workspaceId: string): Promise<string> {
  if (!workspaceId) return '';
  try {
    const items = await itemsContainer();
    const { resource } = await items.item(notebookId, workspaceId).read<any>();
    const spark = resource?.state?.sparkSession;
    const pool = typeof spark?.pool === 'string' ? spark.pool : '';
    const sid = typeof spark?.id === 'number' ? spark.id : Number(spark?.id);
    if (!pool || !Number.isFinite(sid) || sid <= 0) return '';
    const e = await getLastLivyError(pool, sid);
    if (!e) return '';
    return [e.ename, e.evalue, ...(e.traceback ?? [])].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode as AssistMode | undefined;
  if (!mode || !ASSIST_MODES.includes(mode)) {
    return NextResponse.json(
      { ok: false, error: `mode must be one of: ${ASSIST_MODES.join(' | ')}` },
      { status: 400 },
    );
  }
  const lang = String(body?.lang || 'pyspark');
  const source = String(body?.source || '');
  const prompt = String(body?.prompt || '');
  let errorText = String(body?.errorText || '');
  const workspaceId = String(body?.workspaceId || '');

  if (mode === 'generate' && !prompt.trim() && !source.trim()) {
    return NextResponse.json(
      { ok: false, error: 'prompt or source is required for generate mode' },
      { status: 400 },
    );
  }
  // explain/fix/comments/optimize all operate on the current cell's source.
  if (mode !== 'generate' && !source.trim()) {
    return NextResponse.json(
      { ok: false, error: `source is required for ${mode} mode` },
      { status: 400 },
    );
  }
  if (mode === 'fix' && !errorText.trim()) {
    // The client passes the cell's cached error when present; when it's empty
    // (cold-loaded notebook), pull the REAL last error from the live Livy
    // session for this notebook (Azure-native Synapse Spark, no Fabric needed).
    const notebookId = (await ctx.params).id;
    errorText = await liveLivyErrorText(notebookId, workspaceId);
    if (!errorText.trim()) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'No error to fix — run the cell first so the Spark (Livy) session has a recent error, ' +
            'or include the error text.',
        },
        { status: 400 },
      );
    }
  }

  // Resolve AOAI target — same resolution order as the cross-item Copilot.
  let target;
  try {
    target = await resolveAoaiTarget();
  } catch (e: any) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT ' +
          '(deploy the AI Foundry project — platform/fiab/bicep/modules/ai/foundry-project.bicep, ' +
          'agentFoundryEnabled=true — which wires them into admin-plane/main.bicep).';
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  // Build schema context: client hint (open notebook / attached pool) + server
  // T2 grounding (bronze/silver/gold + serverless databases). Both soft-fail.
  const clientSchema = String(body?.schemaContext || '');
  const serverSchema = await buildServerSchemaContext().catch(() => '');
  const schema = [clientSchema, serverSchema].filter(Boolean).join('\n');

  const messages = buildAssistMessages(mode, lang, source, prompt, errorText, schema);

  try {
    const token = await aoaiToken();
    const apiVersion = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';
    const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(
      target.deployment,
    )}/chat/completions?api-version=${apiVersion}`;

    const callWithTemperature = (temp?: number) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
          ...(temp !== undefined ? { temperature: temp } : {}),
          max_tokens: 2048,
        }),
      });

    let res = await callWithTemperature(0.2);
    if (res.status === 400) {
      const txt = await res.text();
      // Reasoning models (o1/o3/gpt-5/MAI-*) reject non-default temperature — retry once.
      if (
        /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(txt) &&
        /temperature|top_p/i.test(txt)
      ) {
        res = await callWithTemperature(undefined);
      } else {
        return NextResponse.json(
          { ok: false, error: `AOAI 400: ${txt.slice(0, 300)}` },
          { status: 502 },
        );
      }
    }
    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json(
        { ok: false, error: `AOAI ${res.status}: ${txt.slice(0, 300)}` },
        { status: 502 },
      );
    }
    const j = await res.json();
    const raw: string = j?.choices?.[0]?.message?.content ?? '';
    // Strip any stray ```lang fences the model may add despite instructions.
    const result = raw
      .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
    return NextResponse.json({ ok: true, result, mode });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

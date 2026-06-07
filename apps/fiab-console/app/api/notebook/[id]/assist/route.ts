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

type AssistMode = 'generate' | 'explain' | 'fix';

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

// ---------- Per-mode system + user messages ----------
function buildMessages(
  mode: AssistMode,
  lang: string,
  source: string,
  prompt: string,
  errorText: string,
  schema: string,
): { role: 'system' | 'user'; content: string }[] {
  const langLabel: Record<string, string> = {
    pyspark: 'PySpark (Python)',
    spark: 'Spark (Scala)',
    sql: 'Spark SQL',
    sparkr: 'SparkR (R)',
  };
  const langName = langLabel[lang] || lang;
  const schemaSection = schema.trim()
    ? `\n\nLakehouse schema context (ground your code in these, do not invent table/container names):\n${schema}`
    : '';

  if (mode === 'generate') {
    return [
      {
        role: 'system',
        content:
          `You are a Spark notebook code generator for the CSA Loom platform (Azure Synapse Spark). ` +
          `Given a natural-language description and optional lakehouse schema, write idiomatic, runnable ` +
          `${langName} code for a SINGLE notebook cell. Assume a SparkSession named \`spark\` is already ` +
          `available. Return ONLY executable code — no markdown fences, no commentary, no leading language tag.` +
          schemaSection,
      },
      {
        role: 'user',
        content: prompt || 'Write a PySpark cell that reads from the bronze container.',
      },
    ];
  }
  if (mode === 'explain') {
    return [
      {
        role: 'system',
        content:
          `You are a Spark notebook assistant for the CSA Loom platform. Explain what the following ` +
          `${langName} cell does in 3-5 concise sentences. Focus on data flow, transformations, and ` +
          `business intent. Plain prose, no code fences.` +
          schemaSection,
      },
      { role: 'user', content: `Cell source:\n\`\`\`\n${source}\n\`\`\`` },
    ];
  }
  // mode === 'fix'
  return [
    {
      role: 'system',
      content:
        `You are a Spark notebook debugger for the CSA Loom platform. Fix the following ${langName} cell ` +
        `that produced an error. Return ONLY the corrected, runnable code for the cell — no markdown fences, ` +
        `no explanation, no leading language tag.` +
        schemaSection,
    },
    { role: 'user', content: `Cell source:\n\`\`\`\n${source}\n\`\`\`\n\nError:\n${errorText}` },
  ];
}

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  // `params.id` (the notebook item id) is available for future per-notebook
  // schema pinning; not used today — schema grounding is env/serverless-based.
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode as AssistMode | undefined;
  if (!mode || !['generate', 'explain', 'fix'].includes(mode)) {
    return NextResponse.json(
      { ok: false, error: 'mode must be generate | explain | fix' },
      { status: 400 },
    );
  }
  const lang = String(body?.lang || 'pyspark');
  const source = String(body?.source || '');
  const prompt = String(body?.prompt || '');
  const errorText = String(body?.errorText || '');

  if (mode === 'generate' && !prompt.trim()) {
    return NextResponse.json(
      { ok: false, error: 'prompt is required for generate mode' },
      { status: 400 },
    );
  }
  if ((mode === 'explain' || mode === 'fix') && !source.trim()) {
    return NextResponse.json(
      { ok: false, error: 'source is required for explain/fix modes' },
      { status: 400 },
    );
  }
  if (mode === 'fix' && !errorText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'errorText is required for fix mode' },
      { status: 400 },
    );
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

  const messages = buildMessages(mode, lang, source, prompt, errorText, schema);

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

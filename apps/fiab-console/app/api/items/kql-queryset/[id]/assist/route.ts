/**
 * NL2KQL Copilot edge — inline KQL code-assist for the KQL Queryset editor,
 * powered by the SAME Loom build-assist AOAI deployment the cross-item Copilot
 * and the Notebook assist edge use (resolveAoaiTarget). NO Fabric Copilot
 * dependency: the chat model is the AI Foundry project (`aifndry-loom-<location>`,
 * `chat` deployment) provisioned by platform/fiab/bicep/modules/ai/
 * foundry-project.bicep and wired into admin-plane/main.bicep as
 * LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.
 *
 * Three modes, all grounded in the live ADX database schema (`.show database
 * <db> schema as json`) so generated KQL references real tables/columns:
 *   - generate : NL description           → a single runnable KQL query
 *   - explain  : a KQL query              → a plain-language summary
 *   - fix      : a KQL query + error text → a corrected KQL query
 *
 * Real backend (per no-vaporware.md): every call hits AOAI chat-completions
 * with an AAD bearer (cognitiveservices scope) — no mocks, no canned strings.
 * Schema grounding hits Kusto `/v1/rest/mgmt`. The generated KQL runs against
 * the real ADX cluster via the existing /run route (executeQuery). When AOAI is
 * not configured the route returns an honest 503 `code:'no_aoai'` gate naming
 * the exact env vars to set; the editor surfaces it in a Fluent MessageBar and
 * stays fully functional for manual authoring + Run.
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
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import {
  loadKustoItem,
  resolveDatabase,
  getDatabaseSchemaJson,
} from '@/lib/azure/kusto-client';

type AssistMode = 'generate' | 'explain' | 'fix';

// ---------- ADX schema grounding (soft-fail, never blocks) ----------
// One Kusto mgmt round-trip returns every table + column for the database.
// Trim the stringified schema so the system prompt stays within budget.
async function buildSchemaContext(database: string): Promise<string> {
  try {
    const schema = await getDatabaseSchemaJson(database);
    if (!schema) return '';
    const str = typeof schema === 'string' ? schema : JSON.stringify(schema);
    return str.length > 8000 ? `${str.slice(0, 8000)}\n…(schema truncated)` : str;
  } catch {
    // Cluster cold / db not granted / schema empty — grounding is optional.
    return '';
  }
}

// ---------- Per-mode system + user messages ----------
function buildMessages(
  mode: AssistMode,
  database: string,
  kql: string,
  prompt: string,
  errorText: string,
  schema: string,
): { role: 'system' | 'user'; content: string }[] {
  const schemaSection = schema.trim()
    ? `\n\nDatabase \`${database}\` schema (ground your KQL in these tables/columns, do not invent names):\n${schema}`
    : `\n\nTarget database: \`${database}\`.`;

  if (mode === 'generate') {
    return [
      {
        role: 'system',
        content:
          `You are a KQL (Kusto Query Language) query generator for the CSA Loom platform ` +
          `(Azure Data Explorer). Given a natural-language description and the database schema, ` +
          `write idiomatic, runnable KQL for a SINGLE query. Return ONLY the KQL — no markdown ` +
          `fences, no commentary, no leading language tag.` +
          schemaSection,
      },
      {
        role: 'user',
        content: prompt || 'Show the 10 most recent rows from any available table.',
      },
    ];
  }
  if (mode === 'explain') {
    return [
      {
        role: 'system',
        content:
          `You are a KQL query assistant for the CSA Loom platform. Explain what the following ` +
          `KQL query does in 3-5 concise sentences. Focus on the tables accessed, the filters / ` +
          `aggregations applied, and the business intent. Plain prose, no code fences.` +
          schemaSection,
      },
      { role: 'user', content: `KQL query:\n\`\`\`\n${kql}\n\`\`\`` },
    ];
  }
  // mode === 'fix'
  return [
    {
      role: 'system',
      content:
        `You are a KQL debugger for the CSA Loom platform. Fix the following KQL query that ` +
        `produced an error. Return ONLY the corrected, runnable KQL — no markdown fences, no ` +
        `explanation, no leading language tag.` +
        schemaSection,
    },
    { role: 'user', content: `KQL query:\n\`\`\`\n${kql}\n\`\`\`\n\nError:\n${errorText}` },
  ];
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
  const kql = String(body?.kql || '');
  const prompt = String(body?.prompt || '');
  const errorText = String(body?.errorText || '');

  if (mode === 'generate' && !prompt.trim()) {
    return NextResponse.json(
      { ok: false, error: 'prompt is required for generate mode' },
      { status: 400 },
    );
  }
  if ((mode === 'explain' || mode === 'fix') && !kql.trim()) {
    return NextResponse.json(
      { ok: false, error: 'kql is required for explain/fix modes' },
      { status: 400 },
    );
  }
  if (mode === 'fix' && !errorText.trim()) {
    return NextResponse.json(
      { ok: false, error: 'errorText is required for fix mode' },
      { status: 400 },
    );
  }

  // Item guard — same Cosmos ownership check as the run / GET / PUT routes.
  const item = await loadKustoItem((await ctx.params).id, 'kql-queryset', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const database = (body?.database && String(body.database).trim()) || resolveDatabase(item);

  // Resolve AOAI target — same resolution order as the cross-item Copilot.
  // Pre-resolve here for the honest 503 gate and pass the resolved target to
  // the unified client below so it does NOT re-resolve (one Foundry lookup).
  let aoaiTarget;
  try {
    aoaiTarget = await resolveAoaiTarget();
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

  // Schema grounding (soft-fail): real `.show database <db> schema as json`.
  const schema = await buildSchemaContext(database);
  const messages = buildMessages(mode, database, kql, prompt, errorText, schema);

  try {
    // Unified AOAI chat client (cogScope token + buildAoaiBody contract +
    // unsupported-temperature retry, Commercial- and Gov-correct).
    const raw = await aoaiChat({ messages, maxCompletionTokens: 2048, temperature: 0.2, target: aoaiTarget });
    // Strip any stray ```kql / ```kusto fences the model may add despite instructions.
    const result =
      mode === 'explain'
        ? raw.trim()
        : raw
            .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
            .replace(/\n?```\s*$/, '')
            .trim();
    return NextResponse.json({ ok: true, result, mode, database });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

/**
 * NL2KQL Copilot edge — inline KQL code-assist for the KQL Database editor.
 *
 * Parallel to /api/items/kql-queryset/[id]/assist, but for the kql-database
 * item (the primary ADX database editor). System prompts are single-sourced
 * from KQL_COPILOT_PERSONA (lib/azure/copilot-personas.ts) so the queryset
 * and database editors stay in lockstep; the live ADX schema is injected via
 * injectSchema() so generated KQL references real tables/columns.
 *
 * Three modes:
 *   - generate : NL description           → a single runnable KQL query
 *   - explain  : a KQL query              → a Markdown explanation
 *   - fix      : a KQL query + error text → a corrected KQL query
 *
 * Real backend (per no-vaporware.md): every call hits AOAI chat-completions
 * with an AAD bearer (cognitiveservices scope) — no mocks, no canned strings.
 * Schema grounding hits Kusto `/v1/rest/mgmt`. Generated KQL runs against the
 * real ADX cluster via the existing /query route (executeQuery). When AOAI is
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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { loadKustoItem, resolveDatabase } from '@/lib/azure/kusto-client';
import { KQL_COPILOT_PERSONA, injectSchema } from '@/lib/azure/copilot-personas-kql';
import { buildSchemaContext } from '@/lib/copilot/kql-tools';

type AssistMode = 'generate' | 'explain' | 'fix';

// ---------- Credential (identical pattern to copilot-orchestrator) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// AOAI audience differs by cloud (public: cognitiveservices.azure.com,
// Gov: cognitiveservices.azure.us). LOOM_AOAI_AUDIENCE is stamped by
// admin-plane/main.bicep via the ARM environment() built-in; default is the
// public-cloud host so the route works out of the box in Commercial.
async function aoaiToken(): Promise<string> {
  const audience = process.env.LOOM_AOAI_AUDIENCE || 'https://cognitiveservices.azure.com';
  const t = await credential.getToken(`${audience}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Per-mode system + user messages (persona-sourced) ----------
function buildMessages(
  mode: AssistMode,
  database: string,
  kql: string,
  prompt: string,
  errorText: string,
  schema: string,
): { role: 'system' | 'user'; content: string }[] {
  if (mode === 'generate') {
    return [
      { role: 'system', content: injectSchema(KQL_COPILOT_PERSONA.generateSystemPrompt, schema) },
      {
        role: 'user',
        content:
          (prompt || 'Show the 10 most recent rows from any available table.') +
          `\n\nTarget database: \`${database}\`.`,
      },
    ];
  }
  if (mode === 'explain') {
    return [
      { role: 'system', content: KQL_COPILOT_PERSONA.explainSystemPrompt },
      { role: 'user', content: `KQL query:\n\`\`\`\n${kql}\n\`\`\`` },
    ];
  }
  // mode === 'fix'
  return [
    { role: 'system', content: injectSchema(KQL_COPILOT_PERSONA.fixSystemPrompt, schema) },
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

  // Item guard — same Cosmos ownership check as the query / GET routes.
  const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const database = (body?.database && String(body.database).trim()) || resolveDatabase(item);

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

  // Schema grounding (soft-fail): real `.show database <db> schema as json`.
  const schema = await buildSchemaContext(database);
  const messages = buildMessages(mode, database, kql, prompt, errorText, schema);

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

    let res = await callWithTemperature(KQL_COPILOT_PERSONA.temperature);
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
    // explain → Markdown (kept verbatim). generate/fix → strip stray ```kql fences.
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

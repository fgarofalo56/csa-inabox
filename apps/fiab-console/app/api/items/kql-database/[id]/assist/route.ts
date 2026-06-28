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
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import { loadKustoItem, resolveDatabase } from '@/lib/azure/kusto-client';
import { KQL_COPILOT_PERSONA, injectSchema } from '@/lib/azure/copilot-personas-kql';
import { buildSchemaContext } from '@/lib/copilot/kql-tools';

type AssistMode = 'generate' | 'explain' | 'fix';

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
  // The unified aoaiChat client re-resolves internally; this pre-resolve only
  // drives the honest 503 no_aoai gate below (re-resolution is harmless).
  try {
    await resolveAoaiTarget();
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
    // Unified AOAI client (lib/azure/aoai-chat-client.ts): same deployment
    // resolution, max_completion_tokens cap, persona temperature, and
    // temperature-only retry as the inline call it replaces.
    const raw = await aoaiChat({
      messages,
      maxCompletionTokens: 2048,
      temperature: KQL_COPILOT_PERSONA.temperature,
    });
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

/**
 * Copilot sessions API.
 *
 *   GET  /api/copilot/sessions — list this user's Copilot sessions.
 *   POST /api/copilot/sessions — inline cell-fix ("Fix with Copilot").
 *
 * The POST handler powers the "Fix with Copilot" button rendered below any
 * failed notebook cell. The cell editor sends the failing source plus the
 * captured error context (ename / evalue / traceback, normalized by the
 * notebook execute route) and gets back a single corrected-code proposal the
 * editor surfaces as an approve-diff. Accepting it replaces the cell source.
 *
 * Real backend (per no-vaporware.md): calls AOAI chat-completions via the unified
 * aoai-chat-client (cogScope token — cognitiveservices.azure.us in Gov, .com in
 * Commercial — and the shared max_completion_tokens request contract).
 * No mocks, no canned strings. When AOAI is unconfigured the handler returns an
 * honest 503 `code:'no_aoai'` gate naming the exact env vars to set, and the
 * pane surfaces it in a Fluent MessageBar.
 *
 * Azure-native by default (per no-fabric-dependency.md): the AOAI deployment is
 * the AI Foundry chat model already wired by admin-plane/main.bicep
 * (LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric / Power BI host is
 * contacted; works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listSessions,
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { copilotSessionsContainer } from '@/lib/azure/cosmos-client';
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import { buildCellFixMessages, parseCellFixResponse } from '@/lib/copilot/notebook-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  try {
    const sessions = await listSessions(userOid);
    return NextResponse.json({ ok: true, sessions });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

interface CellFixBody {
  mode?: string;
  cellSource?: string;
  lang?: string;
  errorContext?: {
    ename?: string;
    evalue?: string;
    traceback?: string[] | string;
  };
  // Optional execution details (never required for the fix path) — surfaced to
  // the model so it can reason about run number, latency, and timing.
  executionCount?: number;
  durationMs?: number;
  executedAtUtc?: string;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const userOid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';

  const body = (await req.json().catch(() => ({}))) as CellFixBody;

  if (body?.mode !== 'cell-fix') {
    return NextResponse.json(
      { ok: false, error: "mode must be 'cell-fix'" },
      { status: 400 },
    );
  }
  const cellSource = String(body?.cellSource || '');
  if (!cellSource.trim()) {
    return NextResponse.json({ ok: false, error: 'cellSource is required' }, { status: 400 });
  }
  const lang = String(body?.lang || 'pyspark');
  const ec = body?.errorContext || {};
  const ename = String(ec.ename || '').trim();
  const evalue = String(ec.evalue || '').trim();
  const traceback = Array.isArray(ec.traceback)
    ? ec.traceback
    : ec.traceback
    ? [String(ec.traceback)]
    : [];
  if (!evalue && !ename) {
    return NextResponse.json(
      { ok: false, error: 'errorContext.ename or errorContext.evalue is required' },
      { status: 400 },
    );
  }

  // Compose the error text the same way the assist route does for `fix` mode.
  const errorText = [
    [ename, evalue].filter(Boolean).join(': '),
    traceback.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  // Resolve the AOAI target — tenant admin config first, then env/discovery.
  // Pre-resolve here purely to surface the honest 503 `no_aoai` gate; the unified
  // aoai-chat-client re-resolves (harmlessly) from the same tenant config below.
  let tenantConfig: Awaited<ReturnType<typeof loadTenantCopilotConfig>> | null = null;
  try {
    tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
    await resolveAoaiTarget(tenantConfig);
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

  const messages = buildCellFixMessages({
    cellSource,
    lang,
    errorContext: { ename, evalue, traceback },
    executionDetails: {
      executionCount: typeof body?.executionCount === 'number' ? body.executionCount : undefined,
      durationMs: typeof body?.durationMs === 'number' ? body.durationMs : undefined,
      executedAtUtc: typeof body?.executedAtUtc === 'string' ? body.executedAtUtc : undefined,
      // Pool name comes from the server env (not the client) — Synapse Spark pool.
      sessionPool: process.env.LOOM_SYNAPSE_SPARK_POOL || undefined,
    },
  });

  let proposedCode = '';
  let summary = '';
  let rootCause = '';
  try {
    // Unified AOAI client: resolves the same tenant-config target, mints a
    // cogScope token, sends max_completion_tokens=2048 @ temperature 0.2, and
    // retries once without temperature on the reasoning-model sampling 400.
    const raw = await aoaiChat({
      messages,
      maxCompletionTokens: 2048,
      temperature: 0.2,
      cfg: tenantConfig,
    });
    // Parse the structured { summary, rootCause, proposedCode } reply (with an
    // honest fence-stripping fallback when the model doesn't emit clean JSON).
    const fix = parseCellFixResponse(raw);
    proposedCode = fix.proposedCode;
    summary = fix.summary;
    rootCause = fix.rootCause;
    if (!proposedCode) {
      return NextResponse.json(
        { ok: false, error: 'AOAI returned an empty fix' },
        { status: 502 },
      );
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Persist a session record so the fix is auditable in the Copilot history
  // (GET /api/copilot/sessions + GET /api/copilot/sessions/{id}). Soft-fail:
  // a Cosmos error never blocks returning the fix.
  const sessionId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `cellfix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const promptLabel = `Cell fix: ${ename || 'error'} in ${lang} cell`;
  try {
    const c = await copilotSessionsContainer();
    const now = new Date().toISOString();
    await c.items.create({
      id: sessionId,
      sessionId,
      userOid,
      prompt: promptLabel,
      mode: 'cell-fix',
      lang,
      cellSource,
      errorContext: { ename, evalue, traceback },
      summary,
      rootCause,
      proposedCode,
      steps: [
        { kind: 'thought', content: `${promptLabel}\n\nError:\n${errorText}` },
        ...(summary ? [{ kind: 'thought', content: `Summary: ${summary}${rootCause ? `\nRoot cause: ${rootCause}` : ''}` }] : []),
        { kind: 'final', content: proposedCode },
      ],
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    /* persistence is best-effort — never block the fix */
  }

  return NextResponse.json({ ok: true, sessionId, proposedCode, summary, rootCause });
}

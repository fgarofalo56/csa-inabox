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
 * Real backend (per no-vaporware.md): calls AOAI chat-completions with an AAD
 * bearer token (cognitiveservices scope, env-driven audience for Gov clouds).
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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------- Credential (identical pattern to copilot-orchestrator/assist) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const LANG_LABEL: Record<string, string> = {
  pyspark: 'PySpark (Python)',
  spark: 'Spark (Scala)',
  sparksql: 'Spark SQL',
  sparkr: 'SparkR (R)',
  python: 'Python',
  tsql: 'T-SQL',
};

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
  let target;
  try {
    const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
    target = await resolveAoaiTarget(tenantConfig);
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

  // Acquire the AOAI bearer with the env-driven audience (honors Gov clouds —
  // LOOM_AOAI_AUDIENCE is stamped by admin-plane/main.bicep).
  let token: string;
  try {
    const audience = (process.env.LOOM_AOAI_AUDIENCE || 'https://cognitiveservices.azure.com').replace(
      /\/$/,
      '',
    );
    const t = await credential.getToken(`${audience}/.default`);
    if (!t?.token) throw new Error('Failed to acquire AOAI token');
    token = t.token;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const langName = LANG_LABEL[lang] || lang;
  const messages = [
    {
      role: 'system' as const,
      content:
        `You are a Spark notebook debugger for the CSA Loom platform. Fix the following ${langName} cell ` +
        `that produced an error. Return ONLY the corrected, runnable code for the cell — no markdown fences, ` +
        `no explanation, no leading language tag.`,
    },
    {
      role: 'user' as const,
      content: `Cell source:\n\`\`\`\n${cellSource}\n\`\`\`\n\nError:\n${errorText}`,
    },
  ];

  let proposedCode = '';
  try {
    const apiVersion = process.env.LOOM_AOAI_API_VERSION || target.apiVersion || '2024-10-21';
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
    proposedCode = raw
      .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
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
      proposedCode,
      steps: [
        { kind: 'thought', content: `${promptLabel}\n\nError:\n${errorText}` },
        { kind: 'final', content: proposedCode },
      ],
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    /* persistence is best-effort — never block the fix */
  }

  return NextResponse.json({ ok: true, sessionId, proposedCode });
}

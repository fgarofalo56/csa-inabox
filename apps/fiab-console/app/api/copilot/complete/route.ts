/**
 * Inline code completion (ghost text) — POST /api/copilot/complete
 *
 * Powers the Monaco InlineCompletionItemProvider in the Synapse Notebook +
 * Cosmos notebook code cells. Given the code PREFIX before the cursor, up to
 * 3 prior cells, and the lakehouse schema context, this returns the next
 * characters to insert as gray ghost text. Tab accepts.
 *
 * Fabric parity note: Fabric Notebook Copilot inline completions require an
 * F2+/P-class capacity (and a Fabric/Power BI Copilot license), which makes
 * ghost text unavailable to sovereign tenants without that SKU. The Loom path
 * has NO capacity gate — it calls Azure OpenAI chat-completions directly via
 * the SAME AI Foundry `chat` deployment the rest of the Copilot uses
 * (resolveAoaiTarget). No Fabric, no Power BI, no capacity dependency.
 *
 * Real backend (per no-vaporware.md): every call hits AOAI chat-completions
 * with an AAD bearer token (cognitiveservices scope) — no mocks, no canned
 * strings. When AOAI is not configured the route returns an honest 503
 * `code:'no_aoai'` gate naming the exact env vars to set; the cell falls back
 * to plain editing silently (the provider just yields no items).
 *
 * Azure-native by default (per no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. No Fabric / Power BI host is contacted.
 *
 * Tenant gate: the `ai.inlineCodeComplete` tenant-settings toggle can disable
 * the feature org-wide; when off this returns `code:'disabled'` (403). The
 * toggle read soft-fails to enabled if Cosmos is unreachable so completions
 * keep working in deployments without a tenant-settings doc.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { resolveCompletionTarget } from '@/lib/copilot/inline-complete';
import { cogScope } from '@/lib/azure/cloud-endpoints';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { defaultSettings, type TenantSettingsDoc } from '@/lib/types/tenant-settings';
import {
  buildInlineMessages,
  cleanInlineCompletion,
} from '@/lib/copilot/inline-complete-prompt';

// ---------- Credential (identical pattern to copilot-orchestrator) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function aoaiToken(): Promise<string> {
  // cogScope() picks the correct cognitiveservices audience per sovereign
  // boundary (Commercial/GCC = .azure.com; GCC-High/IL5 = .azure.us).
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Tenant toggle (cached, soft-fail to enabled) ----------
// Avoid a Cosmos round-trip on every debounced keystroke: cache the toggle for
// 60s per tenant. If Cosmos is unreachable / no doc exists, default to the
// toggle's own default (enabled) so the feature works out of the box.
const TOGGLE_KEY = 'ai.inlineCodeComplete';
const _toggleCache = new Map<string, { value: boolean; at: number }>();
const TOGGLE_TTL_MS = 60_000;

async function inlineCompleteEnabled(tenantId: string): Promise<boolean> {
  const cached = _toggleCache.get(tenantId);
  if (cached && Date.now() - cached.at < TOGGLE_TTL_MS) return cached.value;
  const fallback = defaultSettings()[TOGGLE_KEY] ?? true;
  let value = fallback;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(tenantId, tenantId).read<TenantSettingsDoc>();
    if (resource && TOGGLE_KEY in resource.settings) {
      value = !!resource.settings[TOGGLE_KEY];
    }
  } catch {
    // Cosmos cold / not configured / no doc — keep the default (enabled).
    value = fallback;
  }
  _toggleCache.set(tenantId, { value, at: Date.now() });
  return value;
}

// ---------- Prompt construction ----------
// buildInlineMessages + cleanInlineCompletion live in
// lib/copilot/inline-complete-prompt.ts (pure + unit-tested).

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const prefix = String(body?.prefix ?? '');
  if (!prefix.trim()) {
    // Nothing to complete yet — not an error, just no suggestion.
    return NextResponse.json({ ok: true, completion: '' });
  }
  const lang = String(body?.lang || 'pyspark');
  const priorCells: string[] = Array.isArray(body?.priorCells)
    ? body.priorCells.map((c: unknown) => String(c ?? '')).slice(-3)
    : [];
  const clientSchema = String(body?.schemaContext || '');
  const runtime = String(body?.runtime || '');

  // Tenant org-wide gate (cached, soft-fails to enabled).
  const tenantId = session.claims.oid;
  if (!(await inlineCompleteEnabled(tenantId))) {
    return NextResponse.json(
      {
        ok: false,
        code: 'disabled',
        error:
          'Inline code completion is disabled for this tenant. An admin can ' +
          're-enable it under Admin → Tenant settings → AI & Copilot → ' +
          '"Inline code completion (ghost text)".',
      },
      { status: 403 },
    );
  }

  // Resolve AOAI target — same resolution order as the cross-item Copilot, but
  // layered with LOOM_AOAI_COMPLETION_DEPLOYMENT so ghost text can use a
  // dedicated low-latency / cheaper deployment. Falls back silently to the chat
  // deployment when that env var is unset (honest gate — never a canned string).
  let target;
  try {
    target = await resolveCompletionTarget();
  } catch (e: any) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT ' +
          '(deploy the AI Foundry project — platform/fiab/bicep/modules/ai/foundry-project.bicep, ' +
          'agentFoundryEnabled=true — which wires them into admin-plane/main.bicep). ' +
          'Optionally set LOOM_AOAI_COMPLETION_DEPLOYMENT to a dedicated fast/cheap ' +
          'deployment (e.g. gpt-4o-mini) for lower ghost-text latency.';
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  const messages = buildInlineMessages(prefix, lang, priorCells, clientSchema, runtime);

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
          max_tokens: 256,
          // Stop at a blank line so ghost text stays a focused completion.
          stop: ['\n\n', '```'],
        }),
      });

    let res = await callWithTemperature(0);
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
    const completion = cleanInlineCompletion(raw, prefix);
    // Surface real AOAI token usage + the deployment that served the request so
    // the network call is verifiable end-to-end (per no-vaporware.md). `usage`
    // comes straight from AOAI — it is never synthesized.
    return NextResponse.json({
      ok: true,
      completion,
      deployment: target.deployment,
      usage: j?.usage ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

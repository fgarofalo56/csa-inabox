/**
 * GET  /api/admin/copilot-config — current tenant-wide Copilot & Agents config
 *   → { ok, config, accounts, defaultAccount, envDefaults, accountsError? }
 *     (accounts is the live list of model-hosting Cognitive Services accounts so
 *      the picker can render even on first load. envDefaults surfaces the
 *      deployment-level env-var fallbacks — LOOM_AOAI_ENDPOINT /
 *      LOOM_AOAI_DEPLOYMENT / LOOM_FOUNDRY_PROJECT_ENDPOINT|ID — that the chat
 *      backends already use when no tenant doc is saved, so the UI can show
 *      "linked + working day-one" instead of blank fields.)
 * PUT  /api/admin/copilot-config — body: { config: TenantCopilotConfig }
 *   Persists to the `copilot-config` Cosmos container (one doc per tenant) and
 *   emits an audit-log entry. Returns { ok, config }.
 *
 * Real persistence + real ARM listing — no mocks. When no Foundry account is
 * resolvable the route still returns ok:true with accounts:[] and an
 * accountsError hint so the UI can render the honest infra-gate.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  loadTenantCopilotConfig,
  saveTenantCopilotConfig,
} from '@/lib/azure/copilot-config-store';
import { listAccounts, resolveAccount, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



/** Whitelist of persistable STRING keys — never trust the client to send extras. */
const KEYS: (keyof TenantCopilotConfig)[] = [
  'foundryAccount', 'foundryAccountRg', 'foundryAccountSub', 'foundryProjectEndpoint', 'foundryProjectId',
  'aoaiEndpoint', 'copilotChatDeployment', 'helpAgentDeployment', 'routerDeployment', 'embeddingDeployment',
  'groundingSearchService', 'groundingSearchIndex', 'fabricCopilotWorkspaceId',
];

function sanitize(input: any): TenantCopilotConfig {
  const out: TenantCopilotConfig = {};
  for (const k of KEYS) {
    const v = input?.[k];
    if (typeof v === 'string') {
      const t = v.trim();
      (out as any)[k] = t === '' ? undefined : t;
    }
  }
  // Opt-in Fabric Copilot backend flag (boolean). Only `true` is persisted;
  // anything else clears it so the Azure-native path stays the silent default.
  out.fabricCopilotBackend = input?.fabricCopilotBackend === true ? true : undefined;
  return out;
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  try {
    const config = (await loadTenantCopilotConfig(tenantId)) || {};
    // Best-effort live account list so the picker renders immediately.
    let accounts: Array<{ name: string; rg: string; sub?: string; location?: string; kind?: string; endpoint?: string }> = [];
    let defaultAccount: string | undefined;
    let accountsError: { error: string; hint?: string } | undefined;
    try {
      accounts = (await listAccounts()).map((a) => ({
        name: a.name, rg: a.rg, sub: a.subscriptionId, location: a.location, kind: a.kind, endpoint: a.endpoint,
      }));
      try { defaultAccount = (await resolveAccount()).name; } catch { /* no default */ }
    } catch (e: any) {
      accountsError = e instanceof CsNotConfiguredError
        ? { error: e.message, hint: e.hint }
        : { error: e?.message || String(e) };
    }
    // Env-var fallbacks the chat backends already honor (copilot-orchestrator
    // resolveAoaiTarget → LOOM_AOAI_ENDPOINT/_DEPLOYMENT; foundry-agent-client →
    // LOOM_FOUNDRY_PROJECT_ENDPOINT/_ID). Surfaced so the UI shows Copilot is
    // linked + working on a fresh deploy even before any admin save. Non-secret
    // (endpoint hosts + deployment NAMES only — never keys/tokens).
    const envDefaults = {
      aoaiEndpoint: process.env.LOOM_AOAI_ENDPOINT || undefined,
      copilotChatDeployment: process.env.LOOM_AOAI_DEPLOYMENT || undefined,
      foundryProjectEndpoint: process.env.LOOM_FOUNDRY_PROJECT_ENDPOINT || undefined,
      foundryProjectId: process.env.LOOM_FOUNDRY_PROJECT_ID || undefined,
    };
    return NextResponse.json({ ok: true, config, accounts, defaultAccount, envDefaults, accountsError });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const incoming = body?.config;
  if (!incoming || typeof incoming !== 'object') return apiError('config (object) required', 400);

  const who = s.claims.upn || s.claims.email || tenantId;
  try {
    const before = (await loadTenantCopilotConfig(tenantId)) || {};
    const patch = sanitize(incoming);
    const doc = await saveTenantCopilotConfig(tenantId, who, patch);

    // Audit: one entry capturing the changed keys.
    try {
      const changed = KEYS.filter((k) => (before as any)[k] !== (patch as any)[k]);
      if (changed.length > 0) {
        const audit = await auditLogContainer();
        await audit.items.create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `copilot-config:${tenantId}`,
          tenantId,
          who,
          at: doc.updatedAt,
          kind: 'copilot-config.update',
          changedKeys: changed,
        }).catch(() => {});
      }
    } catch { /* audit failures are non-blocking */ }

    const { id: _i, tenantId: _t, updatedAt, updatedBy, ...config } = doc;
    return NextResponse.json({ ok: true, config, updatedAt, updatedBy });
  } catch (e: any) {
    return apiError(e?.message || String(e), 500);
  }
}

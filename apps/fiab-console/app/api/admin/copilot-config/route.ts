/**
 * GET  /api/admin/copilot-config — current tenant-wide Copilot & Agents config
 *   → { ok, config, accounts, defaultAccount, accountsError? }
 *     (accounts is the live list of model-hosting Cognitive Services accounts so
 *      the picker can render even on first load.)
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
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  loadTenantCopilotConfig,
  saveTenantCopilotConfig,
} from '@/lib/azure/copilot-config-store';
import { listAccounts, resolveAccount, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import type { TenantCopilotConfig } from '@/lib/types/copilot-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Whitelist of persistable STRING keys — never trust the client to send extras. */
const KEYS: (keyof TenantCopilotConfig)[] = [
  'foundryAccount', 'foundryAccountRg', 'foundryProjectEndpoint', 'foundryProjectId',
  'aoaiEndpoint', 'copilotChatDeployment', 'helpAgentDeployment', 'embeddingDeployment',
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
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  try {
    const config = (await loadTenantCopilotConfig(tenantId)) || {};
    // Best-effort live account list so the picker renders immediately.
    let accounts: Array<{ name: string; rg: string; location?: string; kind?: string; endpoint?: string }> = [];
    let defaultAccount: string | undefined;
    let accountsError: { error: string; hint?: string } | undefined;
    try {
      accounts = (await listAccounts()).map((a) => ({
        name: a.name, rg: a.rg, location: a.location, kind: a.kind, endpoint: a.endpoint,
      }));
      try { defaultAccount = (await resolveAccount()).name; } catch { /* no default */ }
    } catch (e: any) {
      accountsError = e instanceof CsNotConfiguredError
        ? { error: e.message, hint: e.hint }
        : { error: e?.message || String(e) };
    }
    return NextResponse.json({ ok: true, config, accounts, defaultAccount, accountsError });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const incoming = body?.config;
  if (!incoming || typeof incoming !== 'object') return err('config (object) required', 400);

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
    return err(e?.message || String(e), 500);
  }
}

/**
 * GET /api/foundry/accounts — list the subscription's Azure AI Foundry /
 * Azure OpenAI model-hosting accounts (Microsoft.CognitiveServices/accounts,
 * kind in {AIServices, OpenAI, CognitiveServices}). Drives the AI Foundry Hub
 * account picker so every Foundry surface can target a user-selected account
 * instead of the single env-var default.
 *
 * ARM: GET /subscriptions/{sub}/providers/Microsoft.CognitiveServices/accounts
 *      (Operation Accounts_List, api-version 2024-10-01). Grounded in Learn:
 *      https://learn.microsoft.com/dotnet/api/microsoft.azure.management.cognitiveservices.accountsoperationsextensions.list
 *
 * Returns { ok, accounts: [{ id, name, endpoint, location, kind, resourceGroup }], defaultAccount }.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAccounts, resolveAccount, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const accounts = (await listAccounts()).map((a) => ({
      id: a.id,
      name: a.name,
      endpoint: a.endpoint,
      location: a.location,
      kind: a.kind,
      resourceGroup: a.rg,
      subscriptionId: a.subscriptionId,
    }));
    // Best-effort: surface which account is the env-var/discovery default so
    // the picker can preselect it. Never fail the list if this resolves badly.
    let defaultAccount: string | undefined;
    try { defaultAccount = (await resolveAccount()).name; } catch { /* no default — picker just shows the list */ }
    return NextResponse.json({ ok: true, accounts, defaultAccount });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    }
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

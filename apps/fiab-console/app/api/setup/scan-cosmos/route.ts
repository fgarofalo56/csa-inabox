/**
 * GET /api/setup/scan-cosmos
 *   Scan-and-choose backend for the Console's metadata Cosmos (the serverless
 *   `loom` database the BFF reads/writes). Enumerates every existing Cosmos DB
 *   account the Console identity can see across all visible subscriptions via
 *   Azure Resource Manager, then returns the per-PRP choice model:
 *
 *     options: 'new' | 'existing' | 'disable'
 *     recommendation: 'new'   (provision a new SERVERLESS account — no 25-container
 *                              cap, the defect that broke workspaces/domains live)
 *
 *   The Setup Wizard renders these as a use-existing / provision-new / disable
 *   choice (disable is only offered alongside an existing account, since the
 *   Console cannot run without a metadata store). The chosen account flows into
 *   POST /api/setup/deploy as existingCosmosAccount/Rg/Sub (+ loomConsoleCosmos
 *   Enabled), which main.bicep consumes — provision-new is the default and emits
 *   no extra params (loomConsoleCosmosEnabled defaults true).
 *
 *   Read-only: enumeration only, nothing is created or modified.
 *
 * Response shape:
 *   { ok: true, recommendation: 'new', defaultOption: 'new',
 *     options: [{ id, label, recommended, requiresExisting }],
 *     existing: [{ name, resourceGroup, subscriptionId, location, capacityMode, serverless }] }
 *   { ok: false, error, hint? }                              on auth / network failure
 */
import { NextResponse } from 'next/server';
import { armBase } from '@/lib/azure/cloud-endpoints';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { PagingBudget, PAGE_DEADLINE } from '@/lib/azure/paging-budget';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function arm(): string {
  return armBase();
}

const credential = uamiArmCredential();

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${arm()}/.default`);
  if (!t?.token) throw new Error('Failed to acquire AAD token for ARM');
  return t.token;
}

interface ExistingCosmos {
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location: string;
  capacityMode: string;
  serverless: boolean;
}

/** Parse `/subscriptions/<sub>/resourceGroups/<rg>/...` out of an ARM id. */
function rgFromId(id: string): string {
  const m = /\/resourceGroups\/([^/]+)/i.exec(id || '');
  return m ? m[1] : '';
}
function subFromId(id: string): string {
  const m = /\/subscriptions\/([^/]+)/i.exec(id || '');
  return m ? m[1] : '';
}

/**
 * Walk an ARM nextLink-paged list. Bounded by a {@link PagingBudget} (#2557):
 * this ran on a bare `fetch` (no per-request timeout) inside a bare
 * `while (next)` — two missing ceilings on a request path. Each page now
 * inherits the walk's remaining wall clock.
 *
 * `budget` is passed IN and shared across the whole scan (1 + N subscriptions),
 * so the route is bounded in aggregate rather than per call — N x 15s of awaits
 * was still unbounded for the request.
 *
 * A deadline is TRUNCATION, never a throw: `runPage` absorbs the budget's own
 * FetchTimeoutError so one slow subscription degrades the scan exactly the way
 * an unreadable one already does (the `!r.ok` break below) instead of 502-ing
 * the whole thing — which is what the un-absorbed throw did.
 */
async function armGetAll(url: string, token: string, budget: PagingBudget): Promise<any[]> {
  const out: any[] = [];
  let next = url;
  while (budget.claimPage()) {
    const r = await budget.runPage((timeoutMs) =>
      fetchWithTimeout(next, { headers: { authorization: `Bearer ${token}` } }, timeoutMs),
    );
    if (r === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep what we have
    if (!r.ok) {
      // A single sub the identity can't read shouldn't fail the whole scan.
      break;
    }
    const j: any = await r.json().catch(() => ({}));
    for (const v of (j.value || []) as any[]) out.push(v);
    if (!j.nextLink) break;
    next = j.nextLink;
  }
  return out;
}

export const GET = withSession(async () => {

  let token: string;
  try {
    token = await armToken();
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: `auth failed: ${e?.message ?? String(e)}`,
        hint: 'The Console identity could not acquire an ARM token. Grant the Console UAMI (or your az-login principal) Reader on the target subscriptions.',
      },
      { status: 502 },
    );
  }

  // 1) list visible subscriptions, 2) list Cosmos accounts in each.
  // ONE budget for the whole fan-out: the per-sub walks share a single wall
  // clock, so a tenant with 40 subscriptions cannot turn this into 40 x 15s.
  const budget = new PagingBudget('setup scan-cosmos');
  const existing: ExistingCosmos[] = [];
  try {
    const subs = await armGetAll(`${arm()}/subscriptions?api-version=2022-12-01`, token, budget);
    for (const s of subs) {
      if (budget.truncatedBy) break; // aggregate ceiling spent — return what we have
      const subId = s.subscriptionId;
      if (!subId || (s.state && s.state !== 'Enabled')) continue;
      const accounts = await armGetAll(
        `${arm()}/subscriptions/${subId}/providers/Microsoft.DocumentDB/databaseAccounts?api-version=2024-11-15`,
        token,
        budget,
      );
      for (const a of accounts) {
        const mode = a.properties?.capacityMode || 'None';
        existing.push({
          name: a.name,
          resourceGroup: rgFromId(a.id) || '',
          subscriptionId: subFromId(a.id) || subId,
          location: a.location || '',
          capacityMode: mode,
          serverless: mode === 'Serverless',
        });
      }
    }
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `ARM request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
  budget.warnIfTruncated(existing.length);

  existing.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const hasExisting = existing.length > 0;
  return NextResponse.json({
    ok: true,
    service: 'console-metadata-cosmos',
    // Provision-new SERVERLESS is always recommended — it removes the
    // 25-container shared-throughput cap and needs no manual sizing.
    recommendation: 'new',
    defaultOption: 'new',
    options: [
      {
        id: 'new',
        label: 'Provision new (serverless)',
        description:
          'Create a new serverless Cosmos account for the Console metadata store. No 25-container cap, consumption-billed, fully wired (env + RBAC + private endpoint).',
        recommended: true,
        requiresExisting: false,
      },
      {
        id: 'existing',
        label: 'Use an existing account',
        description:
          'Reuse one of the discovered Cosmos accounts. The hub provision is skipped and the Console binds to the selected account.',
        recommended: false,
        requiresExisting: true,
        available: hasExisting,
      },
      {
        id: 'disable',
        label: 'Disable hub provision',
        description:
          'Skip provisioning the hub Cosmos. Only valid when reusing an existing account — the Console requires a metadata store.',
        recommended: false,
        requiresExisting: true,
        available: hasExisting,
      },
    ],
    existing,
  });
});

/**
 * POST /api/marketplace/mini-app — build a mini-app on top of a subscribed API.
 *
 * Creates a REAL Loom Notebook pre-wired to call the chosen API through the APIM
 * gateway: a Python client scaffold (base URL + subscription-key header from an
 * env var, never hard-coded) plus a starter analysis cell, and the API's real
 * operations listed as ready-to-call comments. This is the analyst-oriented
 * "use this API as a source for anything in Loom" path — the notebook is a real,
 * owned item they can build on.
 *
 * Body: { workspaceId, apiId, apiName, gatewayUrl, apiPath, appName }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem } from '../../items/_lib/item-crud';
import { listOperations, ApimError } from '@/lib/azure/apim-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const workspaceId = String(body?.workspaceId || '').trim();
  const apiId = String(body?.apiId || '').trim();
  const apiName = String(body?.apiName || apiId || 'API').trim();
  const gatewayUrl = String(body?.gatewayUrl || '').trim().replace(/\/+$/, '');
  const apiPath = String(body?.apiPath || '').trim().replace(/^\/+|\/+$/g, '');
  const appName = String(body?.appName || `${apiName} mini-app`).trim();

  if (!workspaceId) return NextResponse.json({ ok: false, error: 'pick a workspace' }, { status: 400 });
  if (!apiId) return NextResponse.json({ ok: false, error: 'apiId is required' }, { status: 400 });

  // Pull the API's real operations to scaffold ready-to-call comments.
  let ops: { method?: string; urlTemplate?: string; displayName?: string }[] = [];
  try { ops = await listOperations(apiId); } catch (e: any) {
    // Operations are best-effort; a missing list still yields a working client.
    if (e instanceof ApimError && e.status >= 500) { /* ignore */ }
  }

  const base = gatewayUrl && apiPath ? `${gatewayUrl}/${apiPath}` : (gatewayUrl || '<APIM gateway URL>');
  const opLines = (ops || []).slice(0, 40).map((o) => `#   ${(o.method || 'GET').padEnd(6)} ${o.urlTemplate || '/'}  — ${o.displayName || ''}`.trimEnd());
  const opsComment = opLines.length ? `# Operations on this API:\n${opLines.join('\n')}\n` : '';
  const firstPath = (ops.find((o) => (o.method || 'GET').toUpperCase() === 'GET')?.urlTemplate) || '';

  const code =
    `# ${appName}\n` +
    `# Calls "${apiName}" through the APIM gateway. Set your subscription key as an env\n` +
    `# var (API Marketplace -> My subscriptions -> Show keys). Secrets are never hard-coded.\n` +
    `import os, requests, pandas as pd\n\n` +
    `BASE = "${base}"\n` +
    `HEADERS = {"Ocp-Apim-Subscription-Key": os.environ.get("APIM_SUBSCRIPTION_KEY", "")}\n\n` +
    `def call(path="", method="GET", **kwargs):\n` +
    `    """Call an operation on ${apiName}. Returns JSON when available, else text."""\n` +
    `    r = requests.request(method, f"{BASE}{path}", headers=HEADERS, **kwargs)\n` +
    `    r.raise_for_status()\n` +
    `    ct = r.headers.get("content-type", "")\n` +
    `    return r.json() if "application/json" in ct else r.text\n\n` +
    opsComment +
    `\n# Starter analysis — call an operation and load it into a DataFrame:\n` +
    `data = call("${firstPath}")\n` +
    `df = pd.json_normalize(data if isinstance(data, list) else [data])\n` +
    `display(df.head(50))\n`;

  const res = await createOwnedItem(session, 'notebook', {
    workspaceId,
    displayName: appName,
    description: `Mini-app calling the "${apiName}" API via APIM, created from the API Marketplace.`,
    state: { code, lang: 'python' },
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });

  return NextResponse.json({
    ok: true,
    message: `Created mini-app notebook "${res.item.displayName}" wired to ${apiName} (${ops.length} operation(s)).`,
    link: `/items/notebook/${res.item.id}`,
    linkLabel: 'Open the mini-app notebook',
  });
}

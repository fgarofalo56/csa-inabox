/**
 * POST /api/items/user-data-function/[id]/invoke
 *   Body: { functionName, parameters }
 *
 * Azure-native by DEFAULT (per .claude/rules/no-fabric-dependency.md). User Data
 * Functions are Python functions; the Azure-native execution backend is an
 * **Azure Function App** HTTP endpoint (the same code runs unchanged on Azure
 * Functions). Resolution order:
 *
 *   1. Azure-native (DEFAULT): an Azure Functions HTTP endpoint, from
 *        state.azureFunctionUrl  — the deployed Function App base URL, OR
 *        LOOM_UDF_FUNCTION_BASE + the function name.
 *      POST {base}/api/{functionName} with the JSON parameters. The function
 *      key (if the function is not anonymous) is read from Key Vault via the
 *      secret name in state.functionKeySecret → `x-functions-key` header.
 *
 *   2. Fabric (OPT-IN ONLY): used solely when LOOM_UDF_BACKEND=fabric AND the
 *      published Fabric endpoint is resolvable. Never on the default path —
 *      api.fabric.microsoft.com is not reached unless Fabric is opted into.
 *
 *   3. Honest gate: if neither backend is configured, returns 409 naming the
 *      exact Azure-native env var to set (LOOM_UDF_FUNCTION_BASE) — an Azure
 *      requirement, NOT a Fabric one. The full Test panel still renders.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getKeyVaultSecretValue, vaultUrl } from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const b = await req.json().catch(() => ({}));
  const functionName = String(b?.functionName || '').trim();
  if (!functionName) return NextResponse.json({ ok: false, error: 'functionName is required' }, { status: 400 });
  const parameters = b?.parameters || {};

  // Load persisted item state.
  let st: any = {};
  try {
    const origin = req.nextUrl.origin;
    const r = await fetch(`${origin}/api/items/user-data-function/${encodeURIComponent(id)}`, {
      headers: { cookie: req.headers.get('cookie') || '' },
    });
    st = (await r.json())?.state || {};
  } catch { /* fall through to gate */ }

  // ── 1) Azure-native default: Azure Functions HTTP endpoint ────────────────
  const fnBase: string | undefined = st.azureFunctionUrl
    || (process.env.LOOM_UDF_FUNCTION_BASE ? process.env.LOOM_UDF_FUNCTION_BASE : undefined);
  if (fnBase) {
    try {
      const url = `${fnBase.replace(/\/+$/, '')}/api/${encodeURIComponent(functionName)}`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // Function key (if not anonymous): KV secret name on state.functionKeySecret.
      const keySecret: string | undefined = st.functionKeySecret;
      if (keySecret) {
        if (!vaultUrl()) {
          return NextResponse.json({
            ok: false, gated: true,
            error: 'Function key secret configured but no Key Vault is available.',
            hint: 'Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) and grant the Console UAMI "Key Vault Secrets User", or clear state.functionKeySecret to invoke an anonymous function.',
          }, { status: 409 });
        }
        headers['x-functions-key'] = await getKeyVaultSecretValue(keySecret);
      }
      // Forward the authored source so the Loom udf-runtime host executes THIS
      // item's function, not its bundled sample (udf-runtime/app.py reads
      // `x-udf-source-b64` and loads that source per-request). Without this the
      // default runtime silently ran compute_score for every function (rel-T05).
      // A real Azure Functions host ignores the unknown header and runs its
      // deployed code, so it is safe to always send when we have source.
      let ranAuthoredSource = false;
      const src = typeof st.source === 'string' ? st.source : '';
      if (src.trim()) {
        const b64 = Buffer.from(src, 'utf-8').toString('base64');
        // Guard against unbounded request headers (most gateways cap total header
        // size at 8–64KB). 256KB of base64 (~192KB of source) is far past any real
        // UDF; beyond it we let the deployed/bundled code run rather than push source.
        if (b64.length <= 256 * 1024) {
          headers['x-udf-source-b64'] = b64;
          ranAuthoredSource = true;
        }
      }
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(parameters) });
      const text = await res.text();
      return NextResponse.json({
        ok: res.ok, backend: 'azure-functions', status: res.status, body: text,
        // Be explicit when we did NOT run the item's authored source, so the Test
        // panel result is never silently the bundled sample (no-vaporware.md).
        ...(ranAuthoredSource ? {} : {
          note: src.trim()
            ? 'Authored source exceeded the inline size limit; the deployed Function App code ran instead. Deploy this source to the Function App to run it verbatim.'
            : 'This item has no authored source; the runtime executed its bundled/deployed function.',
        }),
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, backend: 'azure-functions', error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── 2) Fabric backend: OPT-IN ONLY (never on the default path) ────────────
  if (process.env.LOOM_UDF_BACKEND === 'fabric') {
    const base: string | undefined = st.fabricEndpoint
      || (st.fabricWorkspaceId && st.fabricItemId && process.env.LOOM_FABRIC_UDF_HOST
        ? `${process.env.LOOM_FABRIC_UDF_HOST}/${st.fabricWorkspaceId}/${st.fabricItemId}`
        : undefined);
    if (base) {
      try {
        const t = await uamiArmCredential().getToken(FABRIC_SCOPE);
        if (!t?.token) throw new Error('Failed to acquire Fabric token');
        const url = `${base.replace(/\/+$/, '')}/functions/${encodeURIComponent(functionName)}/invoke`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(parameters),
        });
        const text = await res.text();
        return NextResponse.json({ ok: res.ok, backend: 'fabric', status: res.status, body: text });
      } catch (e: any) {
        return NextResponse.json({ ok: false, backend: 'fabric', error: e?.message || String(e) }, { status: 502 });
      }
    }
  }

  // ── 3) Honest Azure-native gate (default) ─────────────────────────────────
  return NextResponse.json({
    ok: false,
    gated: true,
    error: 'This User Data Function has no execution backend configured yet.',
    hint: 'Azure-native default: deploy the function to an Azure Function App and set LOOM_UDF_FUNCTION_BASE on the Console Container App (e.g. https://my-udf.azurewebsites.net), or set state.azureFunctionUrl on this item. If the function requires a key, set state.functionKeySecret to the Key Vault secret name. (A Fabric backend is opt-in only via LOOM_UDF_BACKEND=fabric.)',
  }, { status: 409 });
}

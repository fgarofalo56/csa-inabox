/**
 * POST /api/items/user-data-function/[id]/invoke
 *   Body: { functionName, parameters }
 *
 * Azure-native by DEFAULT (per .claude/rules/no-fabric-dependency.md). User Data
 * Functions are Python functions; the Azure-native execution backend is an
 * **Azure Function App** HTTP endpoint (the same code runs unchanged on Azure
 * Functions). Resolution order:
 *
 *   1. Azure-native (DEFAULT): an Azure Functions HTTP endpoint resolved by
 *      lib/azure/udf-endpoint-policy.ts. POST {base}/api/{functionName} with the
 *      JSON parameters.
 *
 *      SECURITY — read udf-endpoint-policy.ts before changing this route. The
 *      destination and the function key are OPERATOR CONFIGURATION; item state
 *      may only select/agree. `state.azureFunctionUrl` and
 *      `state.functionKeySecret` are arbitrary JSON any authenticated user can
 *      write via `PATCH /api/items/user-data-function/<id>`, and this route
 *      reads a named Key Vault secret with the Console's managed identity. And
 *      because the default endpoint EXECUTES this item's `state.source`, a
 *      credential is never attached to an endpoint that accepts pushed source.
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
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getKeyVaultSecretValue, vaultUrl } from '@/lib/azure/kv-secrets-client';
import { resolveUdfEndpoint, resolveFabricUdfEndpoint } from '@/lib/azure/udf-endpoint-policy';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';

/**
 * Translate a raw Python interpreter traceback in a non-2xx runtime response
 * into a specific, actionable message instead of forwarding the stack trace
 * to the user verbatim (.claude/rules/deploy-integrity.md R6 — a failure must
 * emit a specific remediation, never a raw interpreter internal).
 *
 * Issue #3574: a blank/omitted parameter with no client-side omission or
 * validation reached the function as `None`, and the function's own
 * arithmetic/string logic then raised on it (e.g. `weight * 42` ->
 * "unsupported operand type(s) for *: 'NoneType' and 'int'"). The editor now
 * omits blank params that declare a default and blocks Run for ones that
 * don't (see user-data-function-editor.tsx runTest), so this should no
 * longer trigger from the Test panel — this is defense in depth for any
 * other caller of this route (generated invocation code, direct API use)
 * and for tracebacks the client-side fix can't anticipate.
 *
 * Returns undefined when the response body isn't a recognizable traceback,
 * so callers fall back to forwarding it unchanged.
 */
function friendlyRuntimeError(rawText: string, parameters: Record<string, unknown>): string | undefined {
  if (!/Traceback \(most recent call last\)/.test(rawText)) return undefined;
  const m = rawText.match(/(\w+(?:Error|Exception)):\s*(.*)\s*$/m);
  const excType = m?.[1] || 'Error';
  const excMsg = (m?.[2] || '').trim();
  // The most common shape: arithmetic/string ops on a parameter that was sent
  // as null. Name the actual parameter(s) rather than the Python internal.
  if (/NoneType/i.test(excMsg)) {
    const nullParams = Object.entries(parameters).filter(([, v]) => v === null).map(([k]) => k);
    if (nullParams.length) {
      const list = nullParams.join(', ');
      const plural = nullParams.length > 1;
      return `The function failed because ${list} ${plural ? 'were' : 'was'} not provided (sent as null). `
        + `Set a value for ${plural ? 'these parameters' : 'this parameter'} — or add a default in the function signature — and run again.`;
    }
  }
  return `The function raised ${excType}${excMsg ? `: ${excMsg}` : ''}.`;
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const id = params.id;
  const b = await req.json().catch(() => ({}));
  const functionName = String(b?.functionName || '').trim();
  if (!functionName) return NextResponse.json({ ok: false, error: 'functionName is required' }, { status: 400 });
  const parameters = b?.parameters || {};

  // Load persisted item state DIRECTLY from Cosmos — not an HTTP self-fetch:
  // behind Front Door, req.nextUrl.origin is the public hostname and a
  // container→own-public-URL round-trip fails silently, so the route then ran
  // the bundled sample instead of the authored source (live-caught, rel-T05).
  let st: any = {};
  try {
    const item = await loadOwnedItem(id, 'user-data-function', session.claims.oid);
    st = (item?.state as any) || {};
  } catch { /* fall through to gate */ }

  // ── 1) Azure-native default: Azure Functions HTTP endpoint ────────────────
  // The item may SELECT an approved endpoint; the base and the key-secret name
  // that are actually used are the deployment's configuration strings.
  const resolved = resolveUdfEndpoint(st.azureFunctionUrl, st.functionKeySecret);
  if ('endpoint' in resolved) {
    const endpoint = resolved.endpoint;
    try {
      const url = `${endpoint.base.replace(/\/+$/, '')}/api/${encodeURIComponent(functionName)}`;
      const headers: Record<string, string> = { 'content-type': 'application/json' };

      // Function key: from the SELECTED ENDPOINT'S config, never from item
      // state. `acceptsPushedSource` is `!keySecretName` by construction in
      // udf-endpoint-policy, so this branch and the source-push branch below
      // are mutually exclusive — a host that runs caller-authored Python is
      // never handed a Key Vault credential.
      if (endpoint.keySecretName) {
        if (!vaultUrl()) {
          return NextResponse.json({
            ok: false, gated: true,
            error: 'A function key is configured for this endpoint but no Key Vault is available.',
            hint: 'Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) and grant the Console UAMI "Key Vault Secrets User", or clear LOOM_UDF_FUNCTION_KEY_SECRET to invoke an anonymous function.',
          }, { status: 409 });
        }
        headers['x-functions-key'] = await getKeyVaultSecretValue(endpoint.keySecretName, 'udf-function-key');
      }

      // Forward the authored source so the Loom udf-runtime host executes THIS
      // item's function, not its bundled sample (udf-runtime/app.py reads
      // `x-udf-source-b64` and loads that source per-request). Without this the
      // default runtime silently ran compute_score for every function (rel-T05).
      let ranAuthoredSource = false;
      const src = typeof st.source === 'string' ? st.source : '';
      let sourceNote: string | undefined;
      if (src.trim() && !endpoint.acceptsPushedSource) {
        sourceNote =
          'This endpoint is configured with a function key, so Loom ran its deployed code rather than ' +
          'pushing this item\'s source to it. Deploy this source to the Function App to run it verbatim.';
      } else if (src.trim()) {
        const b64 = Buffer.from(src, 'utf-8').toString('base64');
        // Guard against unbounded request headers (most gateways cap total header
        // size at 8–64KB). 256KB of base64 (~192KB of source) is far past any real
        // UDF; beyond it we let the deployed/bundled code run rather than push source.
        if (b64.length <= 256 * 1024) {
          headers['x-udf-source-b64'] = b64;
          ranAuthoredSource = true;
        } else {
          sourceNote =
            'Authored source exceeded the inline size limit; the deployed Function App code ran instead. Deploy this source to the Function App to run it verbatim.';
        }
      } else {
        sourceNote = 'This item has no authored source; the runtime executed its bundled/deployed function.';
      }
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(parameters) });
      const text = await res.text();
      // Never surface a raw Python traceback as the failure message (R6) —
      // translate it to a specific, actionable remediation when recognized.
      const friendly = res.ok ? undefined : friendlyRuntimeError(text, parameters);
      return NextResponse.json({
        ok: res.ok, backend: 'azure-functions', status: res.status, body: friendly || text,
        // Be explicit when we did NOT run the item's authored source, so the Test
        // panel result is never silently the bundled sample (no-vaporware.md).
        ...(ranAuthoredSource || !sourceNote ? {} : { note: sourceNote }),
      });
    } catch (e: any) {
      const status = typeof e?.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 502;
      return NextResponse.json({ ok: false, backend: 'azure-functions', error: e?.message || String(e) }, { status });
    }
  }
  // An item that named an endpoint/key this deployment has not approved gets the
  // honest gate NOW — it must never silently fall through to another backend.
  if (st.azureFunctionUrl || st.functionKeySecret) {
    return NextResponse.json(
      { ok: false, gated: true, missing: resolved.gate.missing, error: resolved.gate.detail, hint: resolved.gate.detail },
      { status: 409 },
    );
  }

  // ── 2) Fabric backend: OPT-IN ONLY (never on the default path) ────────────
  if (process.env.LOOM_UDF_BACKEND === 'fabric') {
    // Same rule as the Azure-native path: this branch mints a UAMI Fabric-scoped
    // bearer token, so the host is config and the per-item path is rebuilt under it.
    const fabric = resolveFabricUdfEndpoint(st.fabricEndpoint, st.fabricWorkspaceId, st.fabricItemId);
    if (fabric && 'gate' in fabric) {
      return NextResponse.json(
        { ok: false, gated: true, missing: fabric.gate.missing, error: fabric.gate.detail, hint: fabric.gate.detail },
        { status: 409 },
      );
    }
    const base: string | undefined = fabric?.base;
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
        const friendly = res.ok ? undefined : friendlyRuntimeError(text, parameters);
        return NextResponse.json({ ok: res.ok, backend: 'fabric', status: res.status, body: friendly || text });
      } catch (e: any) {
        return NextResponse.json({ ok: false, backend: 'fabric', error: e?.message || String(e) }, { status: 502 });
      }
    }
  }

  // ── 3) Honest Azure-native gate (default) ─────────────────────────────────
  return NextResponse.json({
    ok: false,
    gated: true,
    missing: 'LOOM_UDF_FUNCTION_BASE',
    error: 'This User Data Function has no execution backend configured yet.',
    hint: 'Azure-native default: deploy platform/fiab/bicep/modules/admin-plane/udf-runtime.bicep (udfRuntimeEnabled, default on) so LOOM_UDF_FUNCTION_BASE is set on the Console Container App, or point LOOM_UDF_FUNCTION_BASE at your own Azure Function App (e.g. https://my-udf.azurewebsites.net). Extra Function App hosts are approved with LOOM_UDF_ALLOWED_FUNCTION_BASES (entry form: https://my-fn.azurewebsites.net=<key-vault-secret-name>); a function key is deployment configuration, never item configuration. (A Fabric backend is opt-in only via LOOM_UDF_BACKEND=fabric.)',
  }, { status: 409 });
});

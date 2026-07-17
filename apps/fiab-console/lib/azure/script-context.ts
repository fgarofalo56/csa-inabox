/**
 * script-context — the REAL deployment values every Loom-surfaced remediation
 * script/command must be pre-filled with (operator rule 2026-07-17: never leave
 * a `<placeholder>` for the user to fill; supply the value).
 *
 * All values come from the deployment's own env (set by admin-plane bicep) with
 * an ARM fallback for the Console UAMI principal (object) id when the env is not
 * yet present (older deploys / Gov before re-deploy). Cached process-wide.
 *
 * Usage: build the script with these values directly, or run a finished string
 * through `fillScriptPlaceholders(text, ctx)` to swap any residual tokens.
 */

const RESOURCE_ID_RE = /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/([^/]+)/i;

export interface ScriptContext {
  /** Console UAMI object/principal id — the `--assignee-object-id` value. */
  consoleUamiPrincipalId: string;
  /** Console UAMI application (client) id. */
  consoleUamiClientId: string;
  /** Console UAMI name (e.g. uami-loom-console-centralus). */
  consoleUamiName: string;
  /** Admin subscription id (where the console + UAMI live). */
  subscriptionId: string;
  /** Admin resource group (holds the console + UAMI). */
  adminResourceGroup: string;
  /** Data landing-zone subscription id (may equal the admin sub). */
  dlzSubscriptionId: string;
  tenantId: string;
  /** Setup Orchestrator UAMI object/principal id (dlz-attach Contributor grant). */
  orchestratorPrincipalId: string;
}

let cached: ScriptContext | null = null;

function parseUamiResourceId(rid: string | undefined): { sub?: string; rg?: string; name?: string } {
  const m = (rid || '').match(RESOURCE_ID_RE);
  return m ? { sub: m[1], rg: m[2], name: m[3] } : {};
}

/**
 * Resolve the Console UAMI principal id — env first (LOOM_UAMI_PRINCIPAL_ID),
 * then an ARM GET on the UAMI resource (`properties.principalId`). Returns '' on
 * total failure so callers can still render the rest of the script and the
 * fill-helper leaves the token visibly unresolved rather than crashing.
 */
async function resolvePrincipalId(): Promise<string> {
  const env = (process.env.LOOM_UAMI_PRINCIPAL_ID || '').trim();
  if (env) return env;
  const rid = (process.env.LOOM_UAMI_RESOURCE_ID || '').trim();
  if (!rid) return '';
  try {
    const [{ armBase, armScope }, { getManagedIdentityCredential }] = await Promise.all([
      import('./cloud-endpoints'),
      import('./aca-managed-identity').then((m) => ({ getManagedIdentityCredential: () => new m.AcaManagedIdentityCredential() })).catch(() => ({ getManagedIdentityCredential: null as any })),
    ]);
    const { DefaultAzureCredential } = await import('@azure/identity');
    const cred = getManagedIdentityCredential?.() ?? new DefaultAzureCredential();
    const tok = await cred.getToken(armScope());
    if (!tok?.token) return '';
    const { fetchWithTimeout } = await import('./fetch-with-timeout');
    const r = await fetchWithTimeout(`${armBase()}${rid}?api-version=2023-01-31`, {
      headers: { authorization: `Bearer ${tok.token}` },
    });
    if (!r.ok) return '';
    const j = await r.json().catch(() => null) as { properties?: { principalId?: string } } | null;
    return j?.properties?.principalId || '';
  } catch {
    return '';
  }
}

/** The resolved deployment script context (cached process-wide). */
export async function getScriptContext(): Promise<ScriptContext> {
  if (cached) return cached;
  const fromRid = parseUamiResourceId(process.env.LOOM_UAMI_RESOURCE_ID);
  const ctx: ScriptContext = {
    consoleUamiPrincipalId: await resolvePrincipalId(),
    consoleUamiClientId: (process.env.LOOM_UAMI_CLIENT_ID || '').trim(),
    consoleUamiName: fromRid.name || (process.env.LOOM_UAMI_NAME || '').trim() || '',
    subscriptionId: (process.env.LOOM_SUBSCRIPTION_ID || fromRid.sub || '').trim(),
    adminResourceGroup: (process.env.LOOM_ADMIN_RESOURCE_GROUP || fromRid.rg || '').trim(),
    dlzSubscriptionId: (process.env.LOOM_DLZ_SUBSCRIPTION_ID || process.env.LOOM_SUBSCRIPTION_ID || fromRid.sub || '').trim(),
    tenantId: (process.env.AZURE_TENANT_ID || process.env.LOOM_TENANT_ID || '').trim(),
    orchestratorPrincipalId: (process.env.LOOM_ORCHESTRATOR_PRINCIPAL_ID || '').trim(),
  };
  cached = ctx;
  return ctx;
}

/**
 * Swap any residual `<...>` placeholder tokens in a finished script/command
 * string with the resolved real values. Only tokens with a known real value are
 * replaced — an unknown/blank one is left as-is (honest: better a visible
 * placeholder than a silently-wrong empty arg).
 */
export function fillScriptPlaceholders(text: string, ctx: ScriptContext): string {
  const map: Record<string, string> = {
    '<console-uami-principal-id>': ctx.consoleUamiPrincipalId,
    '<uami-principal-id>': ctx.consoleUamiPrincipalId,
    '<uami-object-id>': ctx.consoleUamiPrincipalId,
    '<orchestrator-principal-object-id>': ctx.orchestratorPrincipalId,
    '<orchestrator-principal-id>': ctx.orchestratorPrincipalId,
    '<console-uami-object-id>': ctx.consoleUamiPrincipalId,
    '<console-uami>': ctx.consoleUamiName,
    '<console-uami-name>': ctx.consoleUamiName,
    '<uami-client-id>': ctx.consoleUamiClientId,
    '<uami-name>': ctx.consoleUamiName,
    '<admin-resource-group>': ctx.adminResourceGroup,
    '<dlz-resource-group>': ctx.adminResourceGroup, // best-effort; DLZ RG varies per LZ
    '<subscription-id>': ctx.subscriptionId,
    '<sub-id>': ctx.subscriptionId,
    '<tenant-id>': ctx.tenantId,
  };
  let out = text;
  for (const [token, val] of Object.entries(map)) {
    if (val) out = out.split(token).join(val);
  }
  return out;
}

/** Convenience: resolve context then fill a string. */
export async function fillScript(text: string): Promise<string> {
  return fillScriptPlaceholders(text, await getScriptContext());
}

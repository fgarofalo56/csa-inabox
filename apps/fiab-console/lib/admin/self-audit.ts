/**
 * CSA Loom self-audit / health engine.
 *
 * A self-review of the running console: does it actually have everything it
 * needs — identity, data plane, the Azure services each workload calls,
 * permissions, and security posture — wired, deployed, and reachable?
 *
 * Every check is REAL (per .claude/rules/no-vaporware.md):
 *   - env-presence checks ARE the real feature gates (the per-client
 *     *ConfigGate() helpers check exactly these vars),
 *   - live probes hit the actual service (Cosmos / AOAI) and detect 401/403,
 *   - the bootstrap-admin check mirrors lib/auth/feature-gate.isTenantAdmin.
 *
 * Each result carries a precise remediation. Where the fix is safe to apply
 * from the running console identity (e.g. createIfNotExists the Cosmos
 * containers) it exposes a `fixId` the healer can apply with admin approval.
 * Deploy-time fixes (env vars, RBAC grants needing elevated rights) are NOT
 * faked — they return the exact command / bicep param + redeploy:true so the
 * healer surfaces it for the admin instead of pretending to fix it.
 */
export type AuditStatus = 'pass' | 'warn' | 'fail';
export type AuditSeverity = 'critical' | 'recommended' | 'optional';
export type AuditCategory =
  | 'identity'
  | 'data-plane'
  | 'azure-services'
  | 'permissions'
  | 'security'
  | 'enrichment';

export interface CheckResult {
  id: string;
  category: AuditCategory;
  title: string;
  severity: AuditSeverity;
  status: AuditStatus;
  /** What the check observed. */
  detail: string;
  /** Exact action to resolve a warn/fail. */
  remediation?: string;
  /** Set when the healer can apply a safe runtime fix (admin-approved). */
  fixId?: string;
  /** True when the only resolution is a redeploy / RBAC grant (not runtime). */
  redeploy?: boolean;
  /** Optional doc/portal link. */
  docs?: string;
}

const env = (k: string) => (process.env[k] || '').trim();
const has = (k: string) => env(k).length > 0;
const anyHas = (...ks: string[]) => ks.some(has);

// ── env-presence check helper ──────────────────────────────────────────────
interface EnvSpec {
  id: string;
  category: AuditCategory;
  title: string;
  severity: AuditSeverity;
  /** All of these must be present (or an anyOf group satisfied). */
  required?: string[];
  /** At least one of each inner group must be present. */
  anyOf?: string[][];
  remediation: string;
  docs?: string;
  /** When true a miss is a 'warn' (optional feature) instead of 'fail'. */
  warnOnMiss?: boolean;
}

function evalEnv(spec: EnvSpec): CheckResult {
  const missing: string[] = [];
  for (const k of spec.required || []) if (!has(k)) missing.push(k);
  for (const group of spec.anyOf || []) if (!group.some(has)) missing.push(group.join(' | '));
  const ok = missing.length === 0;
  const failStatus: AuditStatus = spec.warnOnMiss || spec.severity !== 'critical' ? 'warn' : 'fail';
  return {
    id: spec.id,
    category: spec.category,
    title: spec.title,
    severity: spec.severity,
    status: ok ? 'pass' : failStatus,
    detail: ok ? 'Configured.' : `Missing: ${missing.join(', ')}.`,
    remediation: ok ? undefined : spec.remediation,
    redeploy: ok ? undefined : true,
    docs: spec.docs,
  };
}

/** The declarative env-presence checks (the backbone of the audit). */
const ENV_CHECKS: EnvSpec[] = [
  // ── identity ──
  {
    id: 'session-secret', category: 'identity', title: 'Session signing secret', severity: 'critical',
    required: ['SESSION_SECRET'],
    remediation: 'Set SESSION_SECRET (resolved in CI from Key Vault by the deploy SP; never on disk). Without it sessions cannot be minted/verified.',
  },
  {
    id: 'entra-app', category: 'identity', title: 'Entra sign-in app', severity: 'critical',
    anyOf: [['LOOM_ENTRA_CLIENT_ID', 'AZURE_CLIENT_ID'], ['LOOM_ENTRA_TENANT_ID', 'AZURE_TENANT_ID']],
    remediation: 'Set LOOM_ENTRA_CLIENT_ID + LOOM_ENTRA_TENANT_ID (the AAD app users sign in with).',
  },
  {
    id: 'uami', category: 'identity', title: 'Console managed identity (UAMI)', severity: 'critical',
    required: ['LOOM_UAMI_CLIENT_ID'],
    remediation: 'Set LOOM_UAMI_CLIENT_ID to the user-assigned managed identity client id. Every Azure data-plane call authenticates as this identity.',
  },
  // ── data-plane (Cosmos = the Loom store; required to run at all) ──
  {
    id: 'cosmos-config', category: 'data-plane', title: 'Cosmos DB (Loom store)', severity: 'critical',
    anyOf: [['LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT']],
    remediation: 'Set LOOM_COSMOS_ENDPOINT (and LOOM_COSMOS_DATABASE) — Cosmos holds every workspace, item, permission grant, and config. Loom cannot run without it.',
    docs: 'https://learn.microsoft.com/azure/cosmos-db/',
  },
  {
    id: 'subscription', category: 'data-plane', title: 'Azure subscription + resource groups', severity: 'critical',
    required: ['LOOM_SUBSCRIPTION_ID'],
    anyOf: [['LOOM_DLZ_RG', 'LOOM_ADMIN_RG']],
    remediation: 'Set LOOM_SUBSCRIPTION_ID and at least one of LOOM_DLZ_RG / LOOM_ADMIN_RG so ARM discovery + scaling can target the deployment.',
  },
  // ── permissions ──
  {
    id: 'bootstrap-admin', category: 'permissions', title: 'Bootstrap tenant admin', severity: 'critical',
    anyOf: [['LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID']],
    remediation: 'Set LOOM_TENANT_ADMIN_OID to your Entra user OID (or LOOM_TENANT_ADMIN_GROUP_ID to a group you are in) — deploy params loomTenantAdminOid / loomTenantAdminGroupId. Members bypass the feature-permission gate with full Admin; this is how the first admin gets in before any grants exist and fixes the "Access denied (403)" on /admin/permissions.',
    docs: '/admin/permissions',
  },
  // ── azure services (optional workloads → warn, not fail) ──
  {
    id: 'svc-synapse', category: 'azure-services', title: 'Synapse (warehouse / notebooks / pipelines)', severity: 'recommended',
    required: ['LOOM_SYNAPSE_WORKSPACE'], warnOnMiss: true,
    remediation: 'Set LOOM_SYNAPSE_WORKSPACE (+ LOOM_SYNAPSE_DEDICATED_POOL for warehouse) to enable Synapse-backed warehouse, notebook, and pipeline items.',
  },
  {
    id: 'svc-adx', category: 'azure-services', title: 'Azure Data Explorer (KQL / Real-Time)', severity: 'recommended',
    required: ['LOOM_KUSTO_CLUSTER_URI'], warnOnMiss: true,
    remediation: 'Set LOOM_KUSTO_CLUSTER_URI (+ LOOM_KUSTO_DEFAULT_DB) to enable KQL databases, eventhouses, and Real-Time dashboards.',
  },
  {
    id: 'svc-eventhubs', category: 'azure-services', title: 'Event Hubs (eventstream)', severity: 'recommended',
    required: ['LOOM_EVENTHUB_NAMESPACE'], warnOnMiss: true,
    remediation: 'Set LOOM_EVENTHUB_NAMESPACE (+ LOOM_EVENTHUB_RG/SUB) to enable the Azure-native eventstream backend.',
  },
  {
    id: 'svc-adls', category: 'azure-services', title: 'ADLS Gen2 (lakehouse / Bronze)', severity: 'recommended',
    anyOf: [['LOOM_ADLS_ACCOUNT', 'LOOM_LANDING_URL', 'LOOM_BRONZE_URL']], warnOnMiss: true,
    remediation: 'Set LOOM_ADLS_ACCOUNT (or the LOOM_{LANDING,BRONZE,SILVER,GOLD}_URL DLZ container URLs) to enable the Azure-native lakehouse + mirror Bronze sink.',
  },
  {
    id: 'svc-aisearch', category: 'azure-services', title: 'Azure AI Search (RAG indexes)', severity: 'optional',
    required: ['LOOM_AI_SEARCH_SERVICE'], warnOnMiss: true,
    remediation: 'Set LOOM_AI_SEARCH_SERVICE to enable AI Search index items + RAG apps.',
  },
  {
    id: 'svc-aoai', category: 'azure-services', title: 'Azure OpenAI / Foundry (Copilot + agents)', severity: 'recommended',
    anyOf: [['LOOM_AOAI_ENDPOINT', 'LOOM_FOUNDRY_PROJECT_ENDPOINT', 'LOOM_FOUNDRY_ENDPOINT']], warnOnMiss: true,
    remediation: 'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or a Foundry project endpoint) so Copilot, the help agent, and data agents have a model. Deploy a model from the AI Foundry hub if none exists.',
  },
  {
    id: 'svc-monitor-alerts', category: 'azure-services', title: 'Azure Monitor (Activator alerts)', severity: 'optional',
    required: ['LOOM_LOG_ANALYTICS_RESOURCE_ID'], anyOf: [['LOOM_ALERT_RG', 'LOOM_ADMIN_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_LOG_ANALYTICS_RESOURCE_ID (alert query scope) + LOOM_ALERT_RG so the Azure-native Activator can create scheduled-query alert rules.',
  },
  {
    id: 'svc-adf', category: 'azure-services', title: 'Azure Data Factory (mirror CDC)', severity: 'optional',
    anyOf: [['LOOM_ADF_FACTORY', 'LOOM_ADF_RG']], warnOnMiss: true,
    remediation: 'Set LOOM_ADF_FACTORY (+ LOOM_ADF_RG / LOOM_ADF_SUBSCRIPTION_ID) to enable the ADF-CDC mirrored-database backend (source SQL → ADLS Bronze).',
  },
  // ── enrichment ──
  {
    id: 'graph-users', category: 'enrichment', title: 'Microsoft Graph user enrichment', severity: 'optional',
    required: ['LOOM_GRAPH_USERS_ENABLED'], warnOnMiss: true,
    remediation: 'Set LOOM_GRAPH_USERS_ENABLED=true and grant the Console UAMI Directory.Read.All in Microsoft Graph to enrich the Users page with display name + department. Without it the page still shows UPN + activity + roles from Cosmos.',
    docs: 'https://learn.microsoft.com/graph/permissions-reference#directoryreadall',
  },
  {
    id: 'purview', category: 'azure-services', title: 'Microsoft Purview (governance)', severity: 'optional',
    required: ['LOOM_PURVIEW_ACCOUNT'], warnOnMiss: true,
    remediation: 'Set LOOM_PURVIEW_ACCOUNT to link a Purview account. Domains + data-quality work Loom-native (Cosmos) without it; Purview adds the external mirror + scan plane.',
  },
];

// ── live probes (best-effort; bounded) ──────────────────────────────────────
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function probeCosmos(): Promise<CheckResult> {
  const base = { id: 'probe-cosmos', category: 'data-plane' as const, title: 'Cosmos reachable + containers present', severity: 'critical' as const };
  if (!anyHas('LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT')) {
    return { ...base, status: 'fail', detail: 'Cosmos endpoint not configured.', remediation: 'Set LOOM_COSMOS_ENDPOINT first.', redeploy: true };
  }
  try {
    const { featurePermissionsContainer } = await import('@/lib/azure/cosmos-client');
    await withTimeout(featurePermissionsContainer(), 8000); // triggers ensure() → createIfNotExists all
    return { ...base, status: 'pass', detail: 'Cosmos reachable; Loom containers present (createIfNotExists OK).' };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = /403|forbidden|not authorized/i.test(msg);
    return {
      ...base, status: 'fail',
      detail: `Cosmos probe failed: ${msg}`,
      remediation: denied
        ? 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Cosmos DB Built-in Data Contributor" role on the account so it can read/write containers.'
        : 'Verify LOOM_COSMOS_ENDPOINT + network access (private endpoint / firewall) to the Cosmos account.',
      fixId: denied ? undefined : 'ensure-cosmos',
      redeploy: denied,
    };
  }
}

async function probeAoai(): Promise<CheckResult> {
  const base = { id: 'probe-aoai', category: 'azure-services' as const, title: 'Copilot / agents model reachable', severity: 'recommended' as const };
  // Lazy import to avoid a static cycle with copilot-orchestrator (which
  // registers loom_self_audit → imports this module).
  const { resolveAoaiTarget, NoAoaiDeploymentError } = await import('@/lib/azure/copilot-orchestrator');
  try {
    const t = await withTimeout(resolveAoaiTarget(null), 8000);
    return { ...base, status: 'pass', detail: `AOAI target resolved: ${t.deployment} @ ${t.endpoint}.` };
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return {
        ...base, status: 'warn',
        detail: 'No AOAI model deployment resolved.',
        remediation: 'Deploy a model from the AI Foundry hub ("Quota + usage" → Deploy gpt-4o-mini), or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT. Copilot, the help agent, and data agents all use it.',
        redeploy: true,
      };
    }
    return { ...base, status: 'warn', detail: `AOAI probe failed: ${e?.message || String(e)}`, remediation: 'Verify the Foundry/AOAI endpoint + that the Console UAMI has "Cognitive Services OpenAI User" on the account.', redeploy: true };
  }
}

// ── security posture (runtime-observable) ───────────────────────────────────
function securityChecks(): CheckResult[] {
  const out: CheckResult[] = [];
  const isProd = (env('NODE_ENV') || 'production') === 'production';
  out.push({
    id: 'sec-session-secret-strength', category: 'security', title: 'Session secret strength', severity: 'recommended',
    status: env('SESSION_SECRET').length >= 32 ? 'pass' : (has('SESSION_SECRET') ? 'warn' : 'fail'),
    detail: has('SESSION_SECRET') ? `${env('SESSION_SECRET').length} chars` : 'unset',
    remediation: 'Use a ≥32-char random SESSION_SECRET (resolved from Key Vault in CI).',
    redeploy: true,
  });
  out.push({
    id: 'sec-https', category: 'security', title: 'Secure cookies / HTTPS origin', severity: 'recommended',
    status: isProd ? 'pass' : 'warn',
    detail: isProd ? 'Running with NODE_ENV=production (secure cookies).' : `NODE_ENV=${env('NODE_ENV') || 'unset'} — cookies may not be marked Secure.`,
    remediation: 'Run the console with NODE_ENV=production behind HTTPS so session cookies are Secure + SameSite.',
  });
  out.push({
    id: 'sec-tenant-isolation', category: 'security', title: 'Tenant admin restriction set', severity: 'recommended',
    status: anyHas('LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID') ? 'pass' : 'warn',
    detail: anyHas('LOOM_TENANT_ADMIN_OID', 'LOOM_TENANT_ADMIN_GROUP_ID') ? 'Bootstrap admin principal restricted.' : 'No bootstrap admin principal set — admin surfaces are unreachable until granted.',
    remediation: 'Set loomTenantAdminOid / loomTenantAdminGroupId so only your principal bootstraps admin.',
    redeploy: true,
  });
  return out;
}

export interface AuditReport {
  generatedAt: string;
  score: number;            // 0-100 weighted by severity
  summary: { pass: number; warn: number; fail: number; total: number; fixable: number };
  results: CheckResult[];
}

/** Run the full self-audit. `now` is passed in so the engine stays pure. */
export async function runSelfAudit(now: string): Promise<AuditReport> {
  const results: CheckResult[] = ENV_CHECKS.map(evalEnv);
  const [cosmos, aoai] = await Promise.all([probeCosmos(), probeAoai()]);
  results.push(cosmos, aoai, ...securityChecks());

  const weight: Record<AuditSeverity, number> = { critical: 3, recommended: 2, optional: 1 };
  const scoreOf: Record<AuditStatus, number> = { pass: 1, warn: 0.5, fail: 0 };
  let num = 0, den = 0;
  for (const r of results) { num += weight[r.severity] * scoreOf[r.status]; den += weight[r.severity]; }
  const score = den ? Math.round((num / den) * 100) : 100;

  const summary = {
    pass: results.filter((r) => r.status === 'pass').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    total: results.length,
    fixable: results.filter((r) => r.fixId).length,
  };
  // Stable order: fails first, then warns, then pass; within, by category.
  const rank: Record<AuditStatus, number> = { fail: 0, warn: 1, pass: 2 };
  results.sort((a, b) => rank[a.status] - rank[b.status] || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  return { generatedAt: now, score, summary, results };
}

// ── healer: runtime-safe fixes the console identity can actually apply ───────
export interface FixOutcome { ok: boolean; detail: string; }

/** Apply a runtime-safe fix by id (admin-approved). Returns honest outcome. */
export async function applyFix(fixId: string): Promise<FixOutcome> {
  switch (fixId) {
    case 'ensure-cosmos': {
      try {
        const m = await import('@/lib/azure/cosmos-client');
        // Touch a representative set of containers; each getter calls ensure()
        // which createIfNotExists the database + every Loom container.
        await m.featurePermissionsContainer();
        await m.workspacesContainer();
        await m.itemsContainer();
        return { ok: true, detail: 'Cosmos database + all Loom containers ensured (createIfNotExists).' };
      } catch (e: any) {
        return { ok: false, detail: `Could not ensure Cosmos containers: ${e?.message || String(e)}` };
      }
    }
    default:
      return { ok: false, detail: `Fix '${fixId}' is not a runtime-applicable action. Apply the listed remediation (env var / RBAC grant) and redeploy.` };
  }
}

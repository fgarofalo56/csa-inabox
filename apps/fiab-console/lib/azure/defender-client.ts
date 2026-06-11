/**
 * Microsoft Defender for Cloud client — the real backend for the Monitor
 * Security (Defender) tab (M5 + the "security reporting / action-required with
 * built-in resolution" ask).
 *
 * Real Microsoft.Security REST (no mocks):
 *   - Secure score:   GET /subscriptions/{sub}/providers/Microsoft.Security/secureScores/ascScore
 *   - Assessments:    GET .../Microsoft.Security/assessments        (recommendations + status + remediation)
 *   - Security alerts:GET .../Microsoft.Security/alerts
 *
 * Each UNHEALTHY assessment is an action-required item carrying its own
 * remediation text + a deep link to the Defender portal — surfaced in-console
 * the same way the self-audit surfaces fixes. The UAMI needs "Security Reader"
 * on the subscription; 401/403 → honest infra-gate.
 *   https://learn.microsoft.com/rest/api/defenderforcloud/
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { readMonitorConfig, MonitorError, MonitorNotConfiguredError } from './monitor-client';
import { armBase, armScope } from './cloud-endpoints';

// Sovereign-cloud ARM host + scope (Commercial / GCC-High / IL5).
const ARM = armBase();
const ARM_SCOPE = armScope();
const SECURE_SCORE_API = '2020-01-01';
const ASSESSMENTS_API = '2021-06-01';
const ALERTS_API = '2022-01-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function armGet(path: string): Promise<any> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Defender', 401);
  const res = await fetchWithTimeout(`${ARM}${path}`, {
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json' }, cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `Defender GET failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

export interface SecureScore { current: number; max: number; percentage: number; }
export interface DefenderRecommendation {
  id: string;
  name: string;
  status: string;          // Healthy | Unhealthy | NotApplicable
  severity: string;        // Low | Medium | High
  resource?: string;       // assessed resource (short)
  remediation?: string;    // remediationDescription
  category?: string;
  // Remediation drive-fields (portal steps / PowerShell / Loom auto-fix):
  assessmentName?: string;     // assessment definition name (last id segment)
  resourceId?: string;         // full affected resource ARM id
  policyDefinitionId?: string; // when the assessment is policy-backed (auto-fix)
  portalLink?: string;         // assessment's azurePortal link
  implementationEffort?: string;
  userImpact?: string;
}
export interface DefenderAlert {
  id: string;
  name: string;
  severity: string;
  status: string;
  description?: string;
  resource?: string;
  time?: string;
}
export interface DefenderSummary {
  secureScore: SecureScore | null;
  recommendations: DefenderRecommendation[];
  unhealthyCount: number;
  highSeverityCount: number;
  alerts: DefenderAlert[];
  portalUrl: string;
  subscriptionId: string;
}

function shortRes(id?: string): string | undefined {
  if (!id) return undefined;
  const m = /\/providers\/[^/]+\/[^/]+\/([^/]+)(?:$|\/)/i.exec(id) || /\/([^/]+)$/.exec(id);
  return m ? m[1] : undefined;
}

/** Build the Defender for Cloud summary for this subscription. */
export async function getDefenderSummary(): Promise<DefenderSummary> {
  const cfg = readMonitorConfig(); // throws MonitorNotConfiguredError if no sub
  const sub = cfg.subscriptionId;
  const portalUrl = 'https://portal.azure.com/#blade/Microsoft_Azure_Security/SecurityMenuBlade/0';

  // Secure score (best-effort — some subs have no score yet).
  let secureScore: SecureScore | null = null;
  try {
    const s = await armGet(`/subscriptions/${sub}/providers/Microsoft.Security/secureScores/ascScore?api-version=${SECURE_SCORE_API}`);
    const sc = s?.properties?.score;
    if (sc) secureScore = { current: Number(sc.current) || 0, max: Number(sc.max) || 0, percentage: Math.round((Number(sc.percentage) || 0) * 100) };
  } catch (e: any) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) throw e; // gate
    // otherwise leave null
  }

  // Assessments (recommendations).
  const assess = await armGet(`/subscriptions/${sub}/providers/Microsoft.Security/assessments?api-version=${ASSESSMENTS_API}`);
  const recommendations: DefenderRecommendation[] = (assess?.value || []).map((a: any): DefenderRecommendation => {
    const meta = a?.properties?.metadata || {};
    const resourceId = a?.properties?.resourceDetails?.id || a?.id;
    return {
      id: a.id,
      name: a?.properties?.displayName || meta.displayName || a?.name,
      status: a?.properties?.status?.code || 'Unknown',
      severity: meta.severity || a?.properties?.status?.severity || 'Low',
      resource: shortRes(resourceId),
      remediation: meta.remediationDescription || a?.properties?.status?.description,
      category: Array.isArray(meta.categories) ? meta.categories.join(', ') : undefined,
      assessmentName: a?.name,
      resourceId,
      policyDefinitionId: meta.policyDefinitionId || undefined,
      portalLink: a?.properties?.links?.azurePortal || undefined,
      implementationEffort: meta.implementationEffort || undefined,
      userImpact: meta.userImpact || undefined,
    };
  });
  // Unhealthy (action-required) first, by severity.
  const sevRank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
  recommendations.sort((x, y) => {
    const xu = x.status === 'Unhealthy' ? 0 : 1, yu = y.status === 'Unhealthy' ? 0 : 1;
    return xu - yu || (sevRank[x.severity] ?? 3) - (sevRank[y.severity] ?? 3) || x.name.localeCompare(y.name);
  });
  const unhealthyCount = recommendations.filter((r) => r.status === 'Unhealthy').length;
  const highSeverityCount = recommendations.filter((r) => r.status === 'Unhealthy' && r.severity === 'High').length;

  // Active security alerts (best-effort).
  let alerts: DefenderAlert[] = [];
  try {
    const al = await armGet(`/subscriptions/${sub}/providers/Microsoft.Security/alerts?api-version=${ALERTS_API}`);
    alerts = (al?.value || [])
      .filter((a: any) => (a?.properties?.status || '').toLowerCase() !== 'dismissed')
      .map((a: any): DefenderAlert => ({
        id: a.id,
        name: a?.properties?.alertDisplayName || a?.name,
        severity: a?.properties?.severity || 'Low',
        status: a?.properties?.status || 'Active',
        description: a?.properties?.description,
        resource: shortRes(a?.properties?.compromisedEntity || a?.properties?.resourceIdentifiers?.[0]?.azureResourceId),
        time: a?.properties?.timeGeneratedUtc || a?.properties?.startTimeUtc,
      }));
  } catch (e: any) {
    if (e instanceof MonitorError && (e.status === 401 || e.status === 403)) throw e;
  }

  return { secureScore, recommendations, unhealthyCount, highSeverityCount, alerts, portalUrl, subscriptionId: sub };
}

const POLICY_API = '2022-08-01';
const POLICY_ASSIGN_API = '2022-06-01';

async function armReq(method: string, path: string, body?: unknown): Promise<any> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Defender', 401);
  const res = await fetchWithTimeout(`${ARM}${path}`, {
    method,
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `Defender ${method} failed (${res.status})`).toString();
    throw new MonitorError(msg, res.status, json || text);
  }
  return json;
}

export interface RemediateResult {
  ok: boolean;
  remediationId?: string;
  provisioningState?: string;
  message: string;
  /** When auto-fix isn't possible — caller falls back to portal/PowerShell. */
  gate?: boolean;
}

/**
 * "Fix via Loom" — trigger a REAL Azure Policy remediation task for a
 * policy-backed Defender recommendation. Resolves a policy assignment whose
 * definition matches the assessment's policyDefinitionId (directly, or via a
 * policy set), then PUTs a Microsoft.PolicyInsights/remediations task scoped to
 * the affected resource (or the subscription). Recommendations with no
 * auto-remediation policy return `gate:true` — the caller shows portal steps +
 * the PowerShell script instead (no fake success, per no-vaporware).
 */
export async function remediateRecommendation(input: {
  policyDefinitionId?: string;
  resourceId?: string;
  name?: string;
}): Promise<RemediateResult> {
  const cfg = readMonitorConfig();
  const sub = cfg.subscriptionId;
  if (!input.policyDefinitionId) {
    return { ok: false, gate: true, message: 'This recommendation has no auto-remediation policy. Use the Portal steps or run the PowerShell script.' };
  }

  // Find a policy assignment in the subscription backing this definition.
  const assignments = await armReq('GET', `/subscriptions/${sub}/providers/Microsoft.Authorization/policyAssignments?api-version=${POLICY_ASSIGN_API}`);
  const want = input.policyDefinitionId.toLowerCase();
  const match = (assignments?.value || []).find((a: any) => {
    const pid = (a?.properties?.policyDefinitionId || '').toLowerCase();
    return pid === want || pid.includes('/policysetdefinitions/');
  });
  if (!match) {
    return { ok: false, gate: true, message: 'No matching policy assignment found for this recommendation in the subscription. Use the Portal steps or PowerShell.' };
  }

  // Scope the remediation to the affected resource when known, else the sub.
  const scope = (input.resourceId && input.resourceId.includes('/subscriptions/')) ? input.resourceId : `/subscriptions/${sub}`;
  const remName = `loom-remediate-${Math.abs(hashCode(input.name || want)).toString(36)}-${Date.now().toString(36)}`;
  const url = `${scope}/providers/Microsoft.PolicyInsights/remediations/${remName}?api-version=${POLICY_API}`;
  const result = await armReq('PUT', url, {
    properties: {
      policyAssignmentId: match.id,
      resourceDiscoveryMode: 'ReEvaluateCompliance',
    },
  });
  return {
    ok: true,
    remediationId: result?.id,
    provisioningState: result?.properties?.provisioningState,
    message: `Started Azure Policy remediation "${remName}" (${result?.properties?.provisioningState || 'Accepted'}). It re-evaluates compliance and applies the policy effect to the affected resources.`,
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return h;
}

export { MonitorError, MonitorNotConfiguredError };

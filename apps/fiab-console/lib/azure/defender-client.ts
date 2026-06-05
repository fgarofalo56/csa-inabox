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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { readMonitorConfig, MonitorError, MonitorNotConfiguredError } from './monitor-client';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const SECURE_SCORE_API = '2020-01-01';
const ASSESSMENTS_API = '2021-06-01';
const ALERTS_API = '2022-01-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

async function armGet(path: string): Promise<any> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new MonitorError('Failed to acquire ARM token for Defender', 401);
  const res = await fetch(`${ARM}${path}`, {
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
  const recommendations: DefenderRecommendation[] = (assess?.value || []).map((a: any): DefenderRecommendation => ({
    id: a.id,
    name: a?.properties?.displayName || a?.name,
    status: a?.properties?.status?.code || 'Unknown',
    severity: a?.properties?.metadata?.severity || a?.properties?.status?.severity || 'Low',
    resource: shortRes(a?.properties?.resourceDetails?.id || a?.id),
    remediation: a?.properties?.metadata?.remediationDescription || a?.properties?.status?.description,
    category: Array.isArray(a?.properties?.metadata?.categories) ? a.properties.metadata.categories.join(', ') : undefined,
  }));
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

  return { secureScore, recommendations, unhealthyCount, highSeverityCount, alerts, portalUrl };
}

export { MonitorError, MonitorNotConfiguredError };

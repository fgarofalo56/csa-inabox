/**
 * Live data bindings for the CoE report viewer.
 *
 * The CoE report viewer (report-canvas) renders each template's visuals over a
 * {@link SampleData} table-set. By default those tables are the clearly-labelled
 * TMDL SAMPLE rows bundled with the template. This module makes "live" REAL:
 * for the (templateId, entity) pairs where CSA Loom already has a first-party
 * Azure backend, it resolves the SAME `{columns, rows}` shape as
 * `parseSampleData` — but from the deployment's OWN Azure estate (Cost
 * Management, Log Analytics, Azure Resource Graph, Defender for Cloud) — so the
 * admin's report renders their real numbers with ZERO manual configuration.
 *
 * Azure-native only (no-fabric-dependency.md): never contacts Power BI / Fabric.
 * Honest (no-vaporware.md): every resolver returns REAL data or an explicit
 *   {source:'error'|'empty', note} explaining exactly why there are no rows —
 *   never zeros-as-data, never a fabricated value, and NEVER bundled SAMPLE
 *   rows. Entities with no first-party Loom backend return a real EMPTY result.
 *
 * Each resolver returns an {@link EntityBindingResult}:
 *   - {source:'live',  table}  → real rows from the customer's estate
 *   - {source:'empty', note}   → a real query ran but produced no rows, OR the
 *                                 source has no live binding → caller renders a
 *                                 REAL EMPTY table (schema, zero rows) + `note`
 *   - {source:'error', note}   → the backend errored / isn't provisioned;
 *                                 caller renders a REAL EMPTY table + the gate
 *
 * There is NO sample-data render path: a missing / empty / errored source shows
 * zero real rows, never fabricated sample rows.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import { getLoomCostSummary, loomSubscriptions, type CostSummary } from '@/lib/azure/cost-client';
import { queryLogs, logAnalyticsWorkspaceId } from '@/lib/azure/monitor-client';
import { getDefenderSummary, type DefenderSummary } from '@/lib/azure/defender-client';
import type { SampleData, SampleTable } from './tmdl-sample';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-entity provenance after a live render. */
export type EntitySource = 'live' | 'empty' | 'error';

export interface EntityBindingResult {
  source: EntitySource;
  /** Human-readable provenance / gate reason (shown inline in the viewer). */
  note?: string;
  /** Present only when source === 'live'. Same shape as parseSampleData output. */
  table?: SampleTable;
}

/** Report parameters — resolved from the deployment's own env, overridable. */
export interface ReportParams {
  tenantId: string;
  subscriptionId: string;
  /** The subscription set live queries scope to (ARG / Cost). */
  subscriptionIds: string[];
  billingScope: string;
  /** Display-only: the deployment's configured Log Analytics workspace. */
  logAnalyticsWorkspaceId: string;
  managementApiBase: string;
}

/** Overrides an admin can supply to point a render at a different scope. */
export interface ReportParamOverrides {
  tenantId?: string;
  subscriptionId?: string;
  billingScope?: string;
  managementApiBase?: string;
}

/** Result of a full-report live merge. */
export interface LiveRenderResult {
  /** Per-entity render data: live table when available, else the sample table. */
  live: SampleData;
  /** Per-entity provenance for truthful labelling in the UI. */
  dataSources: Record<string, EntityBindingResult>;
  /** The effective parameters the render used. */
  params: ReportParams;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Resolve report parameters: the deployment's OWN environment first (so the
 * admin's estate renders live with no manual entry), with explicit overrides
 * layered on top.
 */
export function resolveReportParams(overrides: ReportParamOverrides = {}): ReportParams {
  const subscriptionId = (overrides.subscriptionId || process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  // When the admin overrides a single subscription, scope live queries to it;
  // otherwise use the full set of subscriptions the Loom deployment spans.
  const subscriptionIds = overrides.subscriptionId
    ? [overrides.subscriptionId.trim()]
    : dedupe(loomSubscriptionsSafe(subscriptionId));
  const billingScope = (overrides.billingScope
    || (subscriptionId ? `/subscriptions/${subscriptionId}` : '')).trim();
  return {
    tenantId: (overrides.tenantId || process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || '').trim(),
    subscriptionId,
    subscriptionIds,
    billingScope,
    logAnalyticsWorkspaceId: logAnalyticsWorkspaceId() || '',
    managementApiBase: (overrides.managementApiBase || armBase()).trim(),
  };
}

function loomSubscriptionsSafe(fallback: string): string[] {
  try {
    const subs = loomSubscriptions();
    return subs.length ? subs : (fallback ? [fallback] : []);
  } catch {
    return fallback ? [fallback] : [];
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter((s) => s && s.trim()).map((s) => s.trim())));
}

// ---------------------------------------------------------------------------
// Shared per-render context (memoizes expensive, multi-entity backends)
// ---------------------------------------------------------------------------

export class RenderCtx {
  private memo = new Map<string, Promise<unknown>>();
  once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key) as Promise<T>;
  }
}

// ---------------------------------------------------------------------------
// Azure Resource Graph runner (real ARM REST; same credential chain as the
// other Loom ARM clients). Used by the Inventory + Identity resolvers.
// ---------------------------------------------------------------------------

const ARM = armBase();
const ARM_SCOPE = armScope();
const ARG_API = '2022-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

class LiveBindingError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'LiveBindingError';
  }
}

/** Run one Azure Resource Graph KQL query, returning rows as objects. */
async function runArg(query: string, subscriptions: string[]): Promise<Record<string, unknown>[]> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new LiveBindingError('Failed to acquire ARM token', 401);
  const payload: Record<string, unknown> = {
    query,
    options: { resultFormat: 'objectArray', $top: 1000 },
  };
  if (subscriptions.length) payload.subscriptions = subscriptions;
  const res = await fetchWithTimeout(
    `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=${ARG_API}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
    },
  );
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARG query failed (${res.status})`).toString();
    throw new LiveBindingError(msg, res.status);
  }
  return Array.isArray(json?.data) ? json.data : [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowDateIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Roles whose owning role name is considered privileged for the RBAC report. */
const PRIVILEGED_ROLES = new Set(
  ['Owner', 'Contributor', 'User Access Administrator', 'Role Based Access Control Administrator',
   'Security Admin', 'Global Administrator', 'Privileged Role Administrator']
    .map((r) => r.toLowerCase()),
);

// ---------------------------------------------------------------------------
// Resolvers — one per (templateId, entity) with a real Loom backend.
//   Each returns an EntityBindingResult. They NEVER fabricate: an empty/short
//   real result is returned as {source:'empty', note}; a backend error as
//   {source:'error', note}. The caller renders a REAL EMPTY table (zero rows)
//   in both fallback cases and surfaces `note` inline — never bundled SAMPLE.
// ---------------------------------------------------------------------------

type Resolver = (params: ReportParams, ctx: RenderCtx) => Promise<EntityBindingResult>;

const COST_COLUMNS = ['UsageDate', 'SubscriptionName', 'ResourceGroup', 'ServiceName', 'CostCenterTag', 'PreTaxCost'];

const costSummary = (ctx: RenderCtx) =>
  ctx.once<CostSummary>('cost', () => getLoomCostSummary({ timeframe: 'MonthToDate' }));

/** cloud-cost-finops / Cost → Azure Cost Management (MTD spend by service). */
const resolveCost: Resolver = async (params, ctx) => {
  try {
    const sum = await costSummary(ctx);
    const subLabel = params.subscriptionIds.length === 1
      ? params.subscriptionIds[0]
      : (sum.subscriptions.length === 1 ? sum.subscriptions[0] : '');
    const date = nowDateIso();
    const rows = sum.byService
      .filter((r) => Number.isFinite(r.cost))
      .map((r) => ({
        UsageDate: date,
        SubscriptionName: subLabel,
        ResourceGroup: '',
        ServiceName: r.key,
        CostCenterTag: '',
        PreTaxCost: Math.round(r.cost * 100) / 100,
      }));
    if (!rows.length) {
      if (sum.subscriptionErrors.length) {
        return { source: 'error', note: `Cost Management: ${sum.subscriptionErrors[0].error}` };
      }
      return { source: 'empty', note: 'Azure Cost Management returned no month-to-date usage for this scope.' };
    }
    return {
      source: 'live',
      note: `Live from Azure Cost Management — month-to-date ${sum.currency} spend by service across ${sum.subscriptions.length} subscription(s).`,
      table: { columns: COST_COLUMNS, rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Cost Management', 'Cost Management Reader on the subscription') };
  }
};

/** cloud-cost-finops / Budget → Microsoft.Consumption budgets. */
const resolveBudget: Resolver = async (_params, ctx) => {
  try {
    const sum = await costSummary(ctx);
    if (!sum.budgets.length) {
      return { source: 'empty', note: 'No Azure Consumption budgets are defined in scope.' };
    }
    const rows = sum.budgets.map((b) => ({
      SubscriptionName: b.subscription,
      MonthlyBudget: Math.round(b.amount * 100) / 100,
    }));
    return {
      source: 'live',
      note: `Live from Microsoft.Consumption budgets (${rows.length} budget(s)).`,
      table: { columns: ['SubscriptionName', 'MonthlyBudget'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Cost Management budgets', 'Cost Management Reader on the subscription') };
  }
};

/** coe-adoption-maturity / Adoption Signals → Log Analytics (monthly active users). */
const resolveAdoptionSignals: Resolver = async () => {
  try {
    if (!logAnalyticsWorkspaceId()) {
      return { source: 'error', note: 'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID (Log Analytics Reader) to render adoption signals live.' };
    }
    // CSA Loom emits structured audit events (customDimensions.source == "loom-audit")
    // to AppTraces when APPLICATIONINSIGHTS_CONNECTION_STRING is configured.
    const kql = `
AppTraces
| where customDimensions.source == "loom-audit"
| extend who = tostring(customDimensions.userId), Month = startofmonth(TimeGenerated)
| where isnotempty(who)
| summarize MonthlyActiveUsers = dcount(who) by Month
| order by Month asc
| take 60`.trim();
    const res = await queryLogs(kql, 'P180D');
    const mi = res.columns.indexOf('Month');
    const ui = res.columns.indexOf('MonthlyActiveUsers');
    const rows = res.rows
      .map((r) => ({
        Service: 'CSA Loom',
        Month: mi >= 0 ? String(r[mi] ?? '') : '',
        MonthlyActiveUsers: ui >= 0 ? num(r[ui]) : 0,
        WorkloadsOnboarded: null as number | null,
      }))
      .filter((r) => r.Month);
    if (!rows.length) {
      return { source: 'empty', note: 'No CSA Loom usage telemetry in Log Analytics (AppTraces) for the last 180 days.' };
    }
    return {
      source: 'live',
      note: 'Live from Log Analytics — monthly active CSA Loom users (AppTraces loom-audit).',
      table: { columns: ['Service', 'Month', 'MonthlyActiveUsers', 'WorkloadsOnboarded'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Log Analytics', 'Log Analytics Reader on the workspace') };
  }
};

/** resource-inventory-sprawl / Resources → Azure Resource Graph (estate inventory). */
const resolveResources: Resolver = async (params) => {
  try {
    const query = `
Resources
| extend HasOwnerTag = iff(isnotempty(tostring(tags['owner'])) or isnotempty(tostring(tags['Owner'])) or isnotempty(tostring(tags['ownerEmail'])), 'Yes', 'No')
| extend Environment = tostring(coalesce(tags['environment'], tags['Environment'], tags['env'], ''))
| summarize ResourceCount = count() by ResourceType = type, Location = location, SubscriptionName = subscriptionId, Environment, HasOwnerTag
| order by ResourceCount desc
| take 500`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => ({
      ResourceType: String(d.ResourceType ?? ''),
      Location: String(d.Location ?? ''),
      SubscriptionName: String(d.SubscriptionName ?? ''),
      Environment: String(d.Environment ?? ''),
      HasOwnerTag: String(d.HasOwnerTag ?? ''),
      ResourceCount: num(d.ResourceCount),
    }));
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Resource Graph returned no resources (grant the Console identity Reader on the subscription).' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — estate inventory summarized by type and region.',
      table: { columns: ['ResourceType', 'Location', 'SubscriptionName', 'Environment', 'HasOwnerTag', 'ResourceCount'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Resource Graph', 'Reader on the subscription') };
  }
};

/** identity-access-governance / Role Assignments → ARG authorizationresources. */
const resolveRoleAssignments: Resolver = async (params) => {
  try {
    const query = `
authorizationresources
| where type == 'microsoft.authorization/roleassignments'
| extend principalType = tostring(properties.principalType), roleDefId = tolower(tostring(properties.roleDefinitionId))
| join kind=leftouter (
    authorizationresources
    | where type == 'microsoft.authorization/roledefinitions'
    | extend roleDefId = tolower(id), roleName = tostring(properties.roleName)
    | project roleDefId, roleName
  ) on roleDefId
| extend RoleName = iff(isnotempty(roleName), roleName, 'Unknown role')
| summarize AssignmentCount = count() by RoleName, PrincipalType = principalType
| order by AssignmentCount desc
| take 200`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => {
      const roleName = String(d.RoleName ?? 'Unknown role');
      return {
        RoleName: roleName,
        Scope: '',
        PrincipalType: String(d.PrincipalType ?? 'Unknown'),
        IsPrivileged: PRIVILEGED_ROLES.has(roleName.toLowerCase()) ? 'Yes' : 'No',
        AssignmentCount: num(d.AssignmentCount),
      };
    });
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Resource Graph returned no role assignments (grant Reader on the subscription).' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — RBAC role assignments (authorizationresources).',
      table: { columns: ['RoleName', 'Scope', 'PrincipalType', 'IsPrivileged', 'AssignmentCount'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Resource Graph', 'Reader on the subscription') };
  }
};

/** security-compliance-posture / Secure Score → Microsoft Defender for Cloud. */
const resolveSecureScore: Resolver = async (_params, ctx) => {
  try {
    const d = await ctx.once<DefenderSummary>('defender', () => getDefenderSummary());
    if (!d.secureScore) {
      return { source: 'empty', note: 'No Defender for Cloud secure score is available for this subscription yet.' };
    }
    const rows = [{
      SubscriptionName: d.subscriptionId,
      CurrentScore: num(d.secureScore.current),
      MaxScore: num(d.secureScore.max),
      Percentage: num(d.secureScore.percentage),
    }];
    return {
      source: 'live',
      note: 'Live from Microsoft Defender for Cloud — subscription secure score.',
      table: { columns: ['SubscriptionName', 'CurrentScore', 'MaxScore', 'Percentage'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Defender for Cloud', 'Security Reader on the subscription') };
  }
};

/** security-compliance-posture / Policy Compliance → ARG policyresources (compliance states by initiative). */
const resolvePolicyCompliance: Resolver = async (params) => {
  try {
    const query = `
policyresources
| where type == 'microsoft.policyinsights/policystates'
| extend ComplianceState = tostring(properties.complianceState),
         PolicyInitiative = tostring(properties.policySetDefinitionName)
| extend PolicyInitiative = iff(isempty(PolicyInitiative), 'Standalone policies', PolicyInitiative)
| where isnotempty(ComplianceState)
| summarize ResourceCount = count() by PolicyInitiative, ComplianceState
| order by ResourceCount desc
| take 200`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => ({
      PolicyInitiative: String(d.PolicyInitiative ?? 'Standalone policies'),
      ComplianceState: String(d.ComplianceState ?? ''),
      ResourceCount: num(d.ResourceCount),
    }));
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Policy has no compliance states in scope (assign a regulatory-compliance initiative to populate).' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — Azure Policy compliance states by initiative.',
      table: { columns: ['PolicyInitiative', 'ComplianceState', 'ResourceCount'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Policy (Resource Graph)', 'Reader on the subscription') };
  }
};

/** resource-inventory-sprawl / Orphans → ARG Resources (unattached disks / NICs / public IPs). */
const resolveOrphans: Resolver = async (params) => {
  try {
    const query = `
Resources
| where (type =~ 'microsoft.compute/disks' and isnull(properties.managedBy))
     or (type =~ 'microsoft.network/networkinterfaces' and isnull(properties.virtualMachine))
     or (type =~ 'microsoft.network/publicipaddresses' and isnull(properties.ipConfiguration))
| extend OrphanType = case(
    type =~ 'microsoft.compute/disks', 'Unattached managed disk',
    type =~ 'microsoft.network/networkinterfaces', 'Orphaned network interface',
    type =~ 'microsoft.network/publicipaddresses', 'Unassociated public IP',
    'Other')
| summarize Count = count() by OrphanType
| order by Count desc`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => ({
      OrphanType: String(d.OrphanType ?? ''),
      Count: num(d.Count),
      // Monthly-waste $ requires a price sheet we do not fetch — leave null (honest unknown), never a fabricated estimate.
      EstMonthlyWaste: null as number | null,
    }));
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Resource Graph found no orphaned disks / NICs / public IPs in scope.' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — orphaned resources by type (monthly-waste estimate requires a price sheet, shown blank).',
      table: { columns: ['OrphanType', 'Count', 'EstMonthlyWaste'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Resource Graph', 'Reader on the subscription') };
  }
};

/** landing-zone-conformance / Conformance → ARG policyresources (policy control conformance by design area). */
const resolveConformance: Resolver = async (params) => {
  try {
    const query = `
policyresources
| where type == 'microsoft.policyinsights/policystates'
| extend Status = tostring(properties.complianceState),
         Control = tostring(properties.policyDefinitionName),
         DesignArea = tostring(properties.policyDefinitionGroupNames[0]),
         SubscriptionName = subscriptionId
| where isnotempty(Control)
| extend DesignArea = iff(isempty(DesignArea), 'General', DesignArea)
| summarize by DesignArea, Control, Status, SubscriptionName
| take 300`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => ({
      DesignArea: String(d.DesignArea ?? 'General'),
      Control: String(d.Control ?? ''),
      Status: String(d.Status ?? ''),
      SubscriptionName: String(d.SubscriptionName ?? ''),
    }));
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Policy has no policy-control states in scope for landing-zone conformance.' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — Azure Policy control conformance grouped by design area.',
      table: { columns: ['DesignArea', 'Control', 'Status', 'SubscriptionName'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Policy (Resource Graph)', 'Reader on the management group') };
  }
};

/** landing-zone-conformance / Subscriptions → ARG policyresources (per-subscription conformance %). */
const resolveSubscriptions: Resolver = async (params) => {
  try {
    const query = `
policyresources
| where type == 'microsoft.policyinsights/policystates'
| extend Status = tostring(properties.complianceState), SubscriptionName = subscriptionId
| where isnotempty(Status)
| summarize Compliant = countif(Status =~ 'Compliant'), Total = count() by SubscriptionName
| where Total > 0
| extend ConformancePct = round(100.0 * Compliant / Total, 1)
| project SubscriptionName, ConformancePct
| order by ConformancePct asc
| take 200`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => ({
      SubscriptionName: String(d.SubscriptionName ?? ''),
      // Management group / environment are not carried on a policy-state row — leave blank (honest), never invented.
      ManagementGroup: '',
      Environment: '',
      ConformancePct: num(d.ConformancePct),
    }));
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Policy has no per-subscription compliance states in scope yet.' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — per-subscription Azure Policy conformance percentage.',
      table: { columns: ['SubscriptionName', 'ManagementGroup', 'Environment', 'ConformancePct'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Policy (Resource Graph)', 'Reader on the management group') };
  }
};

/** operational-health-sla / Incidents → ARG alertsmanagementresources (fired alerts by severity). */
const resolveIncidents: Resolver = async (params) => {
  try {
    const query = `
alertsmanagementresources
| where type =~ 'microsoft.alertsmanagement/alerts'
| extend Severity = tostring(properties.essentials.severity),
         ServiceName = tostring(properties.essentials.targetResourceType)
| where isnotempty(Severity)
| summarize IncidentCount = count() by Severity, ServiceName
| order by IncidentCount desc
| take 200`.trim();
    const data = await runArg(query, params.subscriptionIds);
    const rows = data.map((d) => ({
      Severity: String(d.Severity ?? ''),
      ServiceName: String(d.ServiceName ?? ''),
      IncidentCount: num(d.IncidentCount),
      // MTTR requires an incident-resolution feed we do not query — leave null (honest unknown), never fabricated.
      MttrMinutes: null as number | null,
    }));
    if (!rows.length) {
      return { source: 'empty', note: 'Azure Monitor has no fired alerts in scope (MTTR requires an incident-resolution feed, shown blank).' };
    }
    return {
      source: 'live',
      note: 'Live from Azure Resource Graph — Azure Monitor fired alerts by severity and target service (MTTR shown blank).',
      table: { columns: ['Severity', 'ServiceName', 'IncidentCount', 'MttrMinutes'], rows },
    };
  } catch (e: any) {
    return { source: 'error', note: gateNote(e, 'Azure Monitor alerts (Resource Graph)', 'Monitoring Reader on the subscription') };
  }
};

/** Build an honest gate note from a client error (config / permission / upstream). */
function gateNote(e: any, service: string, role: string): string {
  const name = e?.name || '';
  const status = e?.status;
  if (name === 'MonitorNotConfiguredError') {
    return `${service} not configured — ${e?.message || 'missing env'}.`;
  }
  if (status === 401 || status === 403) {
    return `${service} access denied (grant the Console identity ${role}).`;
  }
  return `${service} unavailable: ${e?.message || String(e)}`;
}

// ---------------------------------------------------------------------------
// Registry + public API
// ---------------------------------------------------------------------------

/** (templateId → entity → resolver) for every entity with a real Loom backend. */
const LIVE_BINDINGS: Record<string, Record<string, Resolver>> = {
  'cloud-cost-finops': {
    Cost: resolveCost,
    Budget: resolveBudget,
  },
  'coe-adoption-maturity': {
    'Adoption Signals': resolveAdoptionSignals,
  },
  'resource-inventory-sprawl': {
    Resources: resolveResources,
    Orphans: resolveOrphans,
  },
  'identity-access-governance': {
    'Role Assignments': resolveRoleAssignments,
  },
  'security-compliance-posture': {
    'Secure Score': resolveSecureScore,
    'Policy Compliance': resolvePolicyCompliance,
  },
  'landing-zone-conformance': {
    Conformance: resolveConformance,
    Subscriptions: resolveSubscriptions,
  },
  'operational-health-sla': {
    Incidents: resolveIncidents,
  },
};

/**
 * Selectable Azure-native data sources for the Loom-native visual builder.
 *
 * Each entry reuses one of the resolvers above (same real Azure REST the CoE
 * templates render), exposing it as a pickable source for a builder tile. The
 * `columns` advertise the fields a tile can map to category / value; `category`
 * + `valueColumns` are sensible defaults the builder pre-selects.
 *
 * Azure-native only — every source is Cost Management / Resource Graph /
 * Defender / Log Analytics. No Microsoft Fabric / Power BI dependency.
 */
export interface BuilderSource {
  /** Stable id used in a saved dashboard tile spec. */
  id: string;
  /** Display label in the builder source picker. */
  label: string;
  /** One-line description of what it returns. */
  description: string;
  /** The Azure data plane (for the source chip + honest gate copy). */
  plane: 'Cost Management' | 'Azure Resource Graph' | 'Defender for Cloud' | 'Log Analytics';
  /** Azure role required for a live refresh (named in honest gates). */
  requiredRole: string;
  /** Columns the source emits (drives the builder's field pickers). */
  columns: string[];
  /** Default category (axis / group-by) column. */
  defaultCategory: string;
  /** Default value (measure) column. */
  defaultValue: string;
  /** Resolver producing the real {columns, rows}. */
  resolver: Resolver;
}

export const BUILDER_SOURCES: BuilderSource[] = [
  {
    id: 'cost-by-service',
    label: 'Cost by service (month-to-date)',
    description: 'Amortized month-to-date spend grouped by Azure service across your subscriptions.',
    plane: 'Cost Management',
    requiredRole: 'Cost Management Reader',
    columns: COST_COLUMNS,
    defaultCategory: 'ServiceName',
    defaultValue: 'PreTaxCost',
    resolver: resolveCost,
  },
  {
    id: 'budgets',
    label: 'Consumption budgets',
    description: 'Monthly Azure Consumption budgets by subscription.',
    plane: 'Cost Management',
    requiredRole: 'Cost Management Reader',
    columns: ['SubscriptionName', 'MonthlyBudget'],
    defaultCategory: 'SubscriptionName',
    defaultValue: 'MonthlyBudget',
    resolver: resolveBudget,
  },
  {
    id: 'resource-inventory',
    label: 'Resource inventory',
    description: 'Estate inventory from Azure Resource Graph, summarized by type, region and subscription.',
    plane: 'Azure Resource Graph',
    requiredRole: 'Reader (subscription/MG)',
    columns: ['ResourceType', 'Location', 'SubscriptionName', 'Environment', 'HasOwnerTag', 'ResourceCount'],
    defaultCategory: 'ResourceType',
    defaultValue: 'ResourceCount',
    resolver: resolveResources,
  },
  {
    id: 'role-assignments',
    label: 'RBAC role assignments',
    description: 'Azure RBAC role-assignment counts by role and principal type (authorizationresources).',
    plane: 'Azure Resource Graph',
    requiredRole: 'Reader (subscription/MG)',
    columns: ['RoleName', 'Scope', 'PrincipalType', 'IsPrivileged', 'AssignmentCount'],
    defaultCategory: 'RoleName',
    defaultValue: 'AssignmentCount',
    resolver: resolveRoleAssignments,
  },
  {
    id: 'secure-score',
    label: 'Defender secure score',
    description: 'Microsoft Defender for Cloud secure score (current / max / percentage).',
    plane: 'Defender for Cloud',
    requiredRole: 'Security Reader',
    columns: ['SubscriptionName', 'CurrentScore', 'MaxScore', 'Percentage'],
    defaultCategory: 'SubscriptionName',
    defaultValue: 'Percentage',
    resolver: resolveSecureScore,
  },
  {
    id: 'adoption-mau',
    label: 'CSA Loom monthly active users',
    description: 'Monthly active CSA Loom users from Log Analytics (AppTraces loom-audit telemetry).',
    plane: 'Log Analytics',
    requiredRole: 'Log Analytics Reader',
    columns: ['Service', 'Month', 'MonthlyActiveUsers', 'WorkloadsOnboarded'],
    defaultCategory: 'Month',
    defaultValue: 'MonthlyActiveUsers',
    resolver: resolveAdoptionSignals,
  },
];

const BUILDER_SOURCE_BY_ID: Record<string, BuilderSource> = Object.fromEntries(
  BUILDER_SOURCES.map((s) => [s.id, s]),
);

export function getBuilderSource(id: string): BuilderSource | undefined {
  return BUILDER_SOURCE_BY_ID[id];
}

/**
 * Resolve one builder source against the customer's estate. Returns the real
 * {columns, rows} (live) or an EntityBindingResult with source 'empty'/'error'
 * and an honest note — never fabricated. Shares the same RenderCtx so multiple
 * tiles backed by the same plane (e.g. cost + budgets) reuse one upstream call.
 */
export async function resolveBuilderSource(
  sourceId: string,
  overrides: ReportParamOverrides = {},
  ctx: RenderCtx = new RenderCtx(),
): Promise<EntityBindingResult> {
  const src = getBuilderSource(sourceId);
  if (!src) return { source: 'error', note: `Unknown data source: ${sourceId}` };
  const params = resolveReportParams(overrides);
  try {
    return await src.resolver(params, ctx);
  } catch (e: any) {
    return { source: 'error', note: `Live render failed: ${e?.message || String(e)}` };
  }
}

/** Resolve many builder sources at once, sharing one RenderCtx (per-render memo). */
export async function resolveBuilderSources(
  sourceIds: string[],
  overrides: ReportParamOverrides = {},
): Promise<Record<string, EntityBindingResult>> {
  const ctx = new RenderCtx();
  const unique = Array.from(new Set(sourceIds.filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (id): Promise<[string, EntityBindingResult]> => [id, await resolveBuilderSource(id, overrides, ctx)]),
  );
  return Object.fromEntries(entries);
}

/** True when (templateId, entity) has a first-party live Azure backend. */
export function hasLiveBinding(templateId: string, entity: string): boolean {
  return !!LIVE_BINDINGS[templateId]?.[entity];
}

/** The entities of a template that can render live (for docs / UI hints). */
export function liveEntities(templateId: string): string[] {
  return Object.keys(LIVE_BINDINGS[templateId] || {});
}

/**
 * Resolve LIVE data for a whole report against the customer's estate. Every
 * entity renders REAL rows (its resolver's live output) or a REAL EMPTY table
 * (schema, zero rows) when there is no binding / the query returned nothing /
 * the backend errored — NEVER bundled SAMPLE rows. Returns the per-entity render
 * data + truthful provenance.
 *
 * `sample` is the parsed bundled table-set; only its COLUMN SCHEMA is reused (to
 * keep each visual's field mapping intact) — its rows are never rendered.
 */
export async function resolveLiveReport(
  templateId: string,
  sample: SampleData,
  overrides: ReportParamOverrides = {},
): Promise<LiveRenderResult> {
  const params = resolveReportParams(overrides);
  const ctx = new RenderCtx();
  const entities = Object.keys(sample);

  const results = await Promise.all(
    entities.map(async (entity): Promise<[string, EntityBindingResult]> => {
      const resolver = LIVE_BINDINGS[templateId]?.[entity];
      if (!resolver) {
        return [entity, { source: 'empty', note: 'No live Azure data source is bound to this dataset yet; showing no rows.' }];
      }
      try {
        return [entity, await resolver(params, ctx)];
      } catch (e: any) {
        return [entity, { source: 'error', note: `Live render failed: ${e?.message || String(e)}` }];
      }
    }),
  );

  const live: SampleData = {};
  const dataSources: Record<string, EntityBindingResult> = {};
  for (const [entity, result] of results) {
    dataSources[entity] = result;
    // Live rows when available; otherwise a REAL EMPTY table with the entity's
    // column schema (zero rows) — never the bundled SAMPLE rows.
    live[entity] = result.source === 'live' && result.table ? result.table : emptyLike(sample[entity]);
  }
  return { live, dataSources, params };
}

/** A real EMPTY table carrying the entity's column schema but zero rows (never fabricated). */
export function emptyLike(table: SampleTable | undefined): SampleTable {
  return { columns: table?.columns ? [...table.columns] : [], rows: [] };
}

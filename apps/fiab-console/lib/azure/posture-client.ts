/**
 * posture-client — single source of truth for the Govern → Admin view (F2)
 * metric reads. Powers three sub-tabs:
 *
 *   1. Manage estate          — Cosmos inventory (workspaces / items / capacities /
 *                               domains) + Log Analytics KQL feature usage.
 *   2. Protect, secure, comply — Graph IP (MIP) coverage %, DLP violations + last
 *                               scan, and the live Purview last-scan timestamp.
 *   3. Discover, trust, reuse — freshness / description / endorsement coverage +
 *                               30-day sharing, all from Cosmos.
 *
 * Two read paths:
 *   - FAST  : a pre-computed `posture:${tenantId}` doc in the Cosmos
 *             `posture-aggregates` container (written every 5 min by the
 *             posture-refresh Azure Function).
 *   - LIVE  : `computePosture(tenantId)` recomputes the Cosmos aggregates inline
 *             (same formulas the Function uses) so the surface is correct even
 *             before the Function runs / in local dev.
 *
 * Every metric whose backend isn't provisioned is GATED (per
 * .claude/rules/no-vaporware.md) — the function returns the metric as `null`
 * plus a `NotConfiguredHint` in `gates[...]`, naming the exact env var, bicep
 * module, and follow-up. NO mocks, NO fabricated numbers. No Microsoft Fabric
 * dependency: Cosmos + Azure Monitor + Microsoft Graph + classic Purview only.
 *
 * Auth for the Cosmos / Graph / Monitor reads is owned by the wrapped clients
 * (cosmos-client / mip-graph-client / dlp-graph-client / monitor-client), each
 * using the Console UAMI ChainedTokenCredential.
 */

import {
  workspacesContainer,
  itemsContainer,
  auditLogContainer,
  postureAggregatesAdminContainer,
} from './cosmos-client';
import { listSensitivityLabels, MipNotConfiguredError } from './mip-graph-client';
import { listDlpAlerts, DlpNotConfiguredError } from './dlp-graph-client';
import { listDataSources, listScansForSource, listScanRuns, PurviewNotConfiguredError } from './purview-client';
import { queryLogs, MonitorNotConfiguredError } from './monitor-client';
import type { NotConfiguredHint } from '../components/admin-security/not-configured-bar';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface FeatureUsageRow {
  feature: string;
  hits: number;
}

/** A pre-computed (or live) posture aggregate document. */
export interface PostureDoc {
  id: string;
  tenantId: string;
  updatedAt: string;

  // Manage estate (Cosmos)
  workspaceCount: number;
  totalItems: number;
  capacityCount: number;
  domainCount: number;

  // Protect, secure, comply
  /** % of items carrying a sensitivity label (Graph IP coverage). null = gated. */
  mipCoveragePct: number | null;
  /** Count of tenant sensitivity labels available in Graph. null = gated. */
  mipLabelCount: number | null;
  /** DLP violations in the last 30 days. null = gated. */
  dlpViolations30d: number | null;
  /** ISO timestamp of the most recent DLP alert. null = none/gated. */
  dlpLastViolationAt: string | null;
  /** ISO timestamp of the most recent Purview scan run across all sources. null = gated. */
  purviewLastScanAt: string | null;

  // Discover, trust, reuse (Cosmos)
  freshItemsPct: number;
  describedItemsPct: number;
  endorsedItemsPct: number;
  sharedItems30d: number;
}

/** Per-metric honest gate, keyed by the metric source. */
export type PostureGates = Partial<Record<
  'mip' | 'dlp' | 'purview' | 'featureUsage',
  NotConfiguredHint
>>;

export interface PostureResult {
  posture: PostureDoc;
  gates: PostureGates;
  featureUsage: FeatureUsageRow[] | null;
  source: 'cosmos' | 'live';
}

/** Thrown when LOOM_COSMOS_ENDPOINT is unset — the whole surface gates. */
export class PostureNotConfiguredError extends Error {
  hint: NotConfiguredHint;
  constructor(hint: NotConfiguredHint) {
    super(`Govern posture is not wired in this deployment: missing ${hint.missingEnvVar}`);
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// Helpers (the same governance signals as /api/governance/insights)
// ---------------------------------------------------------------------------

const isOwned = (st: any) => !!(st?.owner || st?.ownerUpn || st?.contact || st?.steward);
const isEndorsed = (st: any) =>
  st?.endorsement === 'Certified' || st?.endorsement === 'Promoted' || st?.certified === true;
const isDescribed = (st: any) =>
  typeof st?.description === 'string' && st.description.trim().length > 0;

/** Item is "fresh" when it was updated within the last 30 days. */
function isFresh(item: any): boolean {
  const ts = item?.updatedAt || item?.state?.lastRefreshedAt || item?.state?.freshness;
  if (!ts) return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  return t >= Date.now() - 30 * 24 * 3600_000;
}

function pct(n: number, d: number): number {
  return d > 0 ? Math.round((100 * n) / d) : 0;
}

// ---------------------------------------------------------------------------
// Cosmos estate aggregate (always available when Cosmos is configured)
// ---------------------------------------------------------------------------

interface EstateAggregate {
  workspaceCount: number;
  totalItems: number;
  capacityCount: number;
  domainCount: number;
  freshItemsPct: number;
  describedItemsPct: number;
  endorsedItemsPct: number;
  labeledCount: number;
  sharedItems30d: number;
}

async function computeEstate(tenantId: string): Promise<EstateAggregate> {
  const wsC = await workspacesContainer();
  const itC = await itemsContainer();
  const audC = await auditLogContainer();

  const { resources: workspaces } = await wsC.items.query<any>({
    query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
    parameters: [{ name: '@t', value: tenantId }],
  }, { partitionKey: tenantId }).fetchAll();
  const wsIds = workspaces.map((w) => w.id);

  let items: any[] = [];
  if (wsIds.length) {
    const { resources } = await itC.items.query<any>({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state, c.updatedAt FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: wsIds }],
    }).fetchAll();
    items = resources;
  }

  const total = items.length;
  const labeled = items.filter((i) => i.state?.sensitivityLabel).length;
  const endorsed = items.filter((i) => isEndorsed(i.state)).length;
  const described = items.filter((i) => isDescribed(i.state)).length;
  const fresh = items.filter((i) => isFresh(i)).length;

  // Capacities + domains the estate references (distinct, real ids on item state).
  const capacities = new Set<string>();
  const domains = new Set<string>();
  for (const i of items) {
    const cap = i.state?.capacityId || i.state?.capacity;
    if (cap) capacities.add(String(cap));
    const dom = i.state?.domain || i.state?.domainId;
    if (dom) domains.add(String(dom));
  }

  // Sharing in the last 30 days (audit kind === 'share').
  let sharedItems30d = 0;
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const { resources } = await audC.items.query<number>({
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.tenantId = @t AND c.at >= @since AND (c.kind = 'share' OR c.action = 'share')",
      parameters: [{ name: '@t', value: tenantId }, { name: '@since', value: since }],
    }).fetchAll();
    sharedItems30d = resources[0] || 0;
  } catch { /* audit container may be empty */ }

  return {
    workspaceCount: wsIds.length,
    totalItems: total,
    capacityCount: capacities.size,
    domainCount: domains.size,
    freshItemsPct: pct(fresh, total),
    describedItemsPct: pct(described, total),
    endorsedItemsPct: pct(endorsed, total),
    labeledCount: labeled,
    sharedItems30d,
  };
}

// ---------------------------------------------------------------------------
// Graph IP (MIP) coverage — labeled-items % cross-referenced with Graph labels
// ---------------------------------------------------------------------------

async function computeMip(
  labeledCount: number,
  totalItems: number,
): Promise<{ mipCoveragePct: number | null; mipLabelCount: number | null; gate?: NotConfiguredHint }> {
  try {
    const labels = await listSensitivityLabels(); // throws MipNotConfiguredError when LOOM_MIP_ENABLED unset
    return {
      mipCoveragePct: pct(labeledCount, totalItems),
      mipLabelCount: labels.length,
    };
  } catch (e) {
    if (e instanceof MipNotConfiguredError) {
      return { mipCoveragePct: null, mipLabelCount: null, gate: e.hint };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// DLP violations (last 30d) + last violation timestamp
// ---------------------------------------------------------------------------

async function computeDlp(): Promise<{
  dlpViolations30d: number | null;
  dlpLastViolationAt: string | null;
  gate?: NotConfiguredHint;
}> {
  try {
    const alerts = await listDlpAlerts({ top: 100 }); // throws DlpNotConfiguredError when LOOM_DLP_ENABLED unset / segment missing
    const sorted = [...alerts]
      .filter((a) => a.createdDateTime)
      .sort((a, b) => Date.parse(b.createdDateTime!) - Date.parse(a.createdDateTime!));
    return {
      dlpViolations30d: alerts.length,
      dlpLastViolationAt: sorted[0]?.createdDateTime || null,
    };
  } catch (e) {
    if (e instanceof DlpNotConfiguredError) {
      return { dlpViolations30d: null, dlpLastViolationAt: null, gate: e.hint };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Purview last-scan timestamp — most recent run across all registered sources
// ---------------------------------------------------------------------------

async function computePurviewLastScan(): Promise<{ purviewLastScanAt: string | null; gate?: NotConfiguredHint }> {
  try {
    const sources = await listDataSources(); // throws PurviewNotConfiguredError when LOOM_PURVIEW_ACCOUNT unset
    let latest: number | null = null;
    // Bound the fan-out so a large estate doesn't stall the read.
    for (const src of sources.slice(0, 12)) {
      let scans;
      try { scans = await listScansForSource(src.name); } catch { continue; }
      for (const scan of scans.slice(0, 4)) {
        let runs;
        try { runs = await listScanRuns(src.name, scan.name); } catch { continue; }
        for (const r of runs) {
          const t = Date.parse(r.endTime || r.startTime || '');
          if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
        }
      }
    }
    return { purviewLastScanAt: latest !== null ? new Date(latest).toISOString() : null };
  } catch (e) {
    if (e instanceof PurviewNotConfiguredError) {
      return { purviewLastScanAt: null, gate: e.hint };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Feature usage — Log Analytics KQL over the Console's request telemetry
// ---------------------------------------------------------------------------

const FEATURE_USAGE_KQL = `AppRequests
| where TimeGenerated > ago(30d)
| where Url contains "/api/" or Name contains "loom/"
| extend feature = tostring(split(replace_string(Url, "https://", ""), "/api/")[1])
| where isnotempty(feature)
| summarize hits = count() by feature
| top 10 by hits desc`;

async function computeFeatureUsage(): Promise<{ rows: FeatureUsageRow[] | null; gate?: NotConfiguredHint }> {
  try {
    const res = await queryLogs(FEATURE_USAGE_KQL, 'P30D'); // throws MonitorNotConfiguredError when LA workspace unset
    const fi = res.columns.indexOf('feature');
    const hi = res.columns.indexOf('hits');
    const rows: FeatureUsageRow[] = res.rows.map((r) => ({
      feature: String(fi >= 0 ? r[fi] : r[0] ?? ''),
      hits: Number(hi >= 0 ? r[hi] : r[1] ?? 0) || 0,
    })).filter((r) => r.feature);
    return { rows };
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return {
        rows: null,
        gate: {
          missingEnvVar: e.missing[0] || 'LOOM_LOG_ANALYTICS_WORKSPACE_ID',
          bicepModule: 'platform/fiab/bicep/modules/admin-plane/monitoring.bicep',
          bicepStatus: 'Deploys the Log Analytics workspace + grants the Console UAMI Log Analytics Reader. Wire LOOM_LOG_ANALYTICS_WORKSPACE_ID into the apps[].env list.',
          rolesRequired: [{
            name: 'Log Analytics Reader',
            scope: 'Loom Log Analytics workspace',
            reason: 'Run the KQL feature-usage query over the Console request telemetry.',
          }],
          followUp: 'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID to the workspace customerId (GUID); for GCC-High/IL5 also set LOOM_LOG_ANALYTICS_ENDPOINT to https://api.loganalytics.us.',
        },
      };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The Cosmos endpoint gate — the only HARD gate (everything else degrades to a tile gate). */
export function assertCosmosConfigured(): void {
  if (!process.env.LOOM_COSMOS_ENDPOINT) {
    throw new PostureNotConfiguredError({
      missingEnvVar: 'LOOM_COSMOS_ENDPOINT',
      bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
      bicepStatus: 'Deploys the Cosmos account + database and wires LOOM_COSMOS_ENDPOINT into the Console app. Grant the Console UAMI the Cosmos DB Built-in Data Contributor role.',
      followUp: 'Set LOOM_COSMOS_ENDPOINT to the Cosmos account URI (https://<account>.documents.azure.com:443/).',
    });
  }
}

/**
 * Recompute the full posture live from Cosmos + Graph + Monitor + Purview. Used
 * by the posture-refresh Function and by the BFF route when no fresh
 * pre-computed doc exists. Each non-Cosmos metric degrades to a gate rather than
 * failing the whole call.
 */
export async function computePosture(tenantId: string): Promise<PostureResult> {
  assertCosmosConfigured();
  const estate = await computeEstate(tenantId);

  const [mip, dlp, purview, usage] = await Promise.all([
    computeMip(estate.labeledCount, estate.totalItems),
    computeDlp(),
    computePurviewLastScan(),
    computeFeatureUsage(),
  ]);

  const gates: PostureGates = {};
  if (mip.gate) gates.mip = mip.gate;
  if (dlp.gate) gates.dlp = dlp.gate;
  if (purview.gate) gates.purview = purview.gate;
  if (usage.gate) gates.featureUsage = usage.gate;

  const posture: PostureDoc = {
    id: `posture:${tenantId}`,
    tenantId,
    updatedAt: new Date().toISOString(),
    workspaceCount: estate.workspaceCount,
    totalItems: estate.totalItems,
    capacityCount: estate.capacityCount,
    domainCount: estate.domainCount,
    mipCoveragePct: mip.mipCoveragePct,
    mipLabelCount: mip.mipLabelCount,
    dlpViolations30d: dlp.dlpViolations30d,
    dlpLastViolationAt: dlp.dlpLastViolationAt,
    purviewLastScanAt: purview.purviewLastScanAt,
    freshItemsPct: estate.freshItemsPct,
    describedItemsPct: estate.describedItemsPct,
    endorsedItemsPct: estate.endorsedItemsPct,
    sharedItems30d: estate.sharedItems30d,
  };

  return { posture, gates, featureUsage: usage.rows, source: 'live' };
}

/** Read the pre-computed posture doc, or null when absent/stale. */
export async function readPostureDoc(tenantId: string, maxAgeMs = 5 * 60_000): Promise<PostureDoc | null> {
  assertCosmosConfigured();
  try {
    const c = await postureAggregatesAdminContainer();
    const { resource } = await c.item(`posture:${tenantId}`, tenantId).read<PostureDoc>();
    if (!resource?.updatedAt) return null;
    if (Date.parse(resource.updatedAt) < Date.now() - maxAgeMs) return null;
    return resource;
  } catch {
    return null;
  }
}

/** Upsert a freshly computed posture doc (used by the refresh Function). */
export async function writePostureDoc(doc: PostureDoc): Promise<void> {
  const c = await postureAggregatesAdminContainer();
  await c.items.upsert(doc);
}

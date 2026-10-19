/**
 * governance-lib.mjs - pure helpers shared by the governance-w0 measurement
 * scripts (PRPs/active/governance-autopilot, work item W0).
 *
 * Every helper here is side-effect free so it can be tested without az, gh or
 * the network. The rule they enforce together (assertion-design.md, and
 * scripts/measure/README.md R1/R4/R5): a read that failed is BLOCKED with its
 * status, never a zero; a zero is only reported next to a positive control.
 */

/** Datum states. MEASURED carries a value; the other two never do. */
export const STATE = Object.freeze({ MEASURED: 'MEASURED', BLOCKED: 'BLOCKED', INCONCLUSIVE: 'INCONCLUSIVE' });

const SCRUB_RULES = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[JWT-REDACTED]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/([?&;](?:sig|sv|se|sp|code|access_token|client_secret|key|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/((?:AccountKey|SharedAccessKey|Password|pwd)\s*=\s*)[^;\s"']+/gi, '$1[REDACTED]'],
];

/** Remove token-shaped substrings from any text before it is printed or stored. */
export function scrub(text) {
  let s = String(text ?? '');
  for (const [re, rep] of SCRUB_RULES) s = s.replace(re, rep);
  return s;
}

/** A datum that could not be established. `who` names the party that must unblock it. */
export function blocked(datum, { status = null, reason, who }) {
  if (!reason || !who) throw new Error('blocked() requires a reason and an owner (who)');
  return { datum, state: STATE.BLOCKED, status, reason: scrub(reason).slice(0, 600), who };
}

export function measured(datum, value, extra = {}) {
  if (value === undefined || value === null) throw new Error(`measured(${datum}) refuses a null/undefined value: that is UNKNOWN, not a measurement`);
  return { datum, state: STATE.MEASURED, value, ...extra };
}

/**
 * Is this ARM resource Loom-owned? Tag CSA_Loom=true or loom-estate-id present,
 * or a resource group whose name starts with rg-csa-loom / rg-mng-adb-loom.
 * Anything else in the same subscriptions (blog, sentinel, demo estates) is
 * reported separately and NEVER counted toward "should be registered".
 */
export function isLoomOwned(res) {
  const t = res?.tags || {};
  if (String(t.CSA_Loom).toLowerCase() === 'true') return true;
  if (t['loom-estate-id']) return true;
  return /^rg-(csa-loom|mng-adb-loom)/i.test(res?.resourceGroup || '');
}

/** Purview data-source kind + the host a registration would carry, per ARM type. */
const KIND_BY_TYPE = {
  'microsoft.storage/storageaccounts': { kind: 'AdlsGen2', host: (r) => `${r.name}.dfs.core.windows.net` },
  'microsoft.synapse/workspaces': { kind: 'AzureSynapseWorkspace', host: (r) => `${r.name}.sql.azuresynapse.net` },
  'microsoft.kusto/clusters': { kind: 'AzureDataExplorer', host: (r) => `${r.name}.` },
  'microsoft.sql/servers': { kind: 'AzureSqlDatabase', host: (r) => `${r.name}.database.` },
  'microsoft.databricks/workspaces': { kind: 'DatabricksUnityCatalog', host: (r) => `${r.name}` },
};
/** Types Purview cannot scan (PRP 4: Event Hubs is not a Data Map scan source; AAS is not either). */
const NOT_SCANNABLE = new Set(['microsoft.eventhub/namespaces', 'microsoft.analysisservices/servers']);
/** Loom platform-state stores (its own Cosmos): not user data, never a scan target. */
const PLATFORM_STORE = new Set(['microsoft.documentdb/databaseaccounts']);
/** A container name that marks a lakehouse / medallion store. */
export const LAKEHOUSE_CONTAINER_RE = /^(bronze|silver|gold|landing|lakehouse)/i;

/**
 * Expected Purview registrations from an inventory. Loom-owned only.
 * Synapse-managed SQL servers (Microsoft.Sql/servers living in a
 * synapseworkspace-managedrg-* group) are the workspace's own pool server and
 * are NOT separate Azure SQL sources.
 */
export function expectedSources(resources, { containers = null } = {}) {
  const expected = [];
  const notScannable = [];
  const excluded = [];
  for (const r of resources) {
    const type = String(r.type || '').toLowerCase();
    if (!isLoomOwned(r)) { excluded.push({ id: r.id, reason: 'not-loom-owned' }); continue; }
    if (PLATFORM_STORE.has(type)) { excluded.push({ id: r.id, reason: 'loom-platform-state-store' }); continue; }
    if (NOT_SCANNABLE.has(type)) { notScannable.push({ id: r.id, type: r.type, name: r.name }); continue; }
    const k = KIND_BY_TYPE[type];
    if (!k) continue;
    if (type === 'microsoft.sql/servers' && /^synapseworkspace-managedrg-/i.test(r.resourceGroup || '')) {
      excluded.push({ id: r.id, reason: 'synapse-managed-sql-server' }); continue;
    }
    if (type === 'microsoft.storage/storageaccounts' && /^(dbstorage|scaneastus2)/i.test(r.name)) {
      excluded.push({ id: r.id, reason: 'databricks-or-purview-managed-storage' }); continue;
    }
    if (type === 'microsoft.storage/storageaccounts' && Array.isArray(containers)) {
      const mine = containers.filter((c) => String(c.accountId).toLowerCase() === String(r.id).toLowerCase());
      if (!mine.some((c) => LAKEHOUSE_CONTAINER_RE.test(c.name))) {
        excluded.push({ id: r.id, reason: mine.length ? 'no-lakehouse-container' : 'containers-not-read-or-empty' });
        continue;
      }
    }
    expected.push({ idKey: String(r.id).toLowerCase(), id: r.id, name: r.name, kind: k.kind, hostHint: k.host(r).toLowerCase(), resourceGroup: r.resourceGroup });
  }
  return { expected, notScannable, excluded };
}

/**
 * Diff expected vs registered. `registered` MUST come from a successful list
 * read; a caller that failed to read passes null and gets INCONCLUSIVE, never
 * "everything missing" (that would be a failed read read as a measurement).
 */
export function diffRegistered(expected, registered) {
  if (!Array.isArray(registered)) {
    return { state: STATE.INCONCLUSIVE, reason: 'registered-source list was not read; no diff can be computed' };
  }
  const regIds = new Set();
  const regHosts = [];
  for (const d of registered) {
    const p = d?.properties || {};
    if (p.resourceId) regIds.add(String(p.resourceId).toLowerCase());
    for (const h of [p.endpoint, p.serverEndpoint, p.clusterUri, p.workspaceUrl]) if (h) regHosts.push(String(h).toLowerCase());
  }
  const registeredHits = [];
  const missing = [];
  for (const e of expected) {
    const hit = regIds.has(e.idKey) || regHosts.some((h) => h.includes(e.hostHint));
    (hit ? registeredHits : missing).push(e);
  }
  const unexpectedRegistered = registered.filter((d) => {
    const p = d?.properties || {};
    const rid = String(p.resourceId || '').toLowerCase();
    const hosts = [p.endpoint, p.serverEndpoint, p.clusterUri, p.workspaceUrl].filter(Boolean).map((h) => String(h).toLowerCase());
    return !expected.some((e) => (rid && rid === e.idKey) || hosts.some((h) => h.includes(e.hostHint)));
  }).map((d) => ({ name: d.name, kind: d.kind }));
  return { state: STATE.MEASURED, expected: expected.length, registered: registeredHits.length, missing, unexpectedRegistered };
}

/**
 * Scan cost formula. Inputs are labelled by provenance so measured and assumed
 * never blend: the caller passes {value, source:'measured'|'published'|'assumed'}.
 *   monthly = capacityUnits * cuRate * 730
 *           + sum(sources) (fullScansPerMonth * fullHours + incrScansPerMonth * incrHours) * vcores * vcoreRate
 */
export function scanCostMonthly({ cuRate, vcoreRate, capacityUnits, vcoresPerScan, sources }) {
  for (const [k, v] of Object.entries({ cuRate, vcoreRate, capacityUnits, vcoresPerScan })) {
    if (!(typeof v === 'number' && v >= 0)) throw new Error(`scanCostMonthly: ${k} must be a non-negative number, got ${String(v)}`);
  }
  if (!Array.isArray(sources)) throw new Error('scanCostMonthly: sources must be an array');
  const vcoreHours = sources.reduce((s, x) => s + x.fullScansPerMonth * x.fullHours + x.incrScansPerMonth * x.incrHours, 0);
  const scanUsd = vcoreHours * vcoresPerScan * vcoreRate;
  const baseUsd = capacityUnits * cuRate * 730;
  return { vcoreHours, scanUsd, baseUsd, totalUsd: scanUsd + baseUsd, perDayScanUsd: scanUsd / 30 };
}

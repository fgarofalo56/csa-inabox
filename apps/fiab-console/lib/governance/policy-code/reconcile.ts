/**
 * Governance-as-Code — the reconcile loop (WS-10.2 / BTB-8).
 *
 * `reconcilePolicyCode(set, { apply })`:
 *   1. compiles the set to every backend in one pass (`compileAll`);
 *   2. reads the CURRENT live state per backend (real reads where cheap — ADX
 *      database principals, Synapse RLS policies, the api-scope registry doc —
 *      else the last-applied snapshot);
 *   3. diffs desired-vs-live (`diffOps`, pure) → toApply / toRevoke / inSync;
 *   4. when `apply`, executes the delta with REAL backend calls (Synapse SQL,
 *      Databricks/OSS-UC, ADX mgmt commands, Purview classification, the
 *      api-scope registry doc) — self-healing drift (a grant removed out-of-band
 *      re-applies; a statement dropped from the policy revokes);
 *   5. persists the applied snapshot + writes an audit receipt.
 *
 * Honest-gated per backend (`no-vaporware.md`): an unconfigured backend returns
 * `status:'gated'` naming the exact env var, never a silent no-op. The OSS-UC
 * path (`LOOM_UC_BACKEND=oss`, no Databricks/Fabric) applies grants via the UC
 * permissions REST (`no-fabric-dependency.md`).
 *
 * The diff (`diffOps`) is a PURE function factored out for unit tests — no Azure
 * import on that path.
 */

import type { PolicyBackend, PolicyCodeSet } from './dsl';
import { compileAll, type CompileOptions } from './compile';
import type { CompiledArtifact, CompiledOp } from './compilers/types';
import { SQL_BATCH_SEP } from './compilers/synapse';
import { UC_STMT_SEP } from './compilers/unity-catalog';
import { toApiScopeEntries, type ApiScopeEntry } from './compilers/api-scope';

// ── PURE: desired-vs-live diff ────────────────────────────────────────────────
export interface OpDiff {
  toApply: CompiledOp[];
  toRevoke: CompiledOp[];
  inSync: CompiledOp[];
}

/**
 * Pure diff. `desired` = compiled ops for the policy; `liveKeys` = keys actually
 * present in the backend right now; `priorApplied` = ops we applied last time
 * (so a statement removed from the policy is revoked). A desired op missing from
 * `liveKeys` is (re-)applied — that is the drift self-heal.
 */
export function diffOps(desired: CompiledOp[], liveKeys: Set<string>, priorApplied: CompiledOp[]): OpDiff {
  const desiredKeys = new Set(desired.map((o) => o.key));
  const toApply = desired.filter((o) => !liveKeys.has(o.key));
  const inSync = desired.filter((o) => liveKeys.has(o.key));
  const toRevoke = priorApplied.filter((o) => !desiredKeys.has(o.key) && !!o.undo);
  return { toApply, toRevoke, inSync };
}

// ── Receipts + snapshot ───────────────────────────────────────────────────────
export type BackendReconcileStatus = 'converged' | 'applied' | 'drift' | 'gated' | 'partial' | 'skipped';

export interface BackendReconcileReceipt {
  backend: PolicyBackend;
  status: BackendReconcileStatus;
  desired: number;
  inSync: number;
  applied: number;
  revoked: number;
  /** Pending delta on a dry run (toApply + toRevoke). */
  drift: number;
  errors: number;
  gate?: string;
  detail: string[];
}

export interface PolicyReconcileReceipt {
  ok: boolean;
  mode: 'dry-run' | 'apply';
  policySetName: string;
  compiledBackends: PolicyBackend[];
  backends: BackendReconcileReceipt[];
  totalDrift: number;
  at: string;
}

interface PolicyCodeSnapshotDoc {
  id: string;
  tenantId: string;
  kind: 'policy-code-state';
  applied: Partial<Record<PolicyBackend, CompiledOp[]>>;
  lastReceipt?: PolicyReconcileReceipt;
  updatedAt: string;
}

interface ApiScopeRegistryDoc {
  id: string;
  tenantId: string;
  kind: 'api-scope-registry';
  entries: ApiScopeEntry[];
  updatedAt: string;
}

const snapshotId = (tenantId: string) => `policy-code-state:${tenantId}`;
const registryId = (tenantId: string) => `api-scope-registry:${tenantId}`;

export interface ReconcileOptions {
  apply: boolean;
  tenantId: string;
  updatedBy: string;
}

// ── Entry point ───────────────────────────────────────────────────────────────
export async function reconcilePolicyCode(
  set: PolicyCodeSet,
  opts: ReconcileOptions,
): Promise<PolicyReconcileReceipt> {
  const at = new Date().toISOString();
  const mode: PolicyReconcileReceipt['mode'] = opts.apply ? 'apply' : 'dry-run';

  // Resolve backend variants (OSS vs Databricks UC; tenant id for ADX FQNs).
  let ucVariant: 'databricks' | 'oss' = 'databricks';
  try {
    const { resolveUcBackend } = await import('@/lib/azure/uc-backend');
    ucVariant = resolveUcBackend();
  } catch {
    /* default databricks */
  }
  const compileOpts: CompileOptions = { ucVariant, tenantId: opts.tenantId };
  const compiled = compileAll(set, compileOpts);

  const snapshot = await loadSnapshot(opts.tenantId);
  const prior = snapshot?.applied || {};

  const receipts: BackendReconcileReceipt[] = [];
  const newApplied: Partial<Record<PolicyBackend, CompiledOp[]>> = { ...prior };

  for (const artifact of compiled.artifacts) {
    // Reconcile a backend when it has desired ops OR when it had prior ops that
    // may now need revoking.
    const priorOps = prior[artifact.backend] || [];
    if (!artifact.applicable && priorOps.length === 0) continue;

    const receipt = await reconcileBackend(artifact, priorOps, opts, at);
    receipts.push(receipt.receipt);
    if (opts.apply && receipt.receipt.status !== 'gated') {
      newApplied[artifact.backend] = receipt.nowApplied;
    }
  }

  const totalDrift = receipts.reduce((n, r) => n + r.drift, 0);
  const result: PolicyReconcileReceipt = {
    ok: receipts.every((r) => r.status !== 'partial'),
    mode,
    policySetName: set.name,
    compiledBackends: compiled.compiledBackends,
    backends: receipts,
    totalDrift,
    at,
  };

  if (opts.apply) {
    await saveSnapshot(opts.tenantId, newApplied, result);
  }
  await writeAudit(opts, result);
  return result;
}

// ── Per-backend reconcile ─────────────────────────────────────────────────────
async function reconcileBackend(
  artifact: CompiledArtifact,
  priorOps: CompiledOp[],
  opts: ReconcileOptions,
  at: string,
): Promise<{ receipt: BackendReconcileReceipt; nowApplied: CompiledOp[] }> {
  const base: BackendReconcileReceipt = {
    backend: artifact.backend,
    status: 'converged',
    desired: artifact.ops.length,
    inSync: 0,
    applied: 0,
    revoked: 0,
    drift: 0,
    errors: 0,
    detail: [],
  };

  // api-scope is a whole-doc registry — special-cased (no per-op backend call).
  if (artifact.backend === 'api-scope') {
    return reconcileApiScope(artifact, opts, base);
  }

  // Config gate — honest, names the missing env var.
  const gate = await backendGate(artifact.backend);
  if (gate) {
    return { receipt: { ...base, status: 'gated', gate }, nowApplied: priorOps };
  }

  let liveKeys: Set<string>;
  try {
    liveKeys = await readLiveKeys(artifact, priorOps, opts);
  } catch (e: any) {
    return {
      receipt: { ...base, status: 'gated', gate: `Could not read live ${artifact.backend} state: ${String(e?.message || e).slice(0, 160)}` },
      nowApplied: priorOps,
    };
  }

  const diff = diffOps(artifact.ops, liveKeys, priorOps);
  base.inSync = diff.inSync.length;
  base.drift = diff.toApply.length + diff.toRevoke.length;

  if (!opts.apply) {
    if (base.drift > 0) {
      base.status = 'drift';
      base.detail.push(`${diff.toApply.length} to apply, ${diff.toRevoke.length} to revoke`);
    }
    return { receipt: base, nowApplied: priorOps };
  }

  // Apply the delta with real backend calls.
  const run = backendRunner(artifact.backend);
  for (const op of diff.toApply) {
    try {
      await run.apply(op, opts);
      base.applied++;
    } catch (e: any) {
      base.errors++;
      base.detail.push(`apply ${op.key} failed: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  for (const op of diff.toRevoke) {
    try {
      await run.revoke(op, opts);
      base.revoked++;
    } catch (e: any) {
      base.errors++;
      base.detail.push(`revoke ${op.key} failed: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  base.status = base.errors ? 'partial' : base.applied || base.revoked ? 'applied' : 'converged';
  return { receipt: base, nowApplied: artifact.ops };
}

// ── api-scope registry (whole-doc replace) ────────────────────────────────────
async function reconcileApiScope(
  artifact: CompiledArtifact,
  opts: ReconcileOptions,
  base: BackendReconcileReceipt,
): Promise<{ receipt: BackendReconcileReceipt; nowApplied: CompiledOp[] }> {
  const desired = toApiScopeEntries(artifact);
  const entryKey = (e: ApiScopeEntry) => `${e.action}:${e.route}:${e.principalId}`;
  const desiredKeys = new Set(desired.map(entryKey));

  let liveEntries: ApiScopeEntry[] = [];
  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(registryId(opts.tenantId), opts.tenantId).read<ApiScopeRegistryDoc>().catch(() => ({ resource: undefined }));
    liveEntries = resource?.entries || [];
  } catch {
    liveEntries = [];
  }
  const liveKeys = new Set(liveEntries.map(entryKey));
  const toAdd = desired.filter((e) => !liveKeys.has(entryKey(e)));
  const toRemove = liveEntries.filter((e) => !desiredKeys.has(entryKey(e)));
  base.inSync = desired.length - toAdd.length;
  base.drift = toAdd.length + toRemove.length;

  if (!opts.apply) {
    if (base.drift > 0) {
      base.status = 'drift';
      base.detail.push(`${toAdd.length} scope entr(y|ies) to add, ${toRemove.length} to remove`);
    }
    return { receipt: base, nowApplied: artifact.ops };
  }

  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await tenantSettingsContainer();
    const doc: ApiScopeRegistryDoc = {
      id: registryId(opts.tenantId),
      tenantId: opts.tenantId,
      kind: 'api-scope-registry',
      entries: desired,
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
    base.applied = toAdd.length;
    base.revoked = toRemove.length;
    base.status = base.applied || base.revoked ? 'applied' : 'converged';
  } catch (e: any) {
    base.status = 'partial';
    base.errors = 1;
    base.detail.push(`persist api-scope registry failed: ${String(e?.message || e).slice(0, 160)}`);
  }
  return { receipt: base, nowApplied: artifact.ops };
}

// ── Honest config gates ───────────────────────────────────────────────────────
async function backendGate(backend: PolicyBackend): Promise<string | null> {
  switch (backend) {
    case 'synapse':
      if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
        return 'Synapse dedicated SQL is not configured — set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL to apply SQL DENY/RLS.';
      }
      return null;
    case 'adx': {
      try {
        const { kustoConfigGate } = await import('@/lib/azure/kusto-client');
        const g = kustoConfigGate();
        return g ? `Azure Data Explorer is not configured — set ${g.missing}.` : null;
      } catch (e: any) {
        return `ADX client unavailable: ${String(e?.message || e).slice(0, 120)}`;
      }
    }
    case 'unity-catalog': {
      try {
        const { isOssUc, ossUcBase } = await import('@/lib/azure/uc-backend');
        if (isOssUc()) {
          try {
            ossUcBase();
            return null;
          } catch {
            return 'OSS Unity Catalog is selected but not deployed — set LOOM_UNITY_URL (the loom-unity Container App).';
          }
        }
        if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
          return 'Databricks Unity Catalog is not configured — set LOOM_DATABRICKS_HOSTNAME (or LOOM_UC_BACKEND=oss + LOOM_UNITY_URL for the no-capacity OSS path).';
        }
        return null;
      } catch (e: any) {
        return `Unity Catalog client unavailable: ${String(e?.message || e).slice(0, 120)}`;
      }
    }
    case 'purview': {
      try {
        const { isPurviewConfigured } = await import('@/lib/azure/purview-client');
        return isPurviewConfigured() ? null : 'Microsoft Purview is not configured — set LOOM_PURVIEW_ACCOUNT to apply classifications/markings.';
      } catch (e: any) {
        return `Purview client unavailable: ${String(e?.message || e).slice(0, 120)}`;
      }
    }
    default:
      return null;
  }
}

// ── Live-state reads (real where cheap; else the prior snapshot) ──────────────
async function readLiveKeys(artifact: CompiledArtifact, priorOps: CompiledOp[], opts: ReconcileOptions): Promise<Set<string>> {
  const keys = new Set(priorOps.map((o) => o.key));

  if (artifact.backend === 'adx') {
    // Real read: database principals. Replace all `adx:add:*` keys with reality.
    const dbs = new Set(
      [...artifact.ops, ...priorOps].filter((o) => o.kind === 'principal').map((o) => o.target),
    );
    for (const k of [...keys]) if (k.startsWith('adx:add:')) keys.delete(k);
    if (dbs.size) {
      const { showDatabasePrincipals } = await import('@/lib/azure/kusto-client');
      for (const db of dbs) {
        const rows = await showDatabasePrincipals(db).catch(() => [] as Array<{ role: string; objectId: string }>);
        for (const r of rows) {
          if (r.objectId) keys.add(`adx:add:${db}:${r.role}:${r.objectId}`);
        }
      }
    }
  } else if (artifact.backend === 'synapse') {
    // Real read: RLS policies. Replace `synapse:rls:*` keys with reality.
    const rlsOps = [...artifact.ops, ...priorOps].filter((o) => o.kind === 'rls');
    if (rlsOps.length) {
      for (const k of [...keys]) if (k.startsWith('synapse:rls:')) keys.delete(k);
      try {
        const { dedicatedTargetResolved, listRlsPolicies } = await import('@/lib/azure/synapse-sql-client').then(
          async (sql) => ({ dedicatedTargetResolved: sql.dedicatedTargetResolved, listRlsPolicies: (await import('@/lib/azure/synapse-permissions-client')).listRlsPolicies }),
        );
        const target = await dedicatedTargetResolved(opts.tenantId);
        const live = await listRlsPolicies(target).catch(() => [] as Array<{ policyName: string }>);
        const liveNames = new Set(live.map((p) => p.policyName));
        // A desired/prior rls op is live iff its policy name is present.
        for (const op of rlsOps) {
          const m = /^synapse:rls:(.+):(.+)$/.exec(op.key);
          if (!m) continue;
          // policy name = pol_pc_<safe(stmt)>_<safe(table)>; recompute from op.
          const name = synapseRlsPolicyName(op);
          if (name && liveNames.has(name)) keys.add(op.key);
        }
      } catch {
        // Fall back to prior belief for RLS keys.
        for (const op of rlsOps) keys.add(op.key);
      }
    }
  }
  // unity-catalog / purview: prior-snapshot belief (grants/classifications are
  // idempotent; policy-driven deltas still converge). Real UC/Purview drift
  // reads are a follow-up (documented in the parity doc).
  return keys;
}

/** Recompute the Synapse RLS policy name for a compiled rls op (matches synapse.ts). */
function synapseRlsPolicyName(op: CompiledOp): string | null {
  // key: synapse:rls:<schema.table>:<stmtId>
  const m = /^synapse:rls:([^:]+):(.+)$/.exec(op.key);
  if (!m) return null;
  const table = m[1].split('.').pop() || m[1];
  const stmt = m[2];
  const safe = (s: string) => (String(s || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80)) || 'x';
  return `pol_pc_${safe(stmt)}_${safe(table)}`;
}

// ── Backend apply/revoke runners (real calls, lazy Azure imports) ─────────────
interface Runner {
  apply(op: CompiledOp, opts: ReconcileOptions): Promise<void>;
  revoke(op: CompiledOp, opts: ReconcileOptions): Promise<void>;
}

function backendRunner(backend: PolicyBackend): Runner {
  switch (backend) {
    case 'synapse':
      return synapseRunner();
    case 'unity-catalog':
      return unityRunner();
    case 'adx':
      return adxRunner();
    case 'purview':
      return purviewRunner();
    default:
      return {
        async apply() {
          /* handled elsewhere */
        },
        async revoke() {
          /* handled elsewhere */
        },
      };
  }
}

function synapseRunner(): Runner {
  const exec = async (sql: string, tenantId: string) => {
    const { dedicatedTargetResolved, executeQuery } = await import('@/lib/azure/synapse-sql-client');
    const target = await dedicatedTargetResolved(tenantId);
    for (const batch of sql.split(SQL_BATCH_SEP)) {
      const t = batch.trim();
      if (t) await executeQuery(target, t);
    }
  };
  return {
    apply: (op, opts) => exec(op.statement, opts.tenantId),
    revoke: (op, opts) => (op.undo ? exec(op.undo, opts.tenantId) : Promise.resolve()),
  };
}

function adxRunner(): Runner {
  const dbOf = (op: CompiledOp) => (op.target.includes('/') ? op.target.split('/')[0] : op.target);
  const exec = async (op: CompiledOp, statement: string) => {
    const { executeMgmtCommand } = await import('@/lib/azure/kusto-client');
    await executeMgmtCommand(dbOf(op), statement);
  };
  return {
    apply: (op) => exec(op, op.statement),
    revoke: (op) => (op.undo ? exec(op, op.undo) : Promise.resolve()),
  };
}

function unityRunner(): Runner {
  const runSql = async (sql: string) => {
    const { listWarehouses, executeStatement } = await import('@/lib/azure/databricks-client');
    const whs = await listWarehouses();
    const wh = whs.find((w: any) => String(w.state).toUpperCase() === 'RUNNING') || whs[0];
    if (!wh) throw new Error('no Databricks SQL warehouse available to execute the grant');
    for (const s of sql.split(UC_STMT_SEP)) {
      const t = s.trim();
      if (t) await executeStatement(wh.id, t);
    }
  };
  const runRest = async (op: CompiledOp, remove: boolean) => {
    if (!op.rest) throw new Error('OSS Unity Catalog cannot apply a row filter / column mask (no policy surface) — enforce at the serving engine.');
    const { resolveWorkspaceHostnames } = await import('@/lib/azure/unity-catalog-client');
    const { updatePermissions } = await import('@/lib/azure/unity-catalog-client');
    const hosts = await resolveWorkspaceHostnames();
    const host = hosts[0];
    const changes = remove
      ? { remove: [{ principal: op.rest.principal, privileges: op.rest.remove || op.rest.add || [] }] }
      : { add: [{ principal: op.rest.principal, privileges: op.rest.add || [] }] };
    await updatePermissions(host, op.rest.securableType as any, op.rest.securableName, changes as any);
  };
  const isOss = async () => {
    try {
      const { isOssUc } = await import('@/lib/azure/uc-backend');
      return isOssUc();
    } catch {
      return false;
    }
  };
  return {
    apply: async (op) => ((await isOss()) ? runRest(op, false) : runSql(op.statement)),
    revoke: async (op) => {
      if (await isOss()) return runRest(op, true);
      if (op.undo) return runSql(op.undo);
    },
  };
}

function purviewRunner(): Runner {
  const parse = (statement: string) => {
    const m = /CLASSIFICATION\s+("(?:[^"\\]|\\.)*")\s+TO\s+ASSET\s+("(?:[^"\\]|\\.)*")/.exec(statement);
    if (!m) return null;
    return { marking: JSON.parse(m[1]) as string, asset: JSON.parse(m[2]) as string };
  };
  const resolveGuid = async (asset: string): Promise<string | null> => {
    const { searchPurview } = await import('@/lib/azure/purview-client');
    const hits = await searchPurview(asset, 5).catch(() => [] as Array<{ id?: string; qualifiedName?: string; name?: string }>);
    const exact = hits.find((h) => h.qualifiedName === asset || h.name === asset) || hits[0];
    return exact?.id || null;
  };
  return {
    apply: async (op) => {
      const p = parse(op.statement);
      if (!p) return;
      const guid = await resolveGuid(p.asset);
      if (!guid) throw new Error(`asset "${p.asset}" not found in the Purview Data Map`);
      const { addAssetClassification } = await import('@/lib/azure/purview-client');
      await addAssetClassification(guid, [p.marking]);
    },
    revoke: async (op) => {
      // Best-effort: classification removal is optional (leaving a marking is
      // safe). Skipped when the client has no removal path.
      const p = parse(op.statement);
      if (!p) return;
      try {
        const mod: any = await import('@/lib/azure/purview-client');
        if (typeof mod.removeAssetClassification === 'function') {
          const guid = await resolveGuid(p.asset);
          if (guid) await mod.removeAssetClassification(guid, p.marking);
        }
      } catch {
        /* leaving a marking is safe */
      }
    },
  };
}

// ── Snapshot + audit persistence ──────────────────────────────────────────────
async function loadSnapshot(tenantId: string): Promise<PolicyCodeSnapshotDoc | null> {
  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(snapshotId(tenantId), tenantId).read<PolicyCodeSnapshotDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    return null;
  }
}

async function saveSnapshot(
  tenantId: string,
  applied: Partial<Record<PolicyBackend, CompiledOp[]>>,
  lastReceipt: PolicyReconcileReceipt,
): Promise<void> {
  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await tenantSettingsContainer();
    const doc: PolicyCodeSnapshotDoc = {
      id: snapshotId(tenantId),
      tenantId,
      kind: 'policy-code-state',
      applied,
      lastReceipt,
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
  } catch {
    /* snapshot is best-effort — reconcile is still idempotent without it */
  }
}

async function writeAudit(opts: ReconcileOptions, result: PolicyReconcileReceipt): Promise<void> {
  try {
    const { auditLogContainer } = await import('@/lib/azure/cosmos-client');
    const aud = await auditLogContainer();
    await aud.items.upsert({
      id: `policy-code-reconcile:${opts.tenantId}:${result.at}`,
      itemId: opts.tenantId,
      tenantId: opts.tenantId,
      kind: 'policy-code-reconcile',
      by: opts.updatedBy,
      ...result,
    });
  } catch {
    /* audit best-effort */
  }
}

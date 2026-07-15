/**
 * Platform (deployment-wide) runtime settings — the in-console home for gates
 * that used to live ONLY in a build-time / deploy-time env var.
 *
 * Today it backs the **BI backend** opt-in: whether Loom drives the Power BI
 * backend (model build + workspace sync + embed) or the Azure-native default.
 * The operator's complaint was that editors said "set
 * NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi" but there was NOWHERE in the console to
 * set it — and NEXT_PUBLIC_* is baked into the client bundle at BUILD time, so
 * it can never be runtime-toggled. This store fixes that: an admin flips the
 * backend in /admin, it persists to Cosmos, and the effective value is served
 * to the client at runtime (no rebuild).
 *
 * Persistence: a SINGLETON doc (id == partition == '__platform__') in the
 * existing `env-config` Cosmos container (PK /tenantId). Deployment-wide, not
 * per-user — matching the semantics of the LOOM_BI_BACKEND env var it layers
 * over. Reuses an existing container (createIfNotExists via `ensure()`), so no
 * new bicep/ARM step is required.
 *
 * Resolution order for the effective value (per the runtime-toggle mandate):
 *   1. runtime setting (admin-set in /admin)      ← this store
 *   2. server env  LOOM_BI_BACKEND                 ← deploy-time fallback
 *   3. default 'loom-native'                       ← Azure-native (no-fabric-dependency.md)
 *
 * Azure-native STAYS the default (no-fabric-dependency.md): Power BI is never
 * auto-enabled — it is an explicit in-console opt-in.
 */
import { envConfigContainer } from '@/lib/azure/cosmos-client';

/** The two BI-backend modes the client cares about. Azure-native is the default. */
export type BiBackendMode = 'loom-native' | 'powerbi';

export function isBiBackendMode(v: unknown): v is BiBackendMode {
  return v === 'loom-native' || v === 'powerbi';
}

/** Reserved singleton key — the platform doc is deployment-wide, not per-tenant. */
const PLATFORM_ID = '__platform__';

export interface PlatformSettingsDoc {
  /** Always '__platform__' — a single deployment-wide doc. */
  id: string;
  /** Partition key — always '__platform__'. */
  tenantId: string;
  /**
   * Admin-selected BI backend. When unset (the common case) resolution falls
   * through to the LOOM_BI_BACKEND env var and then the 'loom-native' default.
   */
  biBackend?: BiBackendMode;
  /**
   * Admin-set Azure Maps account name (the account's public uniqueId / name used
   * to prefill the geo editors and as the x-ms-client-id for the browser SDK).
   * When unset, resolution falls through to LOOM_AZURE_MAPS_ACCOUNT /
   * LOOM_AZURE_MAPS_CLIENT_ID. NOT a secret — the account id is public by design
   * (the browser SDK sends it as x-ms-client-id); the credential stays server-side.
   */
  mapsAccount?: string;
  /**
   * Admin-set Spark structured-streaming binding for eventstream notebook
   * sinks. When unset, resolution falls through to LOOM_SYNAPSE_WORKSPACE /
   * LOOM_DATABRICKS_WORKSPACE_URL (the deploy-time defaults).
   */
  sparkBinding?: SparkStreamingBinding;
  updatedAt?: string;
  updatedBy?: string;
}

/** The Spark runtime an eventstream notebook sink routes to. */
export interface SparkStreamingBinding {
  kind: 'synapse' | 'databricks';
  /** Synapse workspace NAME (kind: 'synapse'). */
  synapseWorkspace?: string;
  /** Databricks workspace URL, e.g. https://adb-123.11.azuredatabricks.net (kind: 'databricks'). */
  databricksUrl?: string;
}

/**
 * Effective Spark structured-streaming binding for eventstream notebook sinks:
 * runtime admin setting > env (LOOM_SYNAPSE_WORKSPACE, then
 * LOOM_DATABRICKS_WORKSPACE_URL) > null (genuinely unbound). Auto-detecting the
 * deployment's existing workspace binding here is what removes the day-one
 * "Requires a Spark structured-streaming binding" gate.
 */
export async function resolveSparkStreamingBinding(): Promise<
  (SparkStreamingBinding & { source: 'runtime' | 'env' }) | null
> {
  try {
    const doc = await readPlatformSettings();
    const b = doc?.sparkBinding;
    if (b && (b.kind === 'synapse' ? (b.synapseWorkspace || '').trim() : (b.databricksUrl || '').trim())) {
      return { ...b, source: 'runtime' };
    }
  } catch {
    /* fall through to env */
  }
  const synapse = (process.env.LOOM_SYNAPSE_WORKSPACE || '').trim();
  if (synapse) return { kind: 'synapse', synapseWorkspace: synapse, source: 'env' };
  const databricks = (process.env.LOOM_DATABRICKS_WORKSPACE_URL || '').trim();
  if (databricks) return { kind: 'databricks', databricksUrl: databricks, source: 'env' };
  return null;
}

/**
 * Persist the admin-selected Spark streaming binding to the singleton platform
 * doc. Callers MUST enforce the admin gate first (pure store helper).
 */
export async function writeSparkStreamingBinding(binding: SparkStreamingBinding, who: string): Promise<PlatformSettingsDoc> {
  const c = await envConfigContainer();
  const now = new Date().toISOString();
  let existing: PlatformSettingsDoc | null = null;
  try {
    existing = await readPlatformSettings();
  } catch {
    existing = null;
  }
  const doc: PlatformSettingsDoc = {
    ...(existing ?? {}),
    id: PLATFORM_ID,
    tenantId: PLATFORM_ID,
    sparkBinding: binding,
    updatedAt: now,
    updatedBy: who,
  };
  const { resource } = await c.items.upsert(doc);
  return (resource as unknown as PlatformSettingsDoc) ?? doc;
}

/**
 * Effective Azure Maps account label: runtime admin setting > server env
 * (LOOM_AZURE_MAPS_ACCOUNT, else the AAD account uniqueId LOOM_AZURE_MAPS_CLIENT_ID).
 * Non-sensitive — safe to serve to the client (it's the public x-ms-client-id).
 * Best-effort: a Cosmos failure falls back to env. Empty string when nothing set.
 */
export async function resolveMapsAccount(): Promise<string> {
  try {
    const doc = await readPlatformSettings();
    const v = (doc?.mapsAccount || '').trim();
    if (v) return v;
  } catch {
    /* fall through to env */
  }
  return (process.env.LOOM_AZURE_MAPS_ACCOUNT || process.env.LOOM_AZURE_MAPS_CLIENT_ID || '').trim();
}

/**
 * Env-only resolution of the BI backend mode (no Cosmos read). Used where an
 * await is impossible and as the fallback layer of {@link resolveBiBackendMode}.
 * Treats BOTH the server var and the legacy public var as opt-in signals; any
 * value other than 'powerbi' (including 'aas' and unset) is Azure-native.
 */
export function biBackendModeFromEnv(): BiBackendMode {
  const v = (process.env.LOOM_BI_BACKEND || process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || '')
    .trim()
    .toLowerCase();
  return v === 'powerbi' ? 'powerbi' : 'loom-native';
}

/** Read the singleton platform-settings doc (or null when never written). */
export async function readPlatformSettings(): Promise<PlatformSettingsDoc | null> {
  const c = await envConfigContainer();
  try {
    const { resource } = await c.item(PLATFORM_ID, PLATFORM_ID).read<PlatformSettingsDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/**
 * Effective BI backend mode: runtime admin setting > server env > default.
 * Best-effort — a Cosmos read failure falls back to the env/default resolution
 * (never throws, so a store outage can't break the editors' render path).
 */
export async function resolveBiBackendMode(): Promise<BiBackendMode> {
  try {
    const doc = await readPlatformSettings();
    if (isBiBackendMode(doc?.biBackend)) return doc!.biBackend!;
  } catch {
    /* fall through to env/default */
  }
  return biBackendModeFromEnv();
}

/** True when the effective backend is the Power BI opt-in. */
export async function powerBiEnabled(): Promise<boolean> {
  return (await resolveBiBackendMode()) === 'powerbi';
}

/**
 * Where the effective value came from — surfaced by the admin GET so the toggle
 * can show "set by admin" vs "from LOOM_BI_BACKEND env" vs "default".
 */
export type BiBackendSource = 'runtime' | 'env' | 'default';

export interface BiBackendResolution {
  mode: BiBackendMode;
  source: BiBackendSource;
  /** The raw runtime value stored in Cosmos (undefined when unset). */
  runtimeValue?: BiBackendMode;
  /** The raw env value (LOOM_BI_BACKEND), lower-cased, if present. */
  envValue?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** Resolve the effective mode AND report which layer supplied it. */
export async function resolveBiBackendWithSource(): Promise<BiBackendResolution> {
  const envRaw = (process.env.LOOM_BI_BACKEND || '').trim().toLowerCase();
  let doc: PlatformSettingsDoc | null = null;
  try {
    doc = await readPlatformSettings();
  } catch {
    doc = null;
  }
  if (isBiBackendMode(doc?.biBackend)) {
    return {
      mode: doc!.biBackend!,
      source: 'runtime',
      runtimeValue: doc!.biBackend!,
      envValue: envRaw || undefined,
      updatedAt: doc!.updatedAt,
      updatedBy: doc!.updatedBy,
    };
  }
  if (envRaw) {
    return { mode: biBackendModeFromEnv(), source: 'env', envValue: envRaw };
  }
  return { mode: 'loom-native', source: 'default' };
}

/**
 * Persist the admin-selected BI backend to the singleton platform doc. Callers
 * MUST enforce the admin gate first (this is a pure store helper).
 */
export async function writeBiBackendMode(mode: BiBackendMode, who: string): Promise<PlatformSettingsDoc> {
  const c = await envConfigContainer();
  const now = new Date().toISOString();
  let existing: PlatformSettingsDoc | null = null;
  try {
    existing = await readPlatformSettings();
  } catch {
    existing = null;
  }
  const doc: PlatformSettingsDoc = {
    ...(existing ?? {}),
    id: PLATFORM_ID,
    tenantId: PLATFORM_ID,
    biBackend: mode,
    updatedAt: now,
    updatedBy: who,
  };
  const { resource } = await c.items.upsert(doc);
  return (resource as unknown as PlatformSettingsDoc) ?? doc;
}

/**
 * Persist the admin-set Azure Maps account label to the singleton platform doc.
 * Pass '' to clear (fall back to env). Callers MUST enforce the admin gate first.
 */
export async function writeMapsAccount(account: string, who: string): Promise<PlatformSettingsDoc> {
  const c = await envConfigContainer();
  const now = new Date().toISOString();
  let existing: PlatformSettingsDoc | null = null;
  try {
    existing = await readPlatformSettings();
  } catch {
    existing = null;
  }
  const doc: PlatformSettingsDoc = {
    ...(existing ?? {}),
    id: PLATFORM_ID,
    tenantId: PLATFORM_ID,
    mapsAccount: account.trim() || undefined,
    updatedAt: now,
    updatedBy: who,
  };
  const { resource } = await c.items.upsert(doc);
  return (resource as unknown as PlatformSettingsDoc) ?? doc;
}

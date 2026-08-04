/**
 * Unity Catalog backend selector — Databricks UC (Commercial default) vs the
 * self-hosted OSS Unity Catalog server (`loom-unity`, the Azure-Government
 * default). Databricks Unity Catalog has no Azure Government endpoint; this
 * switch lets the SAME Loom UC client speak the SAME `/api/2.1/unity-catalog/*`
 * REST surface to an OSS Unity Catalog server deployed by
 * `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`.
 *
 * Selection (see {@link resolveUcBackend}):
 *   - `LOOM_UC_BACKEND=oss`         → OSS Unity Catalog (explicit opt-in).
 *   - `LOOM_UC_BACKEND=databricks`  → Databricks Unity Catalog (explicit).
 *   - unset → **auto**: Loom Unity when NO Databricks workspace is bound AND
 *     `LOOM_UNITY_URL` is set; otherwise Databricks. (admin-plane/main.bicep
 *     pins `oss` explicitly on GCC-High / IL5.)
 *
 * The OSS server and Databricks UC share the catalog / schema / table / volume /
 * function / model / permission REST shapes, so those operations route
 * transparently. OSS UC 0.5 (grounded in the upstream OpenAPI spec,
 * `api/all.yaml@v0.5.0`) additionally implements external locations,
 * credentials (its name for storage credentials — see
 * {@link ossUcRewritePath}), registered models + versions, functions, the
 * grants surface (`GET/PATCH /permissions/{securable_type}/{full_name}`), and
 * temporary credential vending. Genuinely Databricks-only families (Delta
 * Sharing, lineage-tracking / system tables, Lakehouse Federation connections,
 * workspace bindings, effective-permissions, online tables, clean rooms,
 * Marketplace) are gated honestly when the OSS backend is active (see
 * {@link ossUcUnsupportedPath}) rather than silently 404-ing.
 *
 * No Fabric / Power BI is ever reached — OSS Unity Catalog IS the Azure-native
 * backend (`.claude/rules/no-fabric-dependency.md`).
 *
 * LU-2 (AuthN/Z hardening) added the authorization half: {@link ossUcAuthHeader}
 * injects the Console's credential on every Loom Unity call so the BFF is the
 * single audited choke point, and {@link unityAuthorizationPosture} reports —
 * honestly — when nothing is configured and the catalog is therefore reachable
 * anonymously by anything on the VNet.
 *
 * KNOWN GAP — the `entra` mode does not authenticate against the OSS server.
 * Upstream `AuthDecorator` (unitycatalog v0.5.0, the pinned image, and v0.5.1)
 * rejects any bearer whose `iss` is not the server's own `internal` issuer, so a
 * Microsoft Entra access token presented directly on /api/2.1/unity-catalog/* is
 * answered 403 PERMISSION_DENIED even with an exact `server.audiences` match. A
 * client must first exchange it at POST /api/1.0/unity-control/auth/tokens and
 * present the returned internal token — a client this module does not implement
 * yet. Until it does, `LOOM_UNITY_TOKEN` (a server-minted token via Key Vault)
 * is the only working credential, and {@link unityAuthorizationPosture} reports
 * `entra` as NOT hardened. Both directions were verified by running the image;
 * transcript in docs/fiab/security/loom-unity-authz-proof.md.
 */

export type UcBackend = 'databricks' | 'oss';

/** True when either Databricks-workspace env is set (single or federated). */
function hasDatabricksWorkspace(): boolean {
  return !!(process.env.LOOM_DATABRICKS_HOSTNAMES || process.env.LOOM_DATABRICKS_HOSTNAME);
}

/**
 * Resolve the active Unity Catalog backend. Explicit `LOOM_UC_BACKEND` always
 * wins (admin-plane/main.bicep pins `oss` on GCC-High / IL5, where Databricks
 * Unity Catalog has no endpoint at all); otherwise auto-select Loom Unity
 * whenever there is NO Databricks workspace bound and a `loom-unity` URL is
 * configured. Defaults to Databricks, so any estate with a bound workspace is
 * byte-identical to before.
 *
 * The auto-select used to additionally require `isGovCloud()`. That made the
 * catalog unreachable on every Commercial estate — including estates with no
 * Databricks at all, where `LOOM_DATABRICKS_HOSTNAME` is empty and every Unity
 * surface honest-gated on Databricks while a fully-deployed, fully-paid-for Loom
 * Unity sat unused next to it. The cloud is not the deciding factor; whether a
 * Databricks workspace exists is.
 */
export function resolveUcBackend(): UcBackend {
  const explicit = (process.env.LOOM_UC_BACKEND || '').trim().toLowerCase();
  if (explicit === 'oss') return 'oss';
  if (explicit === 'databricks') return 'databricks';
  if (!hasDatabricksWorkspace() && !!process.env.LOOM_UNITY_URL) {
    return 'oss';
  }
  return 'databricks';
}

/** Convenience: is the OSS Unity Catalog backend active? */
export function isOssUc(): boolean {
  return resolveUcBackend() === 'oss';
}

export interface OssUcNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  followUp: string;
}

/** Thrown when the OSS backend is selected but `LOOM_UNITY_URL` is not set. */
export class OssUcNotConfiguredError extends Error {
  hint: OssUcNotConfiguredHint;
  constructor(hint: OssUcNotConfiguredHint) {
    super(`OSS Unity Catalog is not configured: missing ${hint.missingEnvVar}`);
    this.name = 'OssUcNotConfiguredError';
    this.hint = hint;
  }
}

/**
 * The OSS Unity Catalog server base URL (no trailing slash). Throws a structured
 * {@link OssUcNotConfiguredError} — naming the exact env var + bicep module — so
 * the BFF can surface an honest MessageBar gate when the backend is selected but
 * the service is not deployed.
 */
export function ossUcBase(): string {
  const url = (process.env.LOOM_UNITY_URL || '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new OssUcNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_URL',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      bicepStatus:
        'Deploy the loom-unity Container App (self-hosted OSS Unity Catalog) and set LOOM_UNITY_URL on the Console app.',
      followUp:
        'See docs/fiab/unity-gov.md for the az acr build + deploy steps. No Databricks or Fabric required.',
    });
  }
  return url;
}

/** Optional pre-shared bearer for the OSS server (a server-minted service token,
 * delivered as a Key Vault secretref — never a plain env literal in bicep). */
export function ossUcAuthToken(): string | undefined {
  const t = (process.env.LOOM_UNITY_TOKEN || '').trim();
  return t || undefined;
}

// ============================================================
// LU-2 — Loom Unity authorization (the BFF is the ONLY caller)
// ============================================================

/**
 * How the Console authenticates to Loom Unity (the self-hosted, Unity-Catalog-
 * compatible OSS server).
 *
 *   'token'     — a pre-shared server-minted bearer (`LOOM_UNITY_TOKEN`, a Key
 *                 Vault secretref). Highest precedence because it is the only
 *                 credential the upstream server mints for itself.
 *   'entra'     — the Console UAMI mints an Entra access token for the Loom Unity
 *                 audience (`LOOM_UNITY_AUDIENCE`, or `api://<client-id>/.default`
 *                 derived from `LOOM_UNITY_CLIENT_ID` / `LOOM_MSAL_CLIENT_ID`).
 *                 The server pins issuer + audience (server.allowed-issuers /
 *                 server.audiences — verified against upstream v0.5.1).
 *   'anonymous' — NOTHING is configured. Calls go out unauthenticated, which only
 *                 works against a server running `server.authorization=disable`:
 *                 the pre-LU-2 posture where anything on the VNet can read AND
 *                 mutate the catalog. This state is never silent — see
 *                 {@link unityAuthorizationPosture}, the `svc-loom-unity-authz`
 *                 gate, and the `probe-loom-unity-authz` live health probe, which
 *                 PROVES the open door by getting a 200 on an unauthenticated read.
 */
export type UnityAuthMode = 'token' | 'entra' | 'anonymous';

/** The Entra scope the Console requests its Loom Unity bearer for (undefined when
 * no app registration is wired at all). Mirrors the Iceberg-REST-catalog BFF
 * pattern: a dedicated `LOOM_UNITY_CLIENT_ID` when the operator registered one,
 * otherwise the Console's own app registration. */
export function unityAudience(): string | undefined {
  const explicit = (process.env.LOOM_UNITY_AUDIENCE || '').trim();
  if (explicit) return explicit;
  const clientId = (process.env.LOOM_UNITY_CLIENT_ID || '').trim();
  if (clientId) return `api://${clientId}/.default`;
  const msal = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  return msal ? `api://${msal}/.default` : undefined;
}

/**
 * True when the operator has DECLARED a Loom Unity audience. Deliberately does
 * NOT count the `LOOM_MSAL_CLIENT_ID` fallback: inferring "authorization is on"
 * from a var every deployment sets would make the Console fail closed against
 * catalogs that never enabled authorization (every pre-LU-2 estate). Hardening is
 * therefore always the result of an explicit declaration, and the un-declared
 * state is reported — never guessed at.
 */
function unityAudienceDeclared(): boolean {
  return !!((process.env.LOOM_UNITY_AUDIENCE || '').trim() || (process.env.LOOM_UNITY_CLIENT_ID || '').trim());
}

/** Resolve the active authentication mode. Explicit `LOOM_UNITY_AUTH_MODE` wins. */
export function resolveUnityAuthMode(): UnityAuthMode {
  const explicit = (process.env.LOOM_UNITY_AUTH_MODE || '').trim().toLowerCase();
  if (explicit === 'token' || explicit === 'entra' || explicit === 'anonymous') return explicit;
  if (ossUcAuthToken()) return 'token';
  if (unityAudienceDeclared()) return 'entra';
  return 'anonymous';
}

export interface UnityAuthorizationPosture {
  mode: UnityAuthMode;
  /** True when the Console presents a credential on every Loom Unity call. */
  hardened: boolean;
  /** Entra scope in use (entra mode only). */
  audience?: string;
  /** Honest, operator-facing description of the CURRENT posture. */
  detail: string;
  /** Exact remediation when `hardened` is false. */
  remediation?: string;
}

/**
 * The Console's Loom Unity authorization posture — surfaced on
 * `/api/catalog/unity/capabilities` so the UC panes can render an honest bar
 * instead of pretending an anonymous catalog is secured.
 */
export function unityAuthorizationPosture(): UnityAuthorizationPosture {
  const mode = resolveUnityAuthMode();
  if (mode === 'token') {
    return {
      mode,
      hardened: true,
      detail: 'Loom Unity calls carry a pre-shared server-minted bearer token (LOOM_UNITY_TOKEN, Key Vault secretref). The catalog rejects anonymous callers.',
    };
  }
  if (mode === 'entra') {
    // Upstream unitycatalog rejects any bearer whose `iss` is not its own
    // `internal` issuer — identical in v0.5.0 (the pinned image) and v0.5.1 —
    // so an Entra token presented DIRECTLY is answered 403 PERMISSION_DENIED on
    // /api/2.1/unity-catalog/* even when its audience matches `server.audiences`
    // byte for byte. Verified by running the image:
    // docs/fiab/security/loom-unity-authz-proof.md.
    //
    // The OAuth token-exchange client that closes this HAS LANDED (#2679):
    // ossUcAuthHeader() now POSTs the Entra token to
    // /api/1.0/unity-control/auth/tokens and sends the `internal` token that
    // comes back (lib/azure/uc-token-exchange.ts). This branch used to say the
    // client "does not exist yet" and told operators to set LOOM_UNITY_TOKEN —
    // a credential NO bicep module in the repo emits and no Key Vault secret
    // backs, so following it changed nothing. That text is corrected here.
    //
    // `hardened` stays FALSE deliberately, and this is NOT a leftover: the
    // exchange additionally requires the Console principal to be registered as
    // an enabled Unity Catalog user (AuthService.verifyPrincipal — proof doc
    // §"verifyPrincipal"), which no deploy step performs yet. Claiming hardened
    // before that is proven on a live catalog would be a fabricated green. The
    // live probe `probe-loom-unity-authz` is the authority either way.
    return {
      mode,
      hardened: false,
      audience: unityAudience(),
      detail: `Loom Unity calls carry a Microsoft Entra bearer minted by the Console managed identity for ${unityAudience()}, exchanged at /api/1.0/unity-control/auth/tokens for the server-minted internal token the catalog accepts (the raw Entra token is rejected 403 by design). Not yet confirmed hardened on a live catalog: the exchange also requires the Console principal to be an enabled Unity Catalog user.`,
      remediation:
        'Register the Console managed identity as an enabled Unity Catalog user on the catalog (AuthService.verifyPrincipal requires the token subject to be `admin` or an enabled user), then confirm with the probe-loom-unity-authz health check that an unauthenticated read is rejected. The token-exchange client itself is already wired (lib/azure/uc-token-exchange.ts, #2679) — no LOOM_UNITY_TOKEN is required for this path, and no bicep module emits one. Evidence: docs/fiab/security/loom-unity-authz-proof.md.',
    };
  }
  return {
    mode,
    hardened: false,
    detail: 'Loom Unity calls go out UNAUTHENTICATED. That only succeeds against a catalog running with authorization disabled — in which case every workload that can reach the Container Apps environment can read AND modify catalog metadata (and mint ADLS credentials if vending is wired).',
    remediation:
      'Redeploy platform/fiab/bicep/modules/compute/loom-unity-app.bicep with authMode=entra (the default) + entraClientId=<loom-unity app registration>, then set LOOM_UNITY_CLIENT_ID (or LOOM_UNITY_AUDIENCE) on the Console app so it mints a bearer. Alternatively set LOOM_UNITY_TOKEN from Key Vault. See docs/fiab/security/loom-unity-threat-model.md.',
  };
}

/** Thrown when Loom Unity authorization is REQUIRED but no credential can be
 * produced — the Console fails closed instead of silently retrying anonymously. */
export class OssUcAuthNotConfiguredError extends Error {
  hint: OssUcNotConfiguredHint;
  constructor(hint: OssUcNotConfiguredHint) {
    super(`Loom Unity authorization is not configured: ${hint.missingEnvVar}`);
    this.name = 'OssUcAuthNotConfiguredError';
    this.hint = hint;
  }
}

/**
 * The Authorization header for one Loom Unity call. The Console BFF is the single
 * audited choke point: no engine or user talks to `loom-unity` directly (its
 * ingress is internal + IP-pinned), so this is where the credential is injected.
 *
 * Fails CLOSED in `token` / `entra` mode — an unmintable token throws rather than
 * degrading to an anonymous request that would either 401 opaquely or, worse,
 * succeed against an unsecured server.
 */
export async function ossUcAuthHeader(): Promise<Record<string, string>> {
  // A pre-shared server-minted token always wins (the Iceberg-REST BFF pattern).
  const preShared = ossUcAuthToken();
  if (preShared) return { authorization: `Bearer ${preShared}` };

  const mode = resolveUnityAuthMode();
  if (mode === 'anonymous') return {};

  const audience = unityAudience();
  if (!audience) {
    throw new OssUcAuthNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_CLIENT_ID | LOOM_UNITY_AUDIENCE | LOOM_UNITY_TOKEN',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      bicepStatus:
        'LOOM_UNITY_AUTH_MODE requires the Console to authenticate to Loom Unity, but no audience or token is configured.',
      followUp:
        'Set LOOM_UNITY_CLIENT_ID (the Loom Unity Entra app registration) so the Console mints api://<client-id>/.default, or LOOM_UNITY_TOKEN from Key Vault. See docs/fiab/security/loom-unity-threat-model.md.',
    });
  }
  let entraToken: string | undefined;
  try {
    // Lazy import: this module is imported by the pure capability surface, so the
    // Azure credential chain must never be pulled in eagerly.
    const { uamiArmCredential } = await import('@/lib/azure/arm-credential');
    entraToken = (await uamiArmCredential().getToken(audience))?.token;
  } catch (e) {
    throw new OssUcAuthNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_AUDIENCE',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      bicepStatus: `The Console managed identity could not mint an Entra token for ${audience}: ${(e as Error)?.message || String(e)}`,
      followUp:
        'Confirm the Loom Unity app registration exposes that scope and the Console UAMI is permitted on it (or set LOOM_UNITY_TOKEN from Key Vault). See docs/fiab/security/loom-unity-threat-model.md.',
    });
  }

  if (entraToken) {
    // #2679 — the Entra token is the SUBJECT of an exchange, not the API
    // credential. Upstream AuthDecorator rejects any bearer whose `iss` is not
    // its own `internal` issuer, so presenting this directly is answered 403
    // even with a byte-exact audience. Exchange it for a server-minted internal
    // token and send that. Measured receipt:
    // docs/fiab/security/loom-unity-authz-proof.md.
    //
    // The exchange failure is raised on its OWN path rather than through the
    // minting catch above: minting SUCCEEDED here, and reporting an exchange
    // failure as "the managed identity could not mint a token" would send an
    // operator to Entra to debug a problem that lives in the catalog.
    const { exchangeForInternalUcToken } = await import('@/lib/azure/uc-token-exchange');
    const internal = await exchangeForInternalUcToken(entraToken);
    return { authorization: `Bearer ${internal}` };
  }

  throw new OssUcAuthNotConfiguredError({
    missingEnvVar: 'LOOM_UNITY_AUDIENCE',
    bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
    bicepStatus: `The Console managed identity returned no Entra token for ${audience}.`,
    followUp:
      'Confirm the Loom Unity app registration exposes that scope and the Console UAMI is permitted on it (or set LOOM_UNITY_TOKEN from Key Vault). See docs/fiab/security/loom-unity-threat-model.md.',
  });
}

/**
 * Drop the cached Loom Unity internal token, if this posture uses one.
 *
 * Called by the UC client when the catalog answers 401/403: a token the server
 * has stopped honouring (principal disabled, server restarted and forgot its
 * minted tokens) would otherwise keep failing every request for the rest of the
 * cache TTL.
 *
 * Re-minting the Entra token to recompute the cache key is cheap — the Azure
 * credential caches it and hands back the same string, so the digest matches the
 * entry that was used. If the Entra token HAS rotated in between, the recomputed
 * key simply misses, which is harmless: a rotated subject token cannot hit the
 * stale entry anyway.
 *
 * Deliberately does NOT retry the failed call. The 401/403 may have arrived on a
 * POST/PATCH/DELETE, and an automatic replay could double-apply a mutation. The
 * next request re-exchanges and succeeds.
 */
export async function invalidateUnityInternalToken(): Promise<void> {
  if (resolveUnityAuthMode() !== 'entra') return;
  const audience = unityAudience();
  if (!audience) return;
  try {
    const { uamiArmCredential } = await import('@/lib/azure/arm-credential');
    const token = (await uamiArmCredential().getToken(audience))?.token;
    if (!token) return;
    const { invalidateUcInternalToken } = await import('@/lib/azure/uc-token-exchange');
    await invalidateUcInternalToken(token);
  } catch {
    // Best-effort cache eviction on an error path — never mask the original
    // catalog failure the caller is about to surface.
  }
}

/**
 * Returns a human feature name when `path` targets a Unity Catalog REST family
 * that the OSS server does not implement, else `null`. The UC client uses this
 * to gate honestly on the OSS backend instead of emitting a confusing upstream
 * 404.
 *
 * Grounded in the upstream OSS Unity Catalog 0.5 OpenAPI spec (`api/all.yaml`):
 * catalogs / schemas / tables / volumes / functions / registered models (+
 * versions) / external locations / credentials / **permissions (grants)** /
 * temporary credentials / metastore_summary are all implemented and return
 * `null`. Delta Sharing, lineage-tracking, Lakehouse Federation connections,
 * workspace bindings, system schemas, online tables, clean rooms, Databricks
 * Marketplace, and the Jobs API are Databricks-only.
 *
 * `effective-permissions` STAYS in this list. LU-4 resolves the inheritance walk
 * in the BFF from the direct grants the OSS server DOES expose, so the FEATURE
 * is available on both backends — but the upstream OSS server still has no such
 * endpoint. Keeping the gate is defence in depth: `listEffectivePermissions`
 * never builds that path on OSS today, and if any future caller does, it gets
 * the honest 501 naming the missing capability instead of an opaque upstream
 * 404. (See `uc-effective-permissions.ts` for the resolver that makes the
 * feature work anyway.)
 */
export function ossUcUnsupportedPath(path: string): string | null {
  if (/\/(shares|recipients|providers)(\/|$|\?)/.test(path)) return 'Delta Sharing';
  if (/\/lineage-tracking\//.test(path)) return 'table/column lineage';
  if (/\/effective-permissions\//.test(path)) return 'the upstream effective-permissions endpoint (Loom resolves effective permissions in the BFF instead)';
  if (/\/unity-catalog\/connections(\/|$|\?)/.test(path)) return 'Lakehouse Federation connections';
  if (/\/unity-catalog\/bindings\//.test(path)) return 'workspace-catalog bindings';
  if (/\/systemschemas(\/|$)/.test(path)) return 'system schemas';
  if (/\/online-tables(\/|$)/.test(path)) return 'online tables';
  if (/\/clean-rooms(\/|$)/.test(path)) return 'clean rooms';
  if (/\/marketplace-consumer\//.test(path)) return 'Databricks Marketplace';
  if (/\/api\/2\.\d+\/jobs\//.test(path)) return 'Databricks jobs';
  return null;
}

/**
 * Rewrites a Databricks-flavoured UC REST path to its OSS Unity Catalog
 * equivalent. The two servers share almost the whole surface; the one naming
 * split is storage credentials: Databricks exposes
 * `/api/2.1/unity-catalog/storage-credentials` while OSS UC models the same
 * securable family as `/api/2.1/unity-catalog/credentials` (with
 * `purpose=STORAGE`) — including the permissions securable segment
 * (`storage_credential` → `credential`).
 */
export function ossUcRewritePath(path: string): string {
  return path
    .replace(/\/unity-catalog\/storage-credentials(?=\/|\?|$)/, '/unity-catalog/credentials')
    .replace(/\/unity-catalog\/permissions\/storage_credential\//, '/unity-catalog/permissions/credential/')
    .replace(/\/unity-catalog\/effective-permissions\/storage_credential\//, '/unity-catalog/effective-permissions/credential/');
}

// ============================================================
// Capability matrix — one source of truth for the API + UI + docs
// ============================================================

export type UcCapabilitySupport = 'full' | 'partial' | 'none';

export interface UcCapability {
  /** Stable id — also the row anchor in docs/fiab/unity-catalog-capability-matrix.md. */
  id: string;
  label: string;
  /** Support level on the Databricks Unity Catalog backend (Commercial default). */
  databricks: UcCapabilitySupport;
  /** Support level on the OSS Unity Catalog backend (Azure Government default). */
  oss: UcCapabilitySupport;
  /** Where the capability surfaces in Loom. */
  loomSurface: string;
  /** Honest per-backend note (what `partial`/`none` means + the Loom-native fallback). */
  note?: string;
}

/**
 * The full Unity Catalog capability set and its support level per backend.
 * `/api/catalog/unity/capabilities` serializes this (plus the active backend)
 * so every UC pane can render an honest per-cloud capability note instead of a
 * dead gate. Keep in sync with docs/fiab/unity-catalog-capability-matrix.md.
 */
export const UC_CAPABILITIES: UcCapability[] = [
  { id: 'metastores', label: 'Metastores', databricks: 'full', oss: 'partial', loomSurface: '/catalog/metastores', note: 'OSS UC is a single-metastore server (metastore_summary); Databricks federates metastores across workspaces.' },
  { id: 'catalogs', label: 'Catalogs (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'schemas', label: 'Schemas (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'tables', label: 'Tables (list/get/create/delete)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore', note: 'OSS UC has no PATCH /tables (owner/comment updates are Databricks-only).' },
  { id: 'views', label: 'Views (browse)', databricks: 'full', oss: 'partial', loomSurface: '/catalog/unity — Explore', note: 'Views surface through the tables list (table_type=VIEW). CREATE VIEW is a SQL-warehouse DDL on Databricks; OSS UC registers views created by engines that write to it.' },
  { id: 'volumes', label: 'Volumes (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'functions', label: 'Functions (list/get/create/delete)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'models', label: 'Registered models + versions', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore', note: 'Databricks governs models through the FUNCTION permissions path; OSS UC has a first-class registered_model securable.' },
  { id: 'grants', label: 'Grants / privileges (securable ACLs)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Grants', note: 'Both backends implement GET/PATCH /permissions/{securable}/{name}. The GET-with-authorization 500 ("No authorization expression found.", upstream issue #1603) is FIXED on the loom-unity image by overlaying the upstream v0.5.1 unitycatalog-server artifact (io.unitycatalog:unitycatalog-server:0.5.1 from Maven Central) onto the pinned v0.5.0 base — see apps/loom-unity/Dockerfile and tests/authz/authz-e2e.sh case 9 (now expects 200). A catalog still running an image built BEFORE that overlay 500s on the GET routes with authorization enabled — redeploy the rebuilt image. Pre-fix reproduction: docs/fiab/security/loom-unity-authz-proof.md.' },
  { id: 'effective-permissions', label: 'Effective (inherited) permissions', databricks: 'full', oss: 'partial', loomSurface: '/catalog/unity — Grants → "Effective (inherited)"', note: 'Databricks answers with its native /effective-permissions endpoint. The OSS Unity Catalog server has no such endpoint, so on that backend the Loom BFF composes the answer itself (LU-4) from the direct grants + owners of the containment chain, following the Unity Catalog permissions model on Learn: downward privilege inheritance filtered by what the child type accepts, ALL PRIVILEGES expanded (minus MANAGE / EXTERNAL USE *), ownership NON-inheriting (the owner of an ancestor gets MANAGE on the descendant and nothing more), USE CATALOG / USE SCHEMA prerequisites evaluated and reported, and — when you scope to one principal — its transitive group memberships unioned in. It is NOT byte-identical to the Databricks endpoint: the OSS privilege vocabulary has no MANAGE / BROWSE / APPLY TAG, so ancestor ownership confers nothing there, and a partially-qualified name yields direct grants only. Every such narrowing comes back as a warning. Optional: the group expansion needs Microsoft Graph Group.Read.All on the Console UAMI; without it the answer covers direct + inherited + ownership and says so. The resolver reads GET /permissions/{type}/{name} for the target and every ancestor; the authorization-enabled GET-500 (upstream #1603) that previously made every chain node degrade to a warning and return an empty answer is FIXED by the v0.5.1 unitycatalog-server overlay (see the grants row / apps/loom-unity/Dockerfile), so ancestor reads now succeed. The residual `partial` is the OSS privilege-vocabulary difference described above, not a read failure.' },
  { id: 'external-locations', label: 'External locations (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Storage' },
  { id: 'storage-credentials', label: 'Storage credentials (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Storage', note: 'OSS UC names the same family "credentials" (purpose=STORAGE); Loom rewrites the path transparently.' },
  { id: 'temporary-credentials', label: 'Temporary credential vending', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Storage', note: 'On OSS, ADLS vending needs the LOOM_UNITY_ADLS_* service principal on loom-unity; unset, data access stays on Loom managed-identity/ACL paths.' },
  { id: 'connections', label: 'Connections (Lakehouse Federation)', databricks: 'full', oss: 'none', loomSurface: '/catalog/unity — Federation', note: 'OSS UC has no federation. Loom-native fallback: Linked Services / Synapse + ADF connectors cover remote DBMS access in Gov.' },
  { id: 'delta-sharing', label: 'Delta Sharing (shares/recipients/providers)', databricks: 'full', oss: 'none', loomSurface: 'Marketplace — Data shares', note: 'OSS UC 0.5 does not implement the sharing server. Loom-native fallback: Loom Marketplace shares + access grants.' },
  { id: 'lineage', label: 'Lineage (table + column)', databricks: 'full', oss: 'none', loomSurface: '/catalog/lineage', note: 'Databricks system.access table + column lineage (via /lineage-tracking/). On OSS/Gov the equivalent is Loom-native UNIFIED COLUMN lineage: the shared col:<table>::<column> model (L1) that merges Purview column facets, Weave/Thread columnMappings, and OpenLineage ingest (L2/L3) into the same column-grain graph surface — default-ON, no gate. UC is simply one more source that folds onto that identity when a Databricks warehouse is present.' },
  { id: 'tags', label: 'Tags (object + column, governed tags)', databricks: 'full', oss: 'partial', loomSurface: '/catalog/unity — Governance · SQL warehouse editor — UC dialogs', note: 'UC-NATIVE tag DDL (ALTER … SET TAGS / CREATE GOVERNED TAG) runs on a Databricks SQL warehouse and stays Databricks-only. The Azure-native DEFAULT on BOTH backends is the LU-5 Loom governance overlay (/catalog/unity → Governance): tags, governed tags with an enforced value vocabulary, certification, and custom attributes stored against the `uc:<fqn>` securable identity in Cosmos, optionally folded into the classic Purview Data Map. No SQL warehouse, no Databricks, no Fabric.' },
  { id: 'governance-overlay', label: 'Governance overlay (tags / certification / attributes on uc:<fqn>)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Governance', note: 'Loom-native (LU-5). Keyed on the SAME securable identity the lineage merge collapses on, so an overlay row joins a lineage node, a Purview asset, and a Loom item with no extra mapping. Certification uses the shared Loom endorsement ladder; custom attributes reuse the tenant attribute groups.' },
  { id: 'abac', label: 'ABAC / row filters / column masks', databricks: 'full', oss: 'none', loomSurface: 'Governance — UC security panel', note: 'Policy DDL is warehouse-side. OSS fallback: enforce at the serving engine (Synapse/ADX policies).' },
  { id: 'system-tables', label: 'System tables (audit/billing/query/classification)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — audit dialogs', note: 'LU-3 built the WRITE half of an OSS access-audit equivalent: every catalog call funnels through the BFF audit choke point (ucFetch/dbxFetch → recordUnityAccess) into the Cosmos _auditLog trail and the LoomAudit_CL SIEM stream, so who/what/when/outcome (including DENIALS) is recorded today and readable with unityAuditKql() in Log Analytics / Sentinel. The in-product READER + /catalog/unity System-tables pane are a follow-up (no G1 in-browser E2E receipt yet) — until they land this row stays `none`, not `partial`. Billing and warehouse query history have no Loom Unity equivalent at all (no DBU meter, no query engine): /admin/finops and the engine surfaces answer those.' },
  { id: 'bindings', label: 'Workspace bindings (catalog isolation)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — bindings dialog', note: 'OSS UC is single-server; Loom workspace isolation is enforced by Loom workspace ACLs instead.' },
  { id: 'quality-monitors', label: 'Data quality monitors', databricks: 'full', oss: 'none', loomSurface: 'Catalog — data quality', note: 'OSS fallback: Loom data-quality checks (Great-Expectations-style) on Spark.' },
  { id: 'online-tables', label: 'Online tables', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor', note: 'OSS fallback: Lakebase/Postgres serving tables.' },
  { id: 'clean-rooms', label: 'Clean rooms', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor', note: 'Databricks-only collaboration surface.' },
  { id: 'marketplace', label: 'Databricks Marketplace', databricks: 'full', oss: 'none', loomSurface: 'Marketplace', note: 'OSS fallback: Loom Marketplace (API + Data products).' },
];

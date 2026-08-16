/**
 * kv-secret-purpose — WHICH Key Vault secrets a given feature is allowed to read.
 *
 * THE DEFECT THIS CLOSES (defence in depth):
 *   `getKeyVaultSecretValue(name)` accepted ANY secret name from ANY call site,
 *   and several call sites take that name (directly or transitively) from
 *   user-writable item state / request bodies. That made every platform secret
 *   in the Loom vault — `loom-msal-client-secret` above all, whose leak caused a
 *   full production sign-in outage on 2026-07-19 — reachable from a tenant-user
 *   request as soon as ANY destination bug existed anywhere in the codebase.
 *
 * THE MODEL
 *   Every read declares a PURPOSE. A purpose either
 *     (a) OWNS a name-space that Loom itself mints (`loom-conn-…`, `loom-git-…`)
 *         — reads outside that name-space are refused outright; or
 *     (b) is OPERATOR-NAMED (a DirectQuery credential, a Variable Library
 *         `secret-ref`, an app env binding) — an arbitrary name is legitimate,
 *         so the policy instead refuses the platform's own reserved secrets AND
 *         every OTHER purpose's minted name-space. A Loom App therefore cannot
 *         mount another user's connection password or git PAT, and nothing can
 *         reach the MSAL client secret.
 *
 *   The reserved set is BOTH a static list of the names platform bicep creates
 *   AND every name this deployment's own environment points at, so a rename in
 *   bicep cannot silently open a hole.
 *
 * This is deliberately a name-space policy, not a destination policy: the
 * destination fixes live with each feature (udf-endpoint-policy.ts,
 * connections/test, loom-apps-client git hosts). This module is the backstop
 * that keeps the blast radius of a FUTURE destination bug off the platform's
 * own credentials.
 */

/** Every reason Loom server code reads a secret out of the Loom Key Vault. */
export type KvSecretPurpose =
  /** A Loom Connection's stored credential (`secretRef`, minted `loom-conn-<uuid>`). */
  | 'connection-secret'
  /**
   * An external-source credential for a lakehouse SHORTCUT (S3 access key, GCS
   * service-account JSON, the Dataverse export path). The shortcut wizard mints
   * `loom-shortcut-<id>` but an operator may also point a shortcut at a
   * credential they named themselves, so this is operator-named rather than
   * name-space-owning.
   */
  | 'shortcut-credential'
  /** A git PAT / SPN secret for Git integration or a Loom App's private repo. */
  | 'git-credential'
  /** An Azure Functions host key for the UDF / functions-on-objects runtime. */
  | 'udf-function-key'
  /** A Variable Library `secret-ref` variable — the user names the secret. */
  | 'variable-library'
  /** A DirectQuery source credential for a semantic model — the operator names it. */
  | 'directquery-source'
  /** A KV secret name bound into a hosted Loom App's container env (ACA resolves the value). */
  | 'app-env-binding'
  /** A pipeline/trigger parameter bound to Key Vault — the author names the secret. */
  | 'pipeline-parameter'
  /** The credential an MCP server entry presents to its remote endpoint. */
  | 'mcp-server-credential';

/**
 * Name-spaces Loom MINTS. A purpose that owns one may read nothing else; a
 * purpose that owns none may read nothing INSIDE one of these (so an
 * operator-named surface cannot borrow another feature's credential).
 *
 * Keep in sync with every `putKeyVaultSecret()` call site:
 *   connections-store.ts        `loom-conn-<uuid>`
 *   connections/[id]/route.ts   reuses the existing `loom-conn-…` name
 *   git-binding-store.ts        `loom-git-<workspaceId>-<authMethod>`
 *   git-integration-client.ts   `loom-git-pat-<workspaceId>` (LOOM_GIT_PAT_KV_PREFIX)
 *   loom-app-runtime git-credential  `loom-app-git-<id8>`
 */
const MINTED_NAMESPACES: Record<string, readonly string[]> = {
  'connection-secret': ['loom-conn-'],
  'git-credential': ['loom-git-', 'loom-app-git-'],
};

/** Purposes whose secret NAME is chosen by an operator/user rather than minted by Loom. */
const OPERATOR_NAMED: readonly KvSecretPurpose[] = [
  'shortcut-credential',
  'udf-function-key',
  'variable-library',
  'directquery-source',
  'app-env-binding',
  'pipeline-parameter',
  'mcp-server-credential',
];

/**
 * Platform secrets that NO feature may ever read, whatever its purpose. These
 * are the credentials the Loom control plane itself runs on — every one is
 * created by `platform/fiab/bicep/modules/admin-plane/main.bicep` (or the
 * keyvault module) and wired to a Container App via a `secretRef`, never by a
 * user. Reading one from a request-driven path is always an exfiltration.
 */
const RESERVED_EXACT: readonly string[] = [
  'loom-msal-client-secret',
  'loom-internal-token',
  'loom-ci-token',
  'loom-iq-mcp-token',
  'loom-github-mcp-pat',
  'loom-github-actions-token',
  'loom-udf-host-key',
  'loom-airflow-admin-password',
  'loom-azure-maps-key',
  'loom-posture-function-key',
  'loom-paginated-render-key',
  'loom-alert-webhook-url',
  'loom-console-cosmos',
  'loom-dataverse-client-secret',
];

/** Shapes of platform credential names, so a bicep rename cannot open a hole. */
const RESERVED_PATTERNS: readonly RegExp[] = [
  /^loom-msal/i,
  /-actions-token$/i,
  /^loom-[a-z0-9-]*-mcp-(pat|token)$/i,
  /^loom-(internal|ci|iq)-token$/i,
  /-host-key$/i,
];

/**
 * Secret names this deployment's OWN configuration points at. Any env var whose
 * name ends in a secret-name suffix names a platform secret by definition — it
 * was set by bicep so a Container App could resolve it — so it joins the
 * reserved set automatically. Read live (not cached) so tests and a rolled
 * revision both see the current environment.
 */
function envConfiguredSecretNames(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (ENV_NAMES_FEATURE_SECRETS.has(k)) continue;
    if (!/^LOOM_[A-Z0-9_]*(SECRET_NAME|KV_SECRET|SECRET_REF|HOST_KEY)$/.test(k)) continue;
    out.push(v.trim().toLowerCase());
  }
  return out;
}

/**
 * Env vars that name a FEATURE secret rather than a platform credential — the
 * operator sets them precisely so a feature CAN read that secret, so harvesting
 * them into the reserved set would make the feature refuse its own configuration.
 * Anything added here must be a secret the platform itself never uses.
 */
const ENV_NAMES_FEATURE_SECRETS = new Set([
  'LOOM_UDF_FUNCTION_KEY_SECRET', // the function-host key udf-endpoint-policy resolves
]);

/** Thrown when a call site asks for a secret its purpose does not cover. */
export class KeyVaultSecretPolicyError extends Error {
  status = 403;
  constructor(public readonly secretName: string, public readonly purpose: KvSecretPurpose, detail: string) {
    super(detail);
    this.name = 'KeyVaultSecretPolicyError';
  }
}

/**
 * Secret names a purpose may read BECAUSE THE DEPLOYMENT NAMED THEM for that
 * purpose — the "select among operator config" escape from the reserved set.
 *
 * `mcp-server-credential`: an MCP catalog entry declares its Key Vault secret via
 * a `secretRefEnv` env var (lib/mcp/catalog.ts, e.g. LOOM_GITHUB_MCP_PAT_SECRET →
 * `loom-github-mcp-pat`). That name matches a reserved pattern — correctly, since
 * it is a platform-provisioned PAT — but the MCP client is the one surface that is
 * SUPPOSED to read it. Allowing exactly the configured value keeps the shipped
 * GitHub MCP server working while an ARBITRARY admin-supplied override of a
 * platform credential stays refused.
 */
function envAllowedNamesFor(purpose: KvSecretPurpose): string[] {
  if (purpose !== 'mcp-server-credential') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (!/^LOOM_[A-Z0-9_]*MCP[A-Z0-9_]*_(SECRET|PAT|KEY|TOKEN)$/.test(k)) continue;
    out.push(v.trim().toLowerCase());
  }
  return out;
}

/** True when `name` is a platform-reserved credential (never user-readable). */
export function isReservedPlatformSecret(name: string): boolean {
  const n = (name || '').trim().toLowerCase();
  if (!n) return false;
  if (RESERVED_EXACT.includes(n)) return true;
  if (RESERVED_PATTERNS.some((re) => re.test(n))) return true;
  return envConfiguredSecretNames().includes(n);
}

/**
 * Assert that `purpose` may read the secret called `name`. Throws
 * {@link KeyVaultSecretPolicyError} otherwise — callers surface it as an honest
 * error, never as a silent empty value (no-vaporware.md).
 */
export function assertSecretReadAllowed(name: string, purpose: KvSecretPurpose): void {
  const raw = (name || '').trim();
  if (!raw) {
    throw new KeyVaultSecretPolicyError(raw, purpose, 'A Key Vault secret name is required.');
  }
  const n = raw.toLowerCase();

  // 0) A name the DEPLOYMENT configured for this exact purpose is always fine —
  //    the caller is selecting operator config, not supplying its own name.
  if (envAllowedNamesFor(purpose).includes(n)) return;

  // 1) Platform credentials are off-limits to every purpose, always.
  if (isReservedPlatformSecret(n)) {
    throw new KeyVaultSecretPolicyError(
      raw,
      purpose,
      `"${raw}" is a Loom platform credential and cannot be read by the "${purpose}" surface. ` +
        'Reference a secret created for this feature instead.',
    );
  }

  const owned = MINTED_NAMESPACES[purpose];
  if (owned) {
    // 2) A purpose that owns a name-space may read ONLY inside it. The names are
    //    minted by Loom, so anything else is a caller supplying its own name.
    const extra = purpose === 'git-credential' ? [gitPatPrefix()] : [];
    const prefixes = [...owned, ...extra];
    if (!prefixes.some((p) => n.startsWith(p))) {
      throw new KeyVaultSecretPolicyError(
        raw,
        purpose,
        `The "${purpose}" surface may only read secrets Loom created for it ` +
          `(${prefixes.join(', ')}…). "${raw}" is outside that name-space.`,
      );
    }
    return;
  }

  // 3) An operator-named purpose may use any name EXCEPT another feature's
  //    minted name-space — otherwise e.g. a hosted app could mount another
  //    user's connection password or git PAT.
  if (OPERATOR_NAMED.includes(purpose)) {
    for (const [other, prefixes] of Object.entries(MINTED_NAMESPACES)) {
      if (prefixes.some((p) => n.startsWith(p))) {
        throw new KeyVaultSecretPolicyError(
          raw,
          purpose,
          `"${raw}" belongs to Loom's "${other}" name-space and cannot be read by the "${purpose}" surface. ` +
            'Create a dedicated secret for this binding.',
        );
      }
    }
    return;
  }

  /* c8 ignore next 5 -- unreachable while KvSecretPurpose is exhaustively handled above */
  throw new KeyVaultSecretPolicyError(raw, purpose, `Unknown Key Vault secret purpose "${purpose}".`);
}

/** The configurable git-PAT prefix (mirrors git-integration-client.patSecretName). */
function gitPatPrefix(): string {
  const p = (process.env.LOOM_GIT_PAT_KV_PREFIX || 'loom-git-pat').trim() || 'loom-git-pat';
  return `${p.toLowerCase()}-`;
}

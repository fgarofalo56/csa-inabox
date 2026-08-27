/**
 * LOOM BRAIN W10 — WHICH IDENTITY DID THIS RUN AUTHENTICATE AS? (#3936)
 *
 * PURE. No Azure SDK, no `node:*`, no environment, no network — this decodes a
 * string and compares two other strings. `./__tests__/purity.test.ts` enforces
 * that, which is what makes the assertion below provable with fixtures rather
 * than only observable at 04:11 UTC against a live tenant.
 *
 * ── WHY THIS EXISTS (review of #4014, B1) ──────────────────────────────────
 * The scan was going to authenticate as the DEPLOY SERVICE PRINCIPAL on every
 * run, in both boundaries, and nothing anywhere would have said so.
 *
 * MEASURED at head, by reading the installed SDK rather than the docs:
 * `apps/fiab-console/node_modules/@azure/identity` is **4.13.1**, and
 * `dist/commonjs/credentials/defaultAzureCredential.js:78-80` builds
 *
 *     prodCredentialFunctions = [
 *       createDefaultEnvironmentCredential,      <-- FIRST
 *       createDefaultWorkloadIdentityCredential,
 *       createDefaultManagedIdentityCredential,  <-- what this lane wanted
 *     ]
 *
 * and `:130` composes `[...prod, ...dev]` whenever `AZURE_TOKEN_CREDENTIALS` is
 * unset — which it is, everywhere: zero occurrences across all of
 * `.github/workflows`. The workflow set `AZURE_CLIENT_ID` /
 * `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` at JOB level, so
 * `EnvironmentCredential` succeeded first and the managed-identity leg was never
 * evaluated. `managedIdentityClientId` parameterised a leg that never ran, and
 * the two workflow steps that exist solely to resolve `LOOM_UAMI_CLIENT_ID` were
 * establishing nothing.
 *
 * The consequence was silent and total: the SP holds no Cosmos data-plane role
 * (the only `sqlRoleAssignments` in the platform bicep bind the console UAMI),
 * `disableLocalAuth: true` makes AAD-RBAC the only data-plane path, and
 * `recordRun` fires on OK, PAUSED **and** UNREACHABLE — so the lane could not
 * complete a single run in any verdict.
 *
 * ── THE POINT OF THIS MODULE ───────────────────────────────────────────────
 * Removing the shadowing env vars fixes the immediate bug. It does NOT stop the
 * next one: nothing in the lane could answer "which identity did I run as?", so
 * the same class could return through a different door — a re-added env var, a
 * runner without the UAMI attached, a chain-order change in a future SDK. This
 * module makes the answer an ASSERTED FACT of every run, checked against what
 * the run DECLARED it would use, and fails closed when they disagree.
 *
 * It is deliberately NOT a token validator. Nothing here verifies a signature,
 * an audience or an expiry — the token came from the SDK, not from a caller, and
 * pretending otherwise would be security theatre. It answers exactly one
 * question: WHO minted this.
 */

/** The identity claims this lane reads. Everything else in the token is ignored. */
export interface TokenIdentity {
  /**
   * The application (client) id of the principal. `appid` on a v1.0 token —
   * which is what ARM and Cosmos issue — and `azp` on a v2.0 one. For a
   * user-assigned managed identity this is its CLIENT id, i.e. the value the
   * platform bicep emits as `LOOM_UAMI_CLIENT_ID`.
   */
  readonly appId: string | null;
  /** The principal's object id. For a UAMI, its principal id. */
  readonly objectId: string | null;
  readonly tenantId: string | null;
}

/**
 * Decode a JWT's payload segment. Returns `null` when the string is not a JWT
 * this function can read — it does NOT guess and it does NOT throw.
 *
 * R7: "if the code does not know, the message says it does not know". The
 * caller decides what an unreadable token means; this only reports that it is
 * unreadable.
 */
export function decodeTokenIdentity(token: string): TokenIdentity | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  let json: string;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    json = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const c = claims as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  return {
    appId: str(c.appid) ?? str(c.azp),
    objectId: str(c.oid),
    tenantId: str(c.tid),
  };
}

/**
 * A GUID rendered so it is USEFUL in a public log without being the value.
 *
 * This repo is public and a workflow log is a publication surface, so the
 * established identity is printed as a prefix rather than in full. An 8-char
 * prefix is enough to tell two principals apart — which is the whole question —
 * and is not the identifier. GitHub masks `AZURE_CLIENT_ID` but cannot mask a
 * value it has never seen, so this does not rely on that.
 */
export function maskPrincipal(id: string | null): string {
  if (id === null || id.trim() === '') return '<none>';
  const v = id.trim();
  return v.length <= 8 ? `${v.slice(0, 2)}…` : `${v.slice(0, 8)}…`;
}

/** What the assertion established, whether or not it passed. */
export interface IdentityVerdict {
  readonly ok: boolean;
  readonly identity: TokenIdentity | null;
  /** Operator-readable, and TRUE — it states only what was established. */
  readonly message: string;
}

/**
 * Assert that the token was minted by the identity this run DECLARED.
 *
 * `expectedClientId` empty means the run declared no expectation — there is then
 * nothing to assert, and this REPORTS the identity rather than passing silently.
 * That is not an escape hatch for the check: a run with no expectation cannot
 * reach a private Cosmos account as a managed identity anyway, and the caller
 * surfaces the reported identity so the question "who ran this?" still has an
 * answer in the log.
 *
 * An UNREADABLE token with an expectation set is a FAILURE, not a pass. A run
 * that cannot establish its own identity cannot honestly report anything it
 * persisted, and a check that waves through what it could not parse is a check
 * that can be defeated by making it unparseable.
 */
export function assertTokenIdentity(args: {
  readonly token: string;
  readonly expectedClientId: string;
  readonly cloud: string;
}): IdentityVerdict {
  const expected = args.expectedClientId.trim();
  const identity = decodeTokenIdentity(args.token);

  if (expected === '') {
    return {
      ok: true,
      identity,
      message:
        `identity: this run declared NO expected identity (LOOM_UAMI_CLIENT_ID is unset), so ` +
        `nothing is asserted about it. The token was minted by appid=${maskPrincipal(
          identity?.appId ?? null,
        )} oid=${maskPrincipal(identity?.objectId ?? null)} in tenant ${maskPrincipal(
          identity?.tenantId ?? null,
        )}. If that is not a managed identity holding "Cosmos DB Built-in Data Contributor" ` +
        `on this estate's account, the first Cosmos call will return 403 — the account sets ` +
        `disableLocalAuth, so AAD-RBAC is the only data-plane path.`,
    };
  }

  if (identity === null) {
    return {
      ok: false,
      identity: null,
      message:
        `identity: this run expected to authenticate as ${maskPrincipal(expected)} but the ` +
        `minted token could NOT be decoded, so which identity produced it was not ` +
        `established. REFUSING to continue on an unestablished identity: the ${args.cloud} ` +
        `Cosmos account grants its data plane to exactly one principal, and a run that ` +
        `cannot say who it is cannot honestly report what it persisted. This says only what ` +
        `it observed — the token was not a readable three-segment JWT — and claims no cause ` +
        `beyond that.`,
    };
  }

  const actual = identity.appId;
  if (actual !== null && actual.toLowerCase() === expected.toLowerCase()) {
    return {
      ok: true,
      identity,
      message:
        `identity: authenticated as the declared identity ${maskPrincipal(expected)} ` +
        `(oid ${maskPrincipal(identity.objectId)}, tenant ${maskPrincipal(identity.tenantId)}) ` +
        `in ${args.cloud}. This is ASSERTED from the minted token, not inferred from the ` +
        `credential that was constructed.`,
    };
  }

  return {
    ok: false,
    identity,
    message:
      `identity: THE WRONG PRINCIPAL. This run declared it would authenticate as ` +
      `${maskPrincipal(expected)} (LOOM_UAMI_CLIENT_ID, read from the console app by the ` +
      `deploy) but the token was minted by appid=${maskPrincipal(actual)} ` +
      `oid=${maskPrincipal(identity.objectId)} in tenant ` +
      `${maskPrincipal(identity.tenantId)}. NOTHING has been persisted.\n` +
      `\n` +
      `WHY THIS HAPPENS: DefaultAzureCredential evaluates EnvironmentCredential BEFORE ` +
      `ManagedIdentityCredential (@azure/identity 4.13.1, defaultAzureCredential.js:78-80). ` +
      `If AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID are present in this ` +
      `process's environment, the service principal wins the chain and the managed-identity ` +
      `leg is never evaluated, whatever managedIdentityClientId says.\n` +
      `\n` +
      `REMEDIATION, in order of preference:\n` +
      `  1. Remove AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID from the job ` +
      `environment in .github/workflows/loom-brain-scan.yml. Azure/login takes its ` +
      `credentials inline via 'creds:', and 'az' uses the login session, so nothing else in ` +
      `either job reads them.\n` +
      `  2. If this runner genuinely has no managed identity attached (a GitHub-hosted ` +
      `runner has none at all), then this lane cannot run as the console UAMI here. Grant ` +
      `the principal above the Cosmos data-plane role explicitly:\n` +
      `       az cosmosdb sql role assignment create \\\n` +
      `         --account-name <account> --resource-group <rg> \\\n` +
      `         --scope "/" --principal-id <the oid above> \\\n` +
      `         --role-definition-id 00000000-0000-0000-0000-000000000002\n` +
      `     (00000000-…-0002 is the built-in "Cosmos DB Built-in Data Contributor".)`,
  };
}

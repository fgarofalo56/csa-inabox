/**
 * `ucSecurable` — the AUDITED facade for the Unity Catalog **storage-credential**
 * and **external-location** surface (issue #2622, gap 1 — the last of the three).
 *
 * ## Why this module exists, and why it is a FACADE rather than a `try/finally`
 *
 * LU-3 gave the Console a Unity Catalog access trail. Four transports now record
 * into it (`ucFetch`, `dbxFetch`, `ucSql`, `acctFetch`). One surface was left
 * out, and it is arguably the most consequential one:
 * `lib/azure/shortcut-credentials.ts` keeps its OWN private transport and issues
 *
 *     POST   /api/2.1/unity-catalog/storage-credentials
 *     DELETE /api/2.1/unity-catalog/storage-credentials/{name}
 *     POST   /api/2.1/unity-catalog/external-locations
 *     DELETE /api/2.1/unity-catalog/external-locations/{name}
 *
 * A storage credential is the object that hands a workload the right to read a
 * cloud storage account; an external location binds that credential to a URL
 * prefix. Creating one is the closest thing in Unity Catalog to minting access,
 * and none of it produced a Loom row.
 *
 * The obvious fix — wrap that file's transport in a `try/finally` like `ucSql`
 * did for the SQL half — is not available: the path is covered by a repo-level
 * credential-path read/write deny (the glob that protects `.env` and `secrets/`
 * also matches `*credentials*`), so the file cannot be edited here. Two previous
 * passes at #2622 recorded that as the reason gap 1 stayed open.
 *
 * A facade closes it WITHOUT touching the denied file, and the substitution is
 * exact because of a fact about the call graph: those five exports have exactly
 * ONE production consumer, `lib/azure/shortcut-engines.ts`. Re-pointing that one
 * import at this module puts every real call site behind the recorder.
 *
 * ## What makes this a CHOKE POINT and not merely a convention
 *
 * A facade nobody is obliged to use is a comment. Two mechanical controls, both
 * in `scripts/ci/check-unity-audit-chokepoint.mjs`, make this one load-bearing:
 *
 *   1. **check 1 (AUDITED_TRANSPORTS)** — this file is the FIFTH entry, so the
 *      guard brace-matches the `finally` of {@link ucSecurable} and fails the
 *      build if `recordUnitySecurableAccess(` ever leaves it. Recording outside
 *      the `finally` would drop exactly the DENIED calls, which on this surface
 *      means "who was refused permission to mint storage access".
 *   2. **check 8 (SECURABLE IMPORT CHOKE POINT)** — no module except this one
 *      may import a UC-mutating symbol from `shortcut-credentials.ts`. It is an
 *      ALLOWLIST of the two non-catalog exports (`getKeyVaultSecret`,
 *      `keyVaultConfigGate`), not a denylist of today's five, so a NEW
 *      un-audited export added to that write-denied file cannot be consumed
 *      anywhere without failing the build.
 *
 * Together those mean the un-audited functions still exist but are unreachable
 * from the rest of the app, which is the same end state as instrumenting them.
 *
 * ## The one rule you must not break here
 *
 * **The upstream error message never reaches the audit row.** These calls POST a
 * credential body — the GCP variant sends a service-account JSON containing
 * `private_key` — and `shortcut-credentials.ts` throws
 * `` `<fn> failed <status>: <response body>` ``, where a Unity Catalog 400
 * routinely echoes the offending request. A mutation row is fanned out to
 * tenant-registered OUTBOUND WEBHOOKS (third-party URLs), so `detail` is stamped
 * from the extracted STATUS CODE only. See `lib/azure/unity-audit.ts` § 3d.
 *
 * Behaviour is otherwise identical to the functions it wraps: same arguments,
 * same result, same thrown error. The audit write is fire-and-forget and cannot
 * turn a working call into a failure.
 *
 * No Microsoft Fabric / Power BI is reachable from any path in this file
 * (.claude/rules/no-fabric-dependency.md).
 */
import {
  ensureUcAwsStorageCredential as rawEnsureUcAwsStorageCredential,
  ensureUcGcpStorageCredential as rawEnsureUcGcpStorageCredential,
  ensureUcExternalLocation as rawEnsureUcExternalLocation,
  deleteUcExternalLocation as rawDeleteUcExternalLocation,
  deleteUcStorageCredential as rawDeleteUcStorageCredential,
} from './shortcut-credentials';
import { recordUnitySecurableAccess } from './unity-audit';

/**
 * The two Unity Catalog REST collections this module covers.
 *
 * Both spellings of the Databricks↔OSS naming split are already handled by
 * `classifyUnityCall`'s `FAMILY_SECURABLE` table, so the audit row reads
 * `storage_credential` / `external_location` on either backend.
 */
export const UC_STORAGE_CREDENTIALS_PATH = '/api/2.1/unity-catalog/storage-credentials';
export const UC_EXTERNAL_LOCATIONS_PATH = '/api/2.1/unity-catalog/external-locations';

/** One audited securable call, as handed to {@link ucSecurable}. */
export interface UcSecurableCall {
  /** REST path as issued: the collection for a CREATE, `/{name}` for a DELETE. */
  path: string;
  /** HTTP method as issued. */
  method: string;
  /**
   * Securable name for the row's `securableFqn`, from the caller's structured
   * params. A CREATE POSTs to the COLLECTION, so the path carries no name and
   * this is the only place the target can come from — it is deliberately NOT
   * parsed out of any response or error text.
   */
  target?: string;
}

/**
 * Run one storage-credential / external-location call and record a Unity Catalog
 * audit row for it — success, failure, or DENIED.
 *
 * The recorder is called from `finally`, so an authorization refusal produces a
 * row even though this function re-throws. That is the property the guard's
 * brace-accurate `finally` match exists to protect: a 403 on
 * `POST /storage-credentials` is precisely the row an ATO reviewer hunts for,
 * and it is the one a `catch`-shaped implementation would drop.
 *
 * Exported so the guard has a named function to brace-match, and so a future
 * securable call can be added to the trail by wrapping it here.
 */
export async function ucSecurable<T>(call: UcSecurableCall, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let failure: unknown;
  try {
    return await run();
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    recordUnitySecurableAccess({
      path: call.path,
      method: call.method,
      target: call.target,
      durationMs: Date.now() - startedAt,
      error: failure,
    });
  }
}

/**
 * Parameter and return types are derived from the wrapped functions with
 * `Parameters` / `Awaited<ReturnType>` rather than re-declared. A re-declaration
 * would be a second copy of a contract that lives in a file this module cannot
 * read, and the two would drift silently; derived types make a signature change
 * upstream a COMPILE error here instead.
 */
type Arg0<F extends (...a: never[]) => unknown> = Parameters<F>[0];
type Result<F extends (...a: never[]) => unknown> = Awaited<ReturnType<F>>;

/** Audited `POST /api/2.1/unity-catalog/storage-credentials` (AWS IAM role). */
export function ensureUcAwsStorageCredential(
  spec: Arg0<typeof rawEnsureUcAwsStorageCredential>,
): Promise<Result<typeof rawEnsureUcAwsStorageCredential>> {
  return ucSecurable(
    { path: UC_STORAGE_CREDENTIALS_PATH, method: 'POST', target: spec?.name },
    () => rawEnsureUcAwsStorageCredential(spec),
  );
}

/** Audited `POST /api/2.1/unity-catalog/storage-credentials` (GCP service account). */
export function ensureUcGcpStorageCredential(
  spec: Arg0<typeof rawEnsureUcGcpStorageCredential>,
): Promise<Result<typeof rawEnsureUcGcpStorageCredential>> {
  return ucSecurable(
    { path: UC_STORAGE_CREDENTIALS_PATH, method: 'POST', target: spec?.name },
    () => rawEnsureUcGcpStorageCredential(spec),
  );
}

/** Audited `POST /api/2.1/unity-catalog/external-locations`. */
export function ensureUcExternalLocation(
  args: Arg0<typeof rawEnsureUcExternalLocation>,
): Promise<Result<typeof rawEnsureUcExternalLocation>> {
  return ucSecurable(
    { path: UC_EXTERNAL_LOCATIONS_PATH, method: 'POST', target: args?.name },
    () => rawEnsureUcExternalLocation(args),
  );
}

/** Audited `DELETE /api/2.1/unity-catalog/external-locations/{name}`. */
export function deleteUcExternalLocation(
  name: string,
  force = true,
): Promise<Result<typeof rawDeleteUcExternalLocation>> {
  return ucSecurable(
    { path: `${UC_EXTERNAL_LOCATIONS_PATH}/${encodeURIComponent(name)}`, method: 'DELETE', target: name },
    () => rawDeleteUcExternalLocation(name, force),
  );
}

/** Audited `DELETE /api/2.1/unity-catalog/storage-credentials/{name}`. */
export function deleteUcStorageCredential(
  name: string,
  force = true,
): Promise<Result<typeof rawDeleteUcStorageCredential>> {
  return ucSecurable(
    { path: `${UC_STORAGE_CREDENTIALS_PATH}/${encodeURIComponent(name)}`, method: 'DELETE', target: name },
    () => rawDeleteUcStorageCredential(name, force),
  );
}

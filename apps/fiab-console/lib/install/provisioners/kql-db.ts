/**
 * Phase 2 — KQL Database provisioner.
 *
 * Real REST: ARM PUT /Microsoft.Kusto/clusters/{cluster}/databases/{name}
 * to create the database (calls kusto-client.createDatabase()), then
 * runs each `.create table` and `.alter policy` from the bundle via
 * kusto-client.executeMgmtCommand(), and ingests bundled sample rows
 * via .ingest inline.
 *
 * Idempotency: createDatabase is idempotent via ARM PUT; if the DB
 * already exists, ARM returns Succeeded.  `.create table` is also
 * idempotent in Kusto.
 *
 * Remediation gates:
 *   - LOOM_KUSTO_CLUSTER_URI missing → set it.
 *   - 401/403 on .create table → UAMI needs AllDatabasesAdmin on the cluster.
 */
import { createDatabase, executeMgmtCommand, KustoError } from '@/lib/azure/kusto-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
import { safeAdxDatabaseName } from '@/lib/azure/backing-name';
import { applyKqlBundle } from './_seed-kql-bundle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the data plane until a freshly-created Kusto database is queryable.
 *
 * ARM `createDatabase` is asynchronous — it commonly returns provisioningState
 * 'Creating'/'Accepted' and the database does NOT yet exist on the engine
 * nodes. Issuing `.create table` / `.ingest` against it in that window fails
 * with "Entity ID '<db>' of kind 'Database' was not found", which is the race
 * that left this app's KQL DB empty. We block on a cheap, idempotent data-plane
 * probe (`.show database <db> schema`) until it stops returning the not-found
 * error, then let the table/ingest commands run against a ready database.
 *
 * Returns true once the DB is queryable; false if it never became ready within
 * the budget (caller then surfaces an honest remediation gate instead of a
 * misleading 'created'). 401/403 are re-thrown so the caller can map them to
 * the precise AllDatabasesAdmin remediation. Grounded in Microsoft Learn:
 * Kusto database creation is an async ARM control-plane op and data-plane
 * availability lags the ARM PUT response.
 */
async function waitForDatabaseReady(
  dbName: string,
  steps: string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000; // up to 3 min for a cold create
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastErr = '';
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      // `.show database <db> schema` is a read-only no-op that only succeeds
      // once the database object is materialized on the engine nodes.
      await executeMgmtCommand(dbName, `.show database ["${dbName}"] schema`);
      steps.push(`KQL database '${dbName}' is ready (data-plane probe OK after ${attempt} attempt(s)).`);
      return true;
    } catch (e: any) {
      // Auth failures won't resolve by waiting — re-throw for precise gating.
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) throw e;
      lastErr = (e?.message || String(e)).toString();
      await sleep(intervalMs);
    }
  }
  steps.push(
    `KQL database '${dbName}' did not become queryable within ${Math.round(timeoutMs / 1000)}s` +
      (lastErr ? ` (last probe error: ${lastErr.slice(0, 160)}).` : '.'),
  );
  return false;
}

export const kqlDatabaseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;
  if (!process.env.LOOM_KUSTO_CLUSTER_URI && !process.env.LOOM_KUSTO_CLUSTER_NAME) {
    return {
      status: 'remediation',
      gate: {
        reason: 'ADX cluster not configured.',
        remediation:
          'Set LOOM_KUSTO_CLUSTER_URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.<cloud-suffix>) and LOOM_KUSTO_CLUSTER_NAME on the Console.',
        link: 'https://learn.microsoft.com/azure/data-explorer/',
      },
      steps,
    };
  }

  // 1. Provision the database via ARM. Database name = the SHARED Loom→ADX
  // name mapping (lib/azure/backing-name), which the open-time auto-bind
  // provider also calls — so auto-bind attaches to THIS database instead of
  // creating a second one beside it.
  const dbName = safeAdxDatabaseName(input.displayName);
  let provisioningState = '';
  try {
    const r = await createDatabase(dbName, { hotCacheDays: 7, softDeleteDays: 30 });
    provisioningState = String(r.provisioningState || '');
    steps.push(`ARM createDatabase '${dbName}' → ${r.provisioningState}.`);
  } catch (e: any) {
    if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Kusto ${e.status}: ARM not authorized.`,
          remediation:
            'Grant the Console UAMI Contributor on the Kusto cluster: az role assignment create --assignee <uami-objectid> --role Contributor --scope /subscriptions/.../Microsoft.Kusto/clusters/<cluster>',
          link: 'https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, 'Confirm LOOM_KUSTO_CLUSTER_URI points at a running ADX cluster and grant the Console UAMI Contributor on the cluster so it can create databases via ARM.', { link: 'https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions', steps });
  }

  // 1b. Wait for the async ARM create to materialize on the data plane before
  // issuing any control / data commands. ARM `createDatabase` is a long-running
  // op: when it returns a terminal 'Succeeded' the database is already
  // queryable, but when it returns 'Creating'/'Accepted'/'Running' the engine
  // is still materializing it and any `.create table`/`.ingest` would cascade
  // to "Entity ID '<db>' … was not found" (the race that left this DB empty
  // while still reporting 'created'). Probe only in the non-terminal case.
  const armTerminal = provisioningState.toLowerCase() === 'succeeded';
  if (!armTerminal) {
    try {
      const ready = await waitForDatabaseReady(dbName, steps);
      if (!ready) {
        return {
          status: 'remediation',
          error: `KQL database '${dbName}' was accepted by ARM but did not become queryable in time.`,
          gate: {
            reason: `KQL database '${dbName}' creation is still in progress (async ARM op).`,
            remediation:
              `The database was accepted by ARM but the engine had not finished materializing it when provisioning ran. ` +
              `Click Retry in a minute — createDatabase is idempotent, the readiness probe will pass once it is online, ` +
              `and the tables + sample rows will then seed.`,
            link: 'https://learn.microsoft.com/azure/data-explorer/create-cluster-and-database',
          },
          steps,
        };
      }
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to read database '${dbName}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      return resolveInfraResidual(e, `Grant the Console UAMI AllDatabasesAdmin on the ADX cluster so it can read database '${dbName}'.`, { link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers', steps });
    }
  }

  // 2. Apply the bundle to the ready database — tables + verified sample-row
  //    seeds, functions, and ingestion/table policies.
  //
  //    This is the SHARED applier (`./_seed-kql-bundle`). It used to live
  //    inline here, which meant the open-time auto-bind path had no way to
  //    reach it: `auto-bind-providers.adxDatabaseAutoBind.create()` made the
  //    database and stopped, so a config-gated install left a REAL but
  //    permanently EMPTY database that answered every query with "no results"
  //    (#3549). Both paths now apply a bundle identically.
  const apply = await applyKqlBundle(dbName, content, steps);
  if (apply.authGate) {
    return {
      status: 'remediation',
      gate: {
        reason: `Kusto ${apply.authGate.status}: not authorized to run ${apply.authGate.phase} on database '${dbName}'.`,
        remediation:
          'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
        link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
      },
      steps,
    };
  }
  const {
    tableCreateFailures,
    ingestFailures,
    expectedSeedTables,
    functionFailures,
    policyFailures,
    criticalPolicyFailures,
    declaredTables,
  } = apply;

  // Honest status: never report 'created' for a functionally-empty database.
  // If the bundle declared tables but every .create table failed, or if every
  // sample-row ingest failed, the data-bearing artifact did not actually land
  // — surface that as 'failed' so the install outcome reflects reality
  // (per no-vaporware: a 'created' that is actually broken is forbidden).
  if (declaredTables > 0 && tableCreateFailures >= declaredTables) {
    return {
      status: 'failed',
      error: `All ${declaredTables} table-create command(s) failed on '${dbName}'; the database has no tables.`,
      resourceId: dbName,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: dbName },
      steps,
    };
  }
  if (expectedSeedTables > 0 && ingestFailures >= expectedSeedTables) {
    return {
      status: 'failed',
      error: `Schema created on '${dbName}' but all ${expectedSeedTables} sample-row ingests failed; no rows landed.`,
      resourceId: dbName,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: dbName },
      steps,
    };
  }
  // A failed UPDATE policy is data-correctness wiring (it fans RawOrders into
  // Orders), so per no-vaporware it remains fatal even when tables + rows
  // landed — a 'created' that silently drops the curated-table feed is
  // forbidden. (This is what previously hid the cascading SEM0260 update-policy
  // failure behind a green 'created'.)
  if (criticalPolicyFailures > 0) {
    return {
      status: 'failed',
      error:
        `KQL database '${dbName}' tables + rows landed, but ${criticalPolicyFailures} update-policy ` +
        `command(s) failed — see steps. The streaming update policy that feeds the curated table is ` +
        `not wired, so the database is not functionally complete.`,
      resourceId: dbName,
      secondaryIds: { cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '', database: dbName },
      steps,
    };
  }
  // Residual function / non-update-policy (caching, retention, streamingingestion,
  // ingestionbatching) failures do NOT abort a database whose tables + rows
  // already seeded: the schema and data are queryable, and caching/retention are
  // performance/operational tuning, while standalone detection functions are
  // analyst conveniences — not the data-correctness path. We report 'created'
  // and surface the residual failures honestly in `steps` (per no-vaporware:
  // the partial failure is disclosed, not hidden behind a false 'failed' that
  // would discard a working seeded database). The two known live failures
  // (`.alter-merge … policy caching` SYN0002 and the `$table` SEM0100 function)
  // are now emitted correctly above, so this branch should be empty in practice.
  if (functionFailures > 0 || policyFailures > 0) {
    steps.push(
      `KQL database '${dbName}' created with tables + rows seeded; ${functionFailures} function ` +
        `command(s) and ${policyFailures} non-critical policy command(s) did not apply — see above. ` +
        `These are conveniences/tuning, not the data path; re-run is idempotent and will retry them.`,
    );
  }

  return {
    status: 'created',
    resourceId: dbName,
    secondaryIds: {
      cluster: process.env.LOOM_KUSTO_CLUSTER_URI || '',
      database: dbName,
    },
    steps,
  };
};

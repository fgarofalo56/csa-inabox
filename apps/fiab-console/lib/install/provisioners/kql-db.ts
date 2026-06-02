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
import { createDatabase, executeMgmtCommand, ingestInline, KustoError } from '@/lib/azure/kusto-client';
import type { Provisioner, ProvisionResult } from './types';

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
          'Set LOOM_KUSTO_CLUSTER_URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.windows.net) and LOOM_KUSTO_CLUSTER_NAME on the Console.',
        link: 'https://learn.microsoft.com/azure/data-explorer/',
      },
      steps,
    };
  }

  // 1. Provision the database via ARM.  Database name = slug-friendly
  // version of the displayName.
  const dbName = input.displayName.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50) || 'loomdb';
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
    return { status: 'failed', error: e?.message || String(e), steps };
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
      return { status: 'failed', error: e?.message || String(e), steps };
    }
  }

  // 2. Apply bundle: .create table per table, .ingest inline sample rows.
  // Track whether every data-bearing step actually landed so we never report a
  // misleading 'created' for a functionally-empty database.
  let tableCreateFailures = 0;
  let ingestFailures = 0;
  let expectedSeedTables = 0;
  const tables: Array<{ name: string; columns: { name: string; type: string }[]; sample?: any[][] }> = Array.isArray(content?.tables) ? content.tables : [];
  for (const t of tables) {
    const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ');
    const createCmd = `.create table ${t.name} (${cols})`;
    try {
      await executeMgmtCommand(dbName, createCmd);
      steps.push(`.create table ${t.name} OK.`);
    } catch (e: any) {
      if (e instanceof KustoError && (e.status === 401 || e.status === 403)) {
        return {
          status: 'remediation',
          gate: {
            reason: `Kusto ${e.status}: not authorized to .create table on database '${dbName}'.`,
            remediation:
              'Grant the Console UAMI AllDatabasesAdmin on the cluster: az kusto cluster-principal-assignment create --principal-id <uami-objectid> --principal-type App --role AllDatabasesAdmin',
            link: 'https://learn.microsoft.com/azure/data-explorer/access-control/principals-and-identity-providers',
          },
          steps,
        };
      }
      tableCreateFailures += 1;
      steps.push(`.create table ${t.name} failed: ${e?.message || String(e)}`);
    }
    if (Array.isArray(t.sample) && t.sample.length > 0) {
      expectedSeedTables += 1;
      try {
        await ingestInline(dbName, t.name, t.sample);
        steps.push(`Inline-ingested ${t.sample.length} rows into ${t.name}.`);
      } catch (e: any) {
        ingestFailures += 1;
        steps.push(`Inline ingest into ${t.name} failed: ${e?.message || String(e)}`);
      }
    }
  }

  // 3. Functions.
  //
  // A function `body` carries one of two shapes:
  //   (a) a COMPLETE control command — `.create-or-alter function Name(args)
  //       { … }` (optionally preceded by `//` comment lines). This is the
  //       shape every content bundle uses, because functions with parameters
  //       (e.g. DomainCostRollup(LookbackDays:int=30)) can only be expressed
  //       as a full command. These must run VERBATIM. Re-wrapping them in
  //       `.create-or-alter function Name { <full command> }` produces a
  //       nested, malformed command (SYN0002 "Expected: }").
  //   (b) a bare function body expression — wrap it as
  //       `.create-or-alter function Name { <body> }`.
  //
  // We detect (a) by scanning past any leading `//` comment / blank lines for
  // a leading `.create`/`.create-or-alter function` token.
  const fns: Array<{ name: string; body: string }> = Array.isArray(content?.functions) ? content.functions : [];
  for (const fn of fns) {
    const body = String(fn.body ?? '');
    const firstCodeLine = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('//'));
    const isFullCommand = /^\.create(-or-alter)?\s+function\b/i.test(firstCodeLine ?? '');
    const cmd = isFullCommand ? body : `.create-or-alter function ${fn.name} { ${body} }`;
    try {
      await executeMgmtCommand(dbName, cmd);
      steps.push(`.create-or-alter function ${fn.name} OK.`);
    } catch (e: any) {
      steps.push(`.create-or-alter function ${fn.name} failed: ${e?.message || String(e)}`);
    }
  }

  // 4. Ingestion / table policies.
  //
  // The bundle's `policy` field carries one of two shapes:
  //   (a) a complete control script — one-or-more `.alter` / `.alter-merge`
  //       policy commands, possibly multi-line (retention, caching,
  //       streamingingestion, etc.). These must be executed VERBATIM, one
  //       command per line. Wrapping them in `.alter table … policy
  //       ingestionbatching @'<policy>'` would malform them.
  //   (b) a raw ingestion-batching policy JSON body (legacy shape) — wrap it
  //       in the documented `.alter table <t> policy ingestionbatching @'…'`.
  //
  // We detect (a) by the leading `.alter` token and run each statement as-is;
  // otherwise we fall back to (b).
  const policies: Array<{ table: string; policy: string }> = Array.isArray(content?.ingestionPolicies) ? content.ingestionPolicies : [];
  for (const p of policies) {
    const raw = String(p.policy ?? '');
    const isControlScript = /^\s*\.alter(-merge)?\b/i.test(raw);
    if (isControlScript) {
      // Split into individual control commands. Kusto control commands are
      // newline-delimited; a leading `.alter`/`.alter-merge` starts each one.
      const commands = raw
        .split(/\r?\n/)
        // Collapse internal runs of whitespace to single spaces. Policy
        // control commands (retention/caching/streamingingestion) are
        // keyword=value DDL with no whitespace-significant string literals,
        // and the Kusto parser rejects misaligned multi-space formatting
        // (e.g. `policy caching   hot        =  90d` → SYN0002). Normalizing
        // makes hand-aligned bundle text parse cleanly.
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .filter((l) => l.length > 0);
      for (const cmd of commands) {
        try {
          await executeMgmtCommand(dbName, cmd);
          steps.push(`Policy command on ${p.table} OK: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`);
        } catch (e: any) {
          steps.push(`Policy command on ${p.table} failed (${cmd.slice(0, 60)}…): ${e?.message || String(e)}`);
        }
      }
    } else {
      try {
        await executeMgmtCommand(dbName, `.alter table ${p.table} policy ingestionbatching @'${raw.replace(/'/g, "''")}'`);
        steps.push(`.alter ingestionbatching policy on ${p.table} OK.`);
      } catch (e: any) {
        steps.push(`.alter ingestionbatching policy on ${p.table} failed: ${e?.message || String(e)}`);
      }
    }
  }

  // Honest status: never report 'created' for a functionally-empty database.
  // If the bundle declared tables but every .create table failed, or if every
  // sample-row ingest failed, the data-bearing artifact did not actually land
  // — surface that as 'failed' so the install outcome reflects reality
  // (per no-vaporware: a 'created' that is actually broken is forbidden).
  const declaredTables = tables.length;
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

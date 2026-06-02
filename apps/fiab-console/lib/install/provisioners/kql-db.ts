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
  try {
    const r = await createDatabase(dbName, { hotCacheDays: 7, softDeleteDays: 30 });
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

  // 2. Apply bundle: .create table per table, .ingest inline sample rows.
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
      steps.push(`.create table ${t.name} failed: ${e?.message || String(e)}`);
    }
    if (Array.isArray(t.sample) && t.sample.length > 0) {
      try {
        await ingestInline(dbName, t.name, t.sample);
        steps.push(`Inline-ingested ${t.sample.length} rows into ${t.name}.`);
      } catch (e: any) {
        steps.push(`Inline ingest into ${t.name} failed: ${e?.message || String(e)}`);
      }
    }
  }

  // 3. Functions.
  const fns: Array<{ name: string; body: string }> = Array.isArray(content?.functions) ? content.functions : [];
  for (const fn of fns) {
    try {
      await executeMgmtCommand(dbName, `.create-or-alter function ${fn.name} { ${fn.body} }`);
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
        .map((l) => l.trim())
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

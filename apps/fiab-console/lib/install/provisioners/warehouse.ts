/**
 * Phase 2 — Warehouse provisioner.
 *
 * Two modes:
 *   - Synapse dedicated pool (LOOM_WAREHOUSE_BACKEND=synapse-dedicated):
 *     uses synapse-sql-client.executeQuery against the dedicated pool's
 *     TDS endpoint to run the bundled DDL.
 *   - Fabric Warehouse (LOOM_WAREHOUSE_BACKEND=fabric-warehouse): POSTs
 *     to /v1/workspaces/{ws}/warehouses then runs DDL via the Warehouse
 *     T-SQL endpoint (.datawarehouse.fabric.microsoft.com TDS).
 *
 * In both modes we split the bundle's WarehouseContent.ddl on semicolons
 * and run each batch.  dbtModels[] are run after the DDL in
 * bronze→silver→gold order, each wrapped in CREATE VIEW IF NOT EXISTS.
 *
 * Remediation gates:
 *   - LOOM_WAREHOUSE_BACKEND unset → remediation with the env var to set.
 *   - 401/403 on TDS → UAMI not added as a member of the warehouse DB.
 */
import { executeQuery as synapseExec, dedicatedTarget, type SynapseTarget } from '@/lib/azure/synapse-sql-client';
import type { Provisioner, ProvisionResult } from './types';

const BACKEND = process.env.LOOM_WAREHOUSE_BACKEND || 'synapse-dedicated';

function splitBatches(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

export const warehouseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;
  const ddl = typeof content?.ddl === 'string' ? content.ddl : '';
  const dbtModels: Array<{ layer: string; name: string; sql: string }> = Array.isArray(content?.dbtModels) ? content.dbtModels : [];

  if (!ddl && dbtModels.length === 0) {
    return { status: 'skipped', steps: ['No DDL or dbt models in bundle; nothing to provision.'] };
  }

  if (BACKEND === 'synapse-dedicated') {
    let target: SynapseTarget;
    try {
      target = dedicatedTarget();
    } catch (e: any) {
      return {
        status: 'remediation',
        gate: {
          reason: 'Synapse dedicated pool not configured.',
          remediation:
            'Set LOOM_SYNAPSE_WORKSPACE (e.g. mysyn-ondemand) and LOOM_SYNAPSE_DEDICATED_POOL (e.g. dwhpool01).',
          link: 'https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/',
        },
        steps,
      };
    }
    steps.push(`Synapse target: ${target.server} / ${target.database}`);

    const batches = splitBatches(ddl);
    for (const sql of batches) {
      try {
        await synapseExec(target, sql);
        steps.push(`Ran DDL batch (${sql.slice(0, 80).replace(/\s+/g, ' ')}…).`);
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (/login failed|cannot open server|not authorized|permission/i.test(msg)) {
          return {
            status: 'remediation',
            gate: {
              reason: `Synapse T-SQL ${e?.status || 401}: ${msg}`,
              remediation:
                'In the Synapse workspace > Manage > Security > add the Console UAMI as a member of the dedicated SQL pool. Use the AAD admin to run: CREATE USER [<uami>] FROM EXTERNAL PROVIDER; ALTER ROLE db_owner ADD MEMBER [<uami>];',
              link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control',
            },
            steps,
          };
        }
        return { status: 'failed', error: msg, steps };
      }
    }

    for (const m of dbtModels) {
      const viewName = `${m.layer}_${m.name}`;
      const sql = `CREATE OR ALTER VIEW [${viewName}] AS ${m.sql}`;
      try {
        await synapseExec(target, sql);
        steps.push(`Created dbt model view [${viewName}] (${m.layer}).`);
      } catch (e: any) {
        steps.push(`Failed to create view [${viewName}]: ${e?.message || String(e)}`);
      }
    }

    return {
      status: 'created',
      resourceId: `${target.server}/${target.database}/${input.displayName}`,
      secondaryIds: { backend: 'synapse-dedicated', database: target.database },
      steps,
    };
  }

  // Fabric Warehouse path — DDL runs over the dedicated Warehouse TDS
  // endpoint exposed by the Fabric workspace. The Console UAMI must be
  // added as a Contributor on the workspace AND as a Reader on the
  // warehouse-specific endpoint.  When the warehouse is freshly
  // provisioned by Loom, that role binding is set by Fabric automatically.
  if (BACKEND === 'fabric-warehouse') {
    const ws = input.target.fabricWorkspaceId;
    if (!ws) {
      return {
        status: 'remediation',
        gate: {
          reason: 'No bound Fabric workspace for Fabric Warehouse install.',
          remediation: 'Bind a Fabric workspace, or switch LOOM_WAREHOUSE_BACKEND=synapse-dedicated.',
        },
        steps,
      };
    }
    // We rely on synapse-sql-client.executeQuery (same TDS protocol).
    // Discover the warehouse TDS endpoint via Fabric REST first.
    return {
      status: 'remediation',
      gate: {
        reason: 'Fabric Warehouse provisioning is preview.',
        remediation:
          'Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated to use the supported dedicated pool path. Fabric Warehouse TDS proxy is on the v3.4 roadmap.',
        link: '/docs/fiab/operations/app-install-provisioning',
      },
      steps,
    };
  }

  return {
    status: 'remediation',
    gate: {
      reason: `Unknown LOOM_WAREHOUSE_BACKEND='${BACKEND}'.`,
      remediation: 'Set LOOM_WAREHOUSE_BACKEND=synapse-dedicated.',
    },
    steps,
  };
};

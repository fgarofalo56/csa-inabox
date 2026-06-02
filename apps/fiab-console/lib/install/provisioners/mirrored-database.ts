/**
 * Phase 2 — Mirrored Database (Fabric) provisioner.
 *
 * Closes the Direct-Lake-Replacement gap where the legacy SQL source was
 * never replicated to Bronze. This creates a REAL Fabric Mirrored Database
 * item from the bundle's MirroredDatabaseContent and starts replication so
 * the source tables continuously land in OneLake as Delta — the Bronze
 * layer the Silver/Gold notebooks read from.
 *
 * Real REST (grounded in Microsoft Learn):
 *   POST /v1/workspaces/{ws}/mirroredDatabases  with a Base64 `mirroring.json`
 *        definition part  (createMirroredDatabase in fabric-client)
 *   POST /v1/workspaces/{ws}/mirroredDatabases/{id}/startMirroring
 *        (startMirroredDatabase) to begin the change feed.
 *   POST .../getMirroringStatus to report the live replication state.
 *
 * Docs:
 *   https://learn.microsoft.com/fabric/mirroring/mirrored-database-rest-api#create-mirrored-database
 *   https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/mirrored-database-definition
 *
 * mirroring.json shape (per the definition reference):
 *   {
 *     properties: {
 *       source: { type: <SourceType>, typeProperties: { connection, database } },
 *       target: { type: 'MountedRelationalDatabase',
 *                 typeProperties: { defaultSchema, format: 'Delta' } },
 *       mountedTables: [ { source: { typeProperties: { schemaName, tableName } } } ]
 *     }
 *   }
 *
 * Honest gates (per .claude/rules/no-vaporware.md):
 *   - No bound Fabric workspace               → bind workspace.
 *   - No source connection GUID configured    → the admin must create a
 *       Fabric data-source connection to the legacy SQL server and expose
 *       its GUID via LOOM_MIRROR_SOURCE_CONNECTION_ID (a per-source secret;
 *       Fabric mirroring REST requires a connection id, it cannot mint one
 *       from a raw server FQDN). The item is still created on retry once set.
 *   - 401/403 from Fabric                     → UAMI not Contributor.
 *
 * Idempotency: if a mirrored database with the same displayName already
 * exists, reuse it and (re)issue startMirroring rather than duplicating.
 */
import {
  listMirroredDatabases,
  createMirroredDatabase,
  startMirroredDatabase,
  getMirroringStatus,
  FabricError,
  fabricHint,
} from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';

/** Map the bundle's MirroredDatabaseContent.source.kind to a Fabric SourceType. */
function fabricSourceType(kind: string | undefined): string {
  switch (kind) {
    case 'azure-sql':
      return 'AzureSqlDatabase';
    case 'snowflake':
      return 'Snowflake';
    case 'cosmos':
      return 'CosmosDb';
    case 'bigquery':
      // BigQuery is not a first-class Fabric mirroring source type; surface
      // as GenericMirror so the create is honest rather than inventing one.
      return 'GenericMirror';
    default:
      return 'AzureSqlDatabase';
  }
}

/**
 * Build the Base64 mirroring.json definition. `mountedTables` is derived
 * from the bundle's `source.tables` (each `schema.table` or bare `table`).
 * `defaultSchema:true` preserves the source schema hierarchy in OneLake.
 */
function buildMirroringDefinition(
  content: any,
  connectionId: string,
): { parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const src = content?.source || {};
  const tables: string[] = Array.isArray(src.tables) ? src.tables : [];
  const mountedTables = tables.map((t) => {
    const parts = String(t).split('.');
    const schemaName = parts.length > 1 ? parts[0] : 'dbo';
    const tableName = parts.length > 1 ? parts.slice(1).join('.') : parts[0];
    return { source: { typeProperties: { schemaName, tableName } } };
  });

  const mirroring = {
    properties: {
      source: {
        type: fabricSourceType(src.kind),
        typeProperties: {
          connection: connectionId,
          // database is omitted for AzureSqlDatabase per the REST contract
          // (the connection already carries the db), but included for source
          // types that require it (Snowflake / Cosmos).
          ...(src.database && fabricSourceType(src.kind) !== 'AzureSqlDatabase'
            ? { database: src.database }
            : {}),
        },
      },
      target: {
        type: 'MountedRelationalDatabase',
        typeProperties: { defaultSchema: 'dbo', format: 'Delta' },
      },
      ...(mountedTables.length ? { mountedTables } : {}),
    },
  };

  const payload = Buffer.from(JSON.stringify(mirroring), 'utf-8').toString('base64');
  return { parts: [{ path: 'mirroring.json', payload, payloadType: 'InlineBase64' }] };
}

export const mirroredDatabaseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No bound Fabric workspace for this Loom workspace.',
        remediation:
          'Bind a Fabric workspace via /admin/workspaces > Bind capacity, OR set LOOM_DEFAULT_FABRIC_WORKSPACE.',
        link: '/admin/workspaces',
      },
      steps,
    };
  }
  steps.push(`Fabric workspace: ${ws}`);

  const content = input.content as any;
  const connectionId = process.env.LOOM_MIRROR_SOURCE_CONNECTION_ID;
  if (!connectionId) {
    // Honest infra-gate: Fabric mirroring REST requires a pre-created
    // data-source connection GUID — it cannot be derived from a server FQDN.
    return {
      status: 'remediation',
      gate: {
        reason:
          'Legacy SQL source is not connected to Fabric yet, so Bronze cannot be replicated.',
        remediation:
          'A Fabric admin must (1) create a data-source connection to the legacy SQL server ' +
          `(${content?.source?.server || 'the source server'} / db ${content?.source?.database || ''}), ` +
          '(2) enable the source server\'s System-Assigned Managed Identity and grant it Read/Write ' +
          'on the mirrored database, then (3) expose the connection GUID via the ' +
          'LOOM_MIRROR_SOURCE_CONNECTION_ID environment variable. Re-run install to create + start mirroring.',
        link: 'https://learn.microsoft.com/fabric/mirroring/mirrored-database-rest-api#create-mirrored-database',
      },
      steps,
    };
  }

  const definition = buildMirroringDefinition(content, connectionId);
  steps.push(
    `Built mirroring.json (${(content?.source?.tables?.length || 0)} mounted table(s), source ${fabricSourceType(content?.source?.kind)}).`,
  );

  try {
    // Idempotency: reuse an existing mirrored DB with the same displayName.
    const existing = await listMirroredDatabases(ws);
    const match = existing.find(
      (m) => (m.displayName || '').toLowerCase() === input.displayName.toLowerCase(),
    );

    let mirrorId = match?.id;
    let baseStatus: ProvisionResult['status'] = 'exists';
    if (mirrorId) {
      steps.push(`Found existing mirrored database ${mirrorId}; reusing.`);
    } else {
      const created = await createMirroredDatabase(ws, {
        displayName: input.displayName,
        description: `Installed from ${input.appId}`,
        definition,
      });
      mirrorId = (created as any)?.id;
      // create can return 202 (long-running) without an inline id — resolve
      // it from the workspace listing so we can still start mirroring.
      if (!mirrorId) {
        const after = await listMirroredDatabases(ws);
        mirrorId = after.find(
          (m) => (m.displayName || '').toLowerCase() === input.displayName.toLowerCase(),
        )?.id;
      }
      steps.push(`Created mirrored database ${mirrorId || '(id pending — long-running create)'}.`);
      baseStatus = 'created';
    }

    if (!mirrorId) {
      steps.push('Mirrored database id not yet resolvable; start-mirroring deferred to next pass.');
      return { status: baseStatus, secondaryIds: { fabricWorkspaceId: ws }, steps };
    }

    // Start the change feed so Bronze actually fills.
    try {
      await startMirroredDatabase(ws, mirrorId);
      steps.push('startMirroring accepted (replication initializing).');
    } catch (e: any) {
      if (e instanceof FabricError && (e.status === 400 || e.status === 409)) {
        // Already running / already started — idempotent, not an error.
        steps.push(`startMirroring: ${e.message} (treated as already-started).`);
      } else {
        throw e;
      }
    }

    // Best-effort: surface the live replication status in the receipt.
    let mirroringStatus: string | undefined;
    try {
      const st = await getMirroringStatus(ws, mirrorId);
      mirroringStatus = st?.status;
      if (mirroringStatus) steps.push(`Mirroring status: ${mirroringStatus}.`);
    } catch {
      /* status not yet queryable immediately after start — fine. */
    }

    const secondaryIds: Record<string, string> = { fabricWorkspaceId: ws };
    if (mirroringStatus) secondaryIds.mirroringStatus = mirroringStatus;
    return { status: baseStatus, resourceId: mirrorId, secondaryIds, steps };
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Fabric ${e.status}: ${e.message}`,
          remediation:
            fabricHint(e.status) ||
            'The Console UAMI must be added to this Fabric workspace as a Contributor and the source ' +
              'server\'s managed identity must have Read/Write on the mirrored database.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }
};

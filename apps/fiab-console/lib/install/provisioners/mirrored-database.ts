/**
 * Phase 2 — Mirrored Database provisioner.
 *
 * Per .claude/rules/no-fabric-dependency.md a Loom mirrored database NEVER
 * requires a real Fabric workspace. It defaults to the Azure-native **ADF CDC /
 * copy** backend: a real Azure Data Factory pipeline copies the source tables
 * into the ADLS Gen2 **Bronze** layer as Parquet — the same Bronze the
 * Silver/Gold notebooks read — using the factory's managed identity for both
 * the source (Azure SQL) and the sink (ADLS). A Fabric Mirrored Database is an
 * opt-in alternative selected via LOOM_MIRROR_BACKEND=fabric + a bound
 * workspace; if fabric is selected but no workspace is bound, we transparently
 * fall back to ADF CDC — no Fabric gate.
 *
 * Honest Azure gates (not Fabric gates):
 *   - ADF workspace env vars unset (adfConfigGate)  → set LOOM_ADF_*.
 *   - ADLS Bronze account unset                     → set LOOM_ADLS_ACCOUNT.
 *   - source server/database missing on the bundle  → fix the mirror config.
 * The factory MI must be granted db_datareader on the source + Storage Blob
 * Data Contributor on the ADLS account — surfaced as a precise note.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database
 *   https://learn.microsoft.com/azure/data-factory/connector-azure-data-lake-storage
 */
import {
  adfConfigGate,
  upsertLinkedService,
  upsertDataset,
  upsertPipeline,
  runPipeline,
  getDefaultFactory,
} from '@/lib/azure/adf-client';
import { resolveAbfssRoot } from '@/lib/azure/adls-client';
import { armBase, armScope, dfsUrl } from '@/lib/azure/cloud-endpoints';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { deterministicAssignmentGuid, grantScriptFor } from '@/lib/azure/role-grant-client';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  listMirroredDatabases,
  createMirroredDatabase,
  startMirroredDatabase,
  getMirroringStatus,
  FabricError,
  fabricHint,
} from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
// #3511 — the source-catalog enumerator the mirror already uses at RUN time
// (mirror-engine.ts:1219) and on the per-item tables route; install-time
// discovery calls the same one, against the same catalog.
import { listTablesWithAuth } from '@/lib/azure/sql-objects-client';
// #4315 — and it must truncate with the same cap. Calling the same client is
// NOT enough to make the two agree: discovery records its result to
// `secondaryIds.discoveredTables` and never to `content.source.tables`, so
// mirror-engine.ts:1215 finds `src.tables` empty on every Run, re-enumerates,
// and re-slices to MAX_TABLES. An install-time cap larger than MAX_TABLES is
// therefore not a harmless superset — above the run cap it is a GUARANTEED
// disagreement: the item would record N tables and author an N-activity
// pipeline while a Run mirrors only MAX_TABLES of them, so the recorded
// provenance overstates what is mirrored. Sharing the constant also means an
// operator who sets LOOM_MIRROR_MAX_TABLES is honoured at install, not only at
// run.
import { MAX_TABLES } from '@/lib/azure/mirror-adf-shared';
import { encodeIdList } from '../secondary-id-list';

/**
 * Upper bound on AUTO-DISCOVERED source tables (#3511, #4315). An explicit list
 * is never truncated — this caps only the set the platform chose for the user,
 * so a 4000-table source cannot silently author a 4000-activity ADF pipeline
 * (ADF has its own per-pipeline activity limit, and a pipeline that large would
 * fail at deploy time rather than at review time). The bound is the RUN-time
 * cap itself, for the reason given on the import above; it is deliberately an
 * alias rather than a second literal, so the two cannot drift apart again.
 * Truncation is REPORTED in the steps and on `secondaryIds.tableSource`, never
 * silent.
 */
const MAX_DISCOVERED_TABLES = MAX_TABLES;

/** ADF object name: letters/digits/_ only, ≤ 260; first char a letter. */
function adfName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!/^[A-Za-z]/.test(n)) n = `t_${n}`;
  return n || 'loom_mirror';
}

function splitTable(t: string): { schema: string; table: string } {
  const parts = String(t).split('.');
  return parts.length > 1
    ? { schema: parts[0], table: parts.slice(1).join('.') }
    : { schema: 'dbo', table: parts[0] };
}

// ── #3512 — the two halves of the run-auth failure are NOT the same kind of gap ─
//
// A Copy run that cannot authenticate needs BOTH of:
//   (a) db_datareader for the factory MI on the CUSTOMER's source SQL server —
//       infrastructure Loom does not own, so Loom cannot self-grant it. That is
//       a legitimate honest gate under auto-bind-by-default.md §Allowed.
//   (b) Storage Blob Data Contributor for the factory MI on LOOM'S OWN Bronze
//       ADLS account — a resource this platform deploys. Asking the operator to
//       grant it is exactly the "remediation the PLATFORM could have taken"
//       auto-bind-by-default.md forbids.
// They used to be one sentence, so (b) rode along with (a) and never got done
// by the platform. Loom now ATTEMPTS (b) itself and only gates on what is left.
//
// Storage Blob Data Contributor — built-in, same GUID in every cloud. Kept
// literal here (as `attached-service-kinds.ts` does) rather than imported, so
// this file does not take a dependency on the brownfield-attach kind catalog
// for a single constant.
const STORAGE_BLOB_DATA_CONTRIBUTOR = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const ROLE_ASSIGNMENTS_API = '2022-04-01';

/**
 * The Bronze storage account's ARM scope, resolved the SAME way
 * `adls-client.resolveAccountScope` does (LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG +
 * the account name) so the two cannot disagree about which account Bronze is.
 * Null when the coordinates are not set — the caller then falls back to naming
 * the grant rather than pretending it attempted one.
 */
function bronzeAccountScope(adlsAccount: string): string | null {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_DLZ_RG;
  if (!sub || !rg || !adlsAccount) return null;
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${adlsAccount}`;
}

type BronzeGrantOutcome =
  /** The role assignment exists now — either this PUT created it or it was already there. */
  | { state: 'granted'; scope: string; detail: string }
  /** Loom could not perform the grant. `detail` says only what was established. */
  | { state: 'not-granted'; scope: string | null; detail: string; grantScript?: string };

/**
 * Grant the DATA FACTORY's managed identity Storage Blob Data Contributor on
 * Loom's Bronze account, via ARM `PUT …/roleAssignments/{guid}`. The assignment
 * name is the shared deterministic hash of scope+role+principal, so re-running
 * an install re-PUTs the same object instead of accumulating duplicates.
 *
 * Never throws: every failure becomes a `not-granted` outcome carrying the exact
 * `az role assignment create` the operator would run. Per deploy-integrity.md R7
 * each detail states what was OBSERVED — "ARM refused the role assignment", "the
 * factory reports no managed identity" — and never infers a cause it did not see.
 */
async function grantFactoryBronzeAccess(
  adlsAccount: string,
  steps: string[],
): Promise<BronzeGrantOutcome> {
  const scope = bronzeAccountScope(adlsAccount);
  if (!scope) {
    return {
      state: 'not-granted',
      scope: null,
      detail:
        'Loom could not resolve the Bronze storage account\'s ARM id (LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG are required alongside the account name), so it did not attempt the grant.',
    };
  }

  let principalId: string | undefined;
  try {
    // `getDefaultFactory` returns the raw ARM body; `identity.principalId` is
    // present whenever the factory has a system-assigned MI, which is the
    // identity both linked services above authenticate with.
    const factory = (await getDefaultFactory()) as any;
    principalId = factory?.identity?.principalId;
  } catch (e: any) {
    return {
      state: 'not-granted',
      scope,
      detail: `Loom could not read the data factory to find its managed identity, so it did not attempt the grant: ${e?.message || String(e)}`,
      grantScript: grantScriptFor(STORAGE_BLOB_DATA_CONTRIBUTOR, null, scope),
    };
  }
  if (!principalId) {
    return {
      state: 'not-granted',
      scope,
      detail:
        'The data factory reports no system-assigned managed identity, so there is no principal to grant Bronze access to. Enable the factory\'s system-assigned identity (platform/fiab/bicep deploys it that way) and re-run.',
      grantScript: grantScriptFor(STORAGE_BLOB_DATA_CONTRIBUTOR, null, scope),
    };
  }

  const assignmentGuid = deterministicAssignmentGuid(scope, STORAGE_BLOB_DATA_CONTRIBUTOR, principalId);
  const sub = /\/subscriptions\/([^/]+)/i.exec(scope)?.[1];
  const roleDefinitionId = `/subscriptions/${sub}/providers/Microsoft.Authorization/roleDefinitions/${STORAGE_BLOB_DATA_CONTRIBUTOR}`;
  const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentGuid}?api-version=${ROLE_ASSIGNMENTS_API}`;

  let token: string | undefined;
  try {
    token = (await uamiArmCredential().getToken(armScope()))?.token;
  } catch (e: any) {
    return {
      state: 'not-granted', scope,
      detail: `Loom could not acquire an ARM token to perform the grant: ${e?.message || String(e)}`,
      grantScript: grantScriptFor(STORAGE_BLOB_DATA_CONTRIBUTOR, principalId, scope),
    };
  }
  if (!token) {
    return {
      state: 'not-granted', scope,
      detail: 'Loom could not acquire an ARM token to perform the grant.',
      grantScript: grantScriptFor(STORAGE_BLOB_DATA_CONTRIBUTOR, principalId, scope),
    };
  }

  try {
    // fetchWithTimeout, not a bare fetch. This is an ARM PUT on the INSTALL path:
    // with no timeout a hung control-plane call blocks the provisioner
    // indefinitely and the item never finishes creating, which is exactly the
    // hazard `scripts/no-bare-server-fetch.mjs` exists to catch — it failed the
    // required `next build (node 20)` lane on this line.
    //
    // The precedent this was modelled on, lib/azure/role-grant-client.ts, takes
    // `fetchImpl: typeof fetch = fetch` for injection; this copy had taken
    // neither the injection nor the ceiling.
    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: { roleDefinitionId, principalId, principalType: 'ServicePrincipal' },
      }),
      cache: 'no-store',
    });
    if (res.ok) {
      steps.push(`Granted the data factory's managed identity "Storage Blob Data Contributor" on ${adlsAccount} (Loom's own Bronze account).`);
      return { state: 'granted', scope, detail: `Loom granted the grant itself at ${scope}.` };
    }
    const body: any = await res.json().catch(() => ({}));
    const code: string = body?.error?.code || body?.code || '';
    const message: string = body?.error?.message || body?.message || `HTTP ${res.status}`;
    if (res.status === 409 || /RoleAssignmentExists/i.test(code) || /already exists/i.test(message)) {
      steps.push(`The data factory's managed identity already holds "Storage Blob Data Contributor" on ${adlsAccount}.`);
      return { state: 'granted', scope, detail: `The assignment already existed at ${scope}.` };
    }
    return {
      state: 'not-granted', scope,
      // The observed fact is the ARM refusal; the most common cause is that the
      // Console UAMI lacks Microsoft.Authorization/roleAssignments/write at this
      // scope, and that is offered as the thing to CHECK, not asserted as fact.
      detail: `ARM refused the role assignment (HTTP ${res.status}${code ? ` ${code}` : ''}): ${message}. Check whether the Console UAMI holds Microsoft.Authorization/roleAssignments/write at that scope — User Access Administrator or Owner on the Bronze account.`,
      grantScript: grantScriptFor(STORAGE_BLOB_DATA_CONTRIBUTOR, principalId, scope),
    };
  } catch (e: any) {
    return {
      state: 'not-granted', scope,
      detail: `The role-assignment request did not complete: ${e?.message || String(e)}`,
      grantScript: grantScriptFor(STORAGE_BLOB_DATA_CONTRIBUTOR, principalId, scope),
    };
  }
}

// ── Azure-native DEFAULT: ADF CDC / copy → ADLS Bronze ──────────────────────
async function provisionAdfCdc(input: any, steps: string[]): Promise<ProvisionResult> {
  const gate = adfConfigGate();
  if (gate) {
    return {
      status: 'remediation',
      gate: {
        gateId: 'svc-adf',
        reason: 'Azure Data Factory is not configured for this deployment.',
        remediation: `Set ${gate.missing} (ADF-specific spellings LOOM_ADF_SUB / LOOM_ADF_RG / LOOM_ADF_NAME, else the platform-wide LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG) so the mirror can author the Bronze copy pipeline. No Microsoft Fabric required.`,
        link: 'https://learn.microsoft.com/azure/data-factory/quickstart-create-data-factory',
      },
      steps,
    };
  }

  const content = input.content as any;
  const src = content?.source || {};
  const server = String(src.server || '').trim();
  const database = String(src.database || '').trim();
  const tables: string[] = Array.isArray(src.tables) ? src.tables : [];
  const adlsAccount = input.target.adlsAccount || process.env.LOOM_ADLS_ACCOUNT;
  const bronzeContainer = process.env.LOOM_BRONZE_CONTAINER || input.target.adlsContainer || 'bronze';

  if (!server || !database) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Mirror source server / database is not set.',
        remediation: 'Set the source server FQDN + database on the mirrored-database item (the create wizard captures these). Then re-run install.',
        link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database',
      },
      steps,
    };
  }
  if (!adlsAccount) {
    return {
      status: 'remediation',
      gate: {
        gateId: 'svc-adls',
        reason: 'No ADLS Gen2 account configured for the Bronze sink.',
        remediation: 'Set LOOM_ADLS_ACCOUNT (and optionally LOOM_BRONZE_CONTAINER, default "bronze") so the copy pipeline can land the source tables as Bronze Parquet. No Microsoft Fabric required.',
        link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-data-lake-storage',
      },
      steps,
    };
  }

  const base = adfName(input.displayName);
  const srcLs = `${base}_src_sql`;
  const sinkLs = `${base}_sink_adls`;
  const pipelineName = `${base}_to_bronze`;

  try {
    // 1. Source linked service — Azure SQL via the factory's managed identity.
    await upsertLinkedService(srcLs, {
      name: srcLs,
      properties: {
        type: 'AzureSqlDatabase',
        typeProperties: {
          server,
          database,
          authenticationType: 'SystemAssignedManagedIdentity',
        },
      },
    } as any);
    steps.push(`Linked service '${srcLs}' → ${server}/${database} (factory MI auth).`);

    // 2. Sink linked service — ADLS Gen2 via the factory's managed identity.
    //    The DFS host comes from `dfsUrl()` (cloud-endpoints.ts), never a
    //    literal. This line used to hard-code the Commercial DFS host, so every
    //    GCC-High / IL5 / DoD mirror bound to a hostname that does not resolve in
    //    those boundaries and the Copy activity failed at run time on an estate
    //    whose lake was fine (cloud-parity.md).
    await upsertLinkedService(sinkLs, {
      name: sinkLs,
      properties: {
        type: 'AzureBlobFS',
        typeProperties: { url: dfsUrl(adlsAccount) },
      },
    } as any);
    steps.push(`Linked service '${sinkLs}' → ${dfsUrl(adlsAccount)} (factory MI auth).`);

    // 3. One source+sink dataset + copy activity per mounted table.
    //
    // #3511 — AUTO-DISCOVER the source tables rather than requiring a
    // hand-typed list.
    //
    // Until this change the list came from `content.source.tables` and nothing
    // else: an empty list became the single wildcard `dbo.*`, the loop below
    // SKIPPED every wildcard, `activities` stayed empty, and the item ended on
    // the gate "No explicit source tables to copy to Bronze." So the terminal
    // state of a mirror created without a table list was a form asking the user
    // to type the catalog of a database Loom is already connected to — exactly
    // the user-performed plumbing `auto-bind-by-default.md` forbids, since the
    // platform can read `sys.tables` itself over the connection it just built.
    //
    // The wildcard is now a SCHEMA FILTER instead of a skip: `dbo.*` means
    // "every table in dbo", `*.*` (or an empty list, which keeps the historical
    // `dbo.*` default) means what it says. Explicit entries still win outright —
    // discovery runs ONLY when nothing explicit was named, so an author who
    // listed three tables still gets exactly three.
    const explicitTables = tables.filter((t) => !String(t).endsWith('.*'));
    const wildcards = (tables.length ? tables : ['dbo.*']).filter((t) => String(t).endsWith('.*'));
    let useTables = explicitTables;
    let discovered: string[] = [];
    let discoveryError: string | null = null;
    let discoveryTruncated = false;
    if (useTables.length === 0 && wildcards.length > 0) {
      // `*.*` (schema part `*`) means every schema; anything else is a filter.
      const wantSchemas = new Set(
        wildcards
          .map((w) => splitTable(w).schema.trim().toLowerCase())
          .filter((s) => s && s !== '*'),
      );
      try {
        const rows = await listTablesWithAuth(server, database, src.auth);
        const matched = rows
          .filter((r) => wantSchemas.size === 0 || wantSchemas.has(String(r.schema).toLowerCase()))
          .map((r) => `${r.schema}.${r.name}`);
        discoveryTruncated = matched.length > MAX_DISCOVERED_TABLES;
        discovered = matched.slice(0, MAX_DISCOVERED_TABLES);
        useTables = discovered;
        steps.push(
          `Discovered ${matched.length} table(s) in ${server}/${database}` +
          `${wantSchemas.size ? ` matching schema(s) ${[...wantSchemas].join(', ')}` : ' (all user schemas)'}` +
          ` from the SQL catalog — no hand-typed list required.` +
          (discoveryTruncated ? ` Mirroring the first ${MAX_DISCOVERED_TABLES}; list tables explicitly on the item to choose a different set.` : ''),
        );
      } catch (e: any) {
        // R7 — record WHAT WAS PROBED and the verbatim error. This block does
        // not know whether the catalog is empty or unreachable, so it does not
        // say; the gate below reports the probe failure as a probe failure.
        discoveryError = e?.message || String(e);
        steps.push(`Source table discovery against ${server}/${database} did not complete: ${discoveryError}`);
      }
    }
    const activities: any[] = [];
    let made = 0;
    for (const t of useTables) {
      if (t.endsWith('.*')) {
        steps.push(`Skipped wildcard '${t}' — list explicit tables on the mirror to copy them to Bronze.`);
        continue;
      }
      const { schema, table } = splitTable(t);
      const srcDs = adfName(`${base}_s_${schema}_${table}`);
      const sinkDs = adfName(`${base}_k_${schema}_${table}`);
      await upsertDataset(srcDs, {
        name: srcDs,
        properties: {
          type: 'AzureSqlTable',
          linkedServiceName: { referenceName: srcLs, type: 'LinkedServiceReference' },
          schema: [],
          typeProperties: { schema, table },
        },
      } as any);
      await upsertDataset(sinkDs, {
        name: sinkDs,
        properties: {
          type: 'Parquet',
          linkedServiceName: { referenceName: sinkLs, type: 'LinkedServiceReference' },
          typeProperties: {
            location: {
              type: 'AzureBlobFSLocation',
              fileSystem: bronzeContainer,
              folderPath: `${database}/${schema}/${table}`,
            },
          },
        },
      } as any);
      activities.push({
        name: adfName(`Copy_${schema}_${table}`),
        type: 'Copy',
        inputs: [{ referenceName: srcDs, type: 'DatasetReference' }],
        outputs: [{ referenceName: sinkDs, type: 'DatasetReference' }],
        typeProperties: {
          source: { type: 'AzureSqlSource' },
          sink: { type: 'ParquetSink', storeSettings: { type: 'AzureBlobFSWriteSettings' } },
          enableStaging: false,
        },
      });
      made += 1;
    }

    if (activities.length === 0) {
      // #3511 — the gate survives ONLY for the cases discovery cannot resolve,
      // and it now says which one it is instead of blaming the user's list.
      if (discoveryError) {
        return {
          status: 'remediation',
          gate: {
            reason:
              `Could not read the source table catalog of ${server}/${database} as the Console managed identity, so there is nothing to copy to Bronze yet. ` +
              `The probe failed with: ${discoveryError}`,
            remediation:
              `Grant the Console managed identity db_datareader on ${server}/${database} so Loom can enumerate the source tables itself:\n` +
              `  CREATE USER [<console-uami-name>] FROM EXTERNAL PROVIDER;\n` +
              `  ALTER ROLE db_datareader ADD MEMBER [<console-uami-name>];\n` +
              `Then re-run the install. If the source is reachable only from a private network, confirm the Console can reach ${server} first. Listing the source tables (schema.table) explicitly on the mirrored-database item also unblocks it without the grant.`,
            link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database',
          },
          steps,
        };
      }
      const probed = wildcards.length ? wildcards.join(', ') : 'dbo.*';
      return {
        status: 'remediation',
        gate: {
          reason:
            `The source catalog of ${server}/${database} was read successfully and returned no user tables matching ${probed}, ` +
            `so the Bronze copy pipeline would have no activities.`,
          remediation:
            `Create the source tables in ${database}, widen the mirror's scope (use '*.*' to mirror every schema), or list the source tables (schema.table) explicitly on the mirrored-database item. Then re-run the install.`,
          link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database',
        },
        steps,
      };
    }

    // 4. The Bronze-copy pipeline.
    await upsertPipeline(pipelineName, {
      name: pipelineName,
      properties: { activities, annotations: ['loom-mirror', input.appId] },
    } as any);
    steps.push(`Created ADF pipeline '${pipelineName}' with ${made} table copy activit${made === 1 ? 'y' : 'ies'} → ${adlsAccount}/${bronzeContainer}.`);

    // 5. Prove it's real — trigger an on-demand run (settle, don't block).
    let runId: string | undefined;
    try {
      const run = await runPipeline(pipelineName);
      runId = run.runId;
      steps.push(`Triggered Bronze copy run ${runId}.`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      // Auth-to-source/sink failures are an Azure RBAC gate, not a hard failure.
      if (/managed identity|login failed|not authorized|forbidden|permission|AADSTS|cannot open server/i.test(msg)) {
        // #3512 — DO LOOM'S HALF FIRST, THEN GATE ONLY ON WHAT IS LEFT.
        //
        // This error does not say WHICH side refused, and nothing here can make
        // it say so, so no claim is made about that (deploy-integrity.md R7).
        // What IS known is that one of the two required grants is on Loom's own
        // Bronze account, and the platform can make that one itself. It does,
        // then retries the run ONCE. Whatever remains after that is genuinely
        // outside Loom's control and is what the gate names.
        const bronze = await grantFactoryBronzeAccess(adlsAccount, steps);

        if (bronze.state === 'granted') {
          try {
            const retry = await runPipeline(pipelineName);
            steps.push(`Re-triggered the Bronze copy after granting the factory MI access to ${adlsAccount}: run ${retry.runId}.`);
            const okIds: Record<string, string> = {
              backend: 'adf-cdc', pipeline: pipelineName,
              bronze: `${adlsAccount}/${bronzeContainer}`, lastRunId: retry.runId,
              bronzeGrant: 'auto',
            };
            const okRoot = resolveAbfssRoot('bronze', `mirrors/${input.workspaceId}/${input.cosmosItemId}`);
            if (okRoot) okIds.adlsRoot = okRoot;
            return { status: 'created', resourceId: pipelineName, secondaryIds: okIds, steps };
          } catch (e2: any) {
            const msg2 = e2?.message || String(e2);
            if (!/managed identity|login failed|not authorized|forbidden|permission|AADSTS|cannot open server/i.test(msg2)) {
              steps.push(`Bronze access granted; on-demand run deferred (${msg2}).`);
              // Fall through to the normal `created` return below.
              runId = undefined;
            } else {
              // The Loom-side half is done and the run still cannot
              // authenticate. The remaining requirement is on the CUSTOMER's
              // source server, which Loom does not own and cannot self-grant —
              // the one legitimate honest gate here. Stated with its caveat: a
              // fresh role assignment can take a few minutes to take effect, so
              // the retry alone does not prove the source is the blocker.
              return {
                status: 'remediation',
                resourceId: pipelineName,
                secondaryIds: { backend: 'adf-cdc', pipeline: pipelineName, bronzeGrant: 'auto' },
                gate: {
                  reason: `Bronze copy pipeline created. Loom granted the factory's managed identity access to its own Bronze account (${adlsAccount}); the run still could not authenticate.`,
                  remediation:
                    `Grant the Data Factory's managed identity db_datareader on ${server}/${database} — Loom cannot do this one, because that server is not a resource this platform owns:\n` +
                    `  CREATE USER [<factory-name>] FROM EXTERNAL PROVIDER;\n` +
                    `  ALTER ROLE db_datareader ADD MEMBER [<factory-name>];\n` +
                    `Then re-run the install. Note that the Bronze role assignment above was created moments ago and Azure RBAC can take a few minutes to take effect, so a retry may also succeed on its own. Underlying error: ${msg2}`,
                  link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database#managed-identity',
                },
                steps,
              };
            }
          }
        } else {
          // Loom tried and could not. That is a DEPLOY-TIME gap on Loom's own
          // resource, reported as such and separately from the customer-side
          // one, with the exact command for each.
          return {
            status: 'remediation',
            resourceId: pipelineName,
            secondaryIds: { backend: 'adf-cdc', pipeline: pipelineName, bronzeGrant: 'failed' },
            gate: {
              reason: 'Bronze copy pipeline created, but its run could not authenticate, and Loom could not grant its own Bronze account access on your behalf.',
              remediation:
                `TWO SEPARATE GRANTS ARE NEEDED, and only one of them is yours to make.\n` +
                `1. LOOM-SIDE (this is a Loom deploy defect, not your configuration): the Data Factory's managed identity needs "Storage Blob Data Contributor" on ${adlsAccount}. Loom attempted this automatically and could not — ${bronze.detail}` +
                (bronze.grantScript ? `\n   Unblock it with: ${bronze.grantScript}` : '') +
                `\n2. SOURCE-SIDE (Loom cannot do this one — the server is not a resource this platform owns): grant the same identity db_datareader on ${server}/${database}:\n` +
                `   CREATE USER [<factory-name>] FROM EXTERNAL PROVIDER;\n` +
                `   ALTER ROLE db_datareader ADD MEMBER [<factory-name>];\n` +
                `Then re-run the install. Underlying run error: ${msg}`,
              link: 'https://learn.microsoft.com/azure/data-factory/connector-azure-sql-database#managed-identity',
            },
            steps,
          };
        }
      } else {
        steps.push(`Pipeline created; on-demand run deferred (${msg}).`);
      }
    }

    const secondaryIds: Record<string, string> = { backend: 'adf-cdc', pipeline: pipelineName, bronze: `${adlsAccount}/${bronzeContainer}` };
    // #3511 / auto-bind §2 — when the table list was DISCOVERED rather than
    // supplied, record exactly which tables the platform chose so the mapping
    // is inspectable on the item instead of being a name nobody can account for.
    if (discovered.length) {
      secondaryIds.discoveredTables = encodeIdList(discovered);
      secondaryIds.tableSource = discoveryTruncated ? 'auto-discovered-truncated' : 'auto-discovered';
    }
    if (runId) secondaryIds.lastRunId = runId;
    // Publish the abfss Bronze root for THIS mirror so the install engine's
    // pairing rule (registry.ts) can auto-create a paired
    // synapse-serverless-sql-pool over it. The mirror engine lands each table's
    // CSV under `mirrors/<workspaceId>/<mirrorId>/<schema>.<table>/`, so the
    // mirror root is `<bronze>/mirrors/<workspaceId>/<mirrorId>`. resolveAbfssRoot
    // derives the DFS host from LOOM_BRONZE_URL → sovereign-cloud-correct with
    // no hard-coded domain: dfs.core.windows.net vs dfs.core.usgovcloudapi.net.  cloud-endpoint-literal-ok: per-cloud truth table, not a wired-in host
    // Null (LOOM_BRONZE_URL unset) simply skips pairing — honest, no gate.
    const mirrorRoot = resolveAbfssRoot('bronze', `mirrors/${input.workspaceId}/${input.cosmosItemId}`);
    if (mirrorRoot) secondaryIds.adlsRoot = mirrorRoot;
    return { status: 'created', resourceId: pipelineName, secondaryIds, steps };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/401|403|not authorized|forbidden|permission/i.test(msg)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Azure Data Factory authoring not authorized: ${msg}`,
          remediation: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the "Data Factory Contributor" role on the factory so it can author linked services / datasets / pipelines.',
          link: 'https://learn.microsoft.com/azure/data-factory/concepts-roles-permissions',
        },
        steps,
      };
    }
    return resolveInfraResidual(msg, 'Confirm the ADF factory (LOOM_ADF_NAME / LOOM_DLZ_RG) exists and grant the Console UAMI the "Data Factory Contributor" role on it so it can author linked services / datasets / pipelines.', { link: 'https://learn.microsoft.com/azure/data-factory/concepts-roles-permissions', steps });
  }
}

/** Map the bundle's source.kind to a Fabric SourceType (opt-in path only). */
function fabricSourceType(kind: string | undefined): string {
  switch (kind) {
    case 'azure-sql': return 'AzureSqlDatabase';
    case 'snowflake': return 'Snowflake';
    case 'cosmos': return 'CosmosDb';
    // BigQuery + Oracle integrate into Fabric via open mirroring partners
    // (Google BigQuery preview / Oracle GoldenGate), so the opt-in Fabric path
    // models them as GenericMirror. The Azure-native DEFAULT (ADF copy → Bronze)
    // never reaches this function — it is the no-Fabric path below.
    case 'bigquery': return 'GenericMirror';
    case 'oracle': return 'GenericMirror';
    default: return 'AzureSqlDatabase';
  }
}

function buildMirroringDefinition(content: any, connectionId: string): { parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const src = content?.source || {};
  const tables: string[] = Array.isArray(src.tables) ? src.tables : [];
  const mountedTables = tables.map((t) => {
    const { schema, table } = splitTable(t);
    return { source: { typeProperties: { schemaName: schema, tableName: table } } };
  });
  const isSnowflake = fabricSourceType(src.kind) === 'Snowflake';
  const mirroring = {
    properties: {
      source: {
        type: fabricSourceType(src.kind),
        typeProperties: {
          connection: connectionId,
          ...(src.database && fabricSourceType(src.kind) !== 'AzureSqlDatabase' ? { database: src.database } : {}),
          // Snowflake-only (Fabric Build 2026): include Snowflake-managed Iceberg tables.
          ...(isSnowflake && src.includeIcebergTables ? { includeIcebergTables: true } : {}),
        },
      },
      target: { type: 'MountedRelationalDatabase', typeProperties: { defaultSchema: 'dbo', format: 'Delta' } },
      ...(mountedTables.length ? { mountedTables } : {}),
    },
  };
  return { parts: [{ path: 'mirroring.json', payload: Buffer.from(JSON.stringify(mirroring), 'utf-8').toString('base64'), payloadType: 'InlineBase64' }] };
}

// ── Fabric Mirroring backend (opt-in: LOOM_MIRROR_BACKEND=fabric + bound ws) ─
async function provisionFabricMirror(input: any, steps: string[], ws: string): Promise<ProvisionResult> {
  steps.push(`Fabric workspace: ${ws}`);
  const content = input.content as any;
  const connectionId = process.env.LOOM_MIRROR_SOURCE_CONNECTION_ID;
  if (!connectionId) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Fabric mirroring requires a pre-created data-source connection GUID.',
        remediation: 'Create a Fabric data-source connection to the source server and set LOOM_MIRROR_SOURCE_CONNECTION_ID — or use the Azure-native ADF CDC backend (LOOM_MIRROR_BACKEND=adf-cdc, the default).',
        link: 'https://learn.microsoft.com/fabric/mirroring/mirrored-database-rest-api#create-mirrored-database',
      },
      steps,
    };
  }
  const definition = buildMirroringDefinition(content, connectionId);
  steps.push(`Built mirroring.json (${(content?.source?.tables?.length || 0)} mounted table(s), source ${fabricSourceType(content?.source?.kind)}).`);
  try {
    const existing = await listMirroredDatabases(ws);
    const match = existing.find((m) => (m.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    let mirrorId = match?.id;
    let baseStatus: ProvisionResult['status'] = 'exists';
    if (mirrorId) {
      steps.push(`Found existing mirrored database ${mirrorId}; reusing.`);
    } else {
      const created = await createMirroredDatabase(ws, { displayName: input.displayName, description: `Installed from ${input.appId}`, definition });
      mirrorId = (created as any)?.id;
      if (!mirrorId) {
        const after = await listMirroredDatabases(ws);
        mirrorId = after.find((m) => (m.displayName || '').toLowerCase() === input.displayName.toLowerCase())?.id;
      }
      steps.push(`Created mirrored database ${mirrorId || '(id pending — long-running create)'}.`);
      baseStatus = 'created';
    }
    if (!mirrorId) {
      steps.push('Mirrored database id not yet resolvable; start-mirroring deferred to next pass.');
      return { status: baseStatus, secondaryIds: { backend: 'fabric', fabricWorkspaceId: ws }, steps };
    }
    try {
      await startMirroredDatabase(ws, mirrorId);
      steps.push('startMirroring accepted (replication initializing).');
    } catch (e: any) {
      if (e instanceof FabricError && (e.status === 400 || e.status === 409)) {
        steps.push(`startMirroring: ${e.message} (treated as already-started).`);
      } else { throw e; }
    }
    let mirroringStatus: string | undefined;
    try { const st = await getMirroringStatus(ws, mirrorId); mirroringStatus = st?.status; if (mirroringStatus) steps.push(`Mirroring status: ${mirroringStatus}.`); } catch { /* not yet queryable */ }
    const secondaryIds: Record<string, string> = { backend: 'fabric', fabricWorkspaceId: ws };
    if (mirroringStatus) secondaryIds.mirroringStatus = mirroringStatus;
    return { status: baseStatus, resourceId: mirrorId, secondaryIds, steps };
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: { reason: `Fabric ${e.status}: ${e.message}`, remediation: fabricHint(e.status) || 'Add the Console UAMI to this Fabric workspace as a Contributor.', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
        steps,
      };
    }
    return resolveInfraResidual(e, fabricHint((e as any)?.status) || 'Add the Console UAMI to this Fabric workspace as a Contributor (and bind it to a capacity) so it can create + start the mirrored database.', { link: `https://app.fabric.microsoft.com/groups/${ws}/settings`, steps });
  }
}

export const mirroredDatabaseProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.mirrorBackend || 'adf-cdc';

  if (backend === 'fabric' && ws) {
    steps.push('Provisioning mirror on the Fabric Mirroring backend (opt-in).');
    return provisionFabricMirror(input, steps, ws);
  }
  if (backend === 'fabric' && !ws) {
    steps.push('LOOM_MIRROR_BACKEND=fabric but no Fabric workspace bound — falling back to the Azure-native ADF CDC backend.');
  } else {
    steps.push('Provisioning mirror on the Azure-native ADF CDC → ADLS Bronze backend.');
  }
  return provisionAdfCdc(input, steps);
};

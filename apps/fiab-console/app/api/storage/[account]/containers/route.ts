/**
 * GET /api/storage/[account]/containers
 * ---------------------------------------------------------------------------
 * The containers (filesystems) of an ARBITRARY ADLS Gen2 / blob storage
 * account — the half of ADLS browsing that did not exist.
 *
 * `lib/azure/adls-client.ts` has taken an optional `account` argument on
 * `listPaths(container, prefix, max, account?)` since the Lakehouse shortcut
 * work, so paths under any account the Console identity can read were already
 * reachable. Nothing enumerated that account's CONTAINERS: `listContainers()`
 * probes the four DLZ containers named by LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL
 * and nothing else, and `/api/lakehouse/paths` rejects any container outside
 * KNOWN_CONTAINERS. So a user picking a storage location outside the DLZ had no
 * way to see what was in it, which is why every such surface asks them to TYPE
 * an `abfss://…` URI (scripts/ci/check-no-freeform.mjs counts 33 of those).
 *
 * Sibling: GET /api/storage/[account]/containers/[container]/paths.
 *
 * Auth: the caller must be signed in (withSession). The listing itself runs as
 * the Console identity — the same identity `listPaths` has always used for
 * external accounts — so a 403 from storage is surfaced VERBATIM with the exact
 * role to grant, never swallowed into an empty list (no-vaporware.md).
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { getServiceClientFor } from '@/lib/azure/adls-client';
import { dfsUrl } from '@/lib/azure/cloud-endpoints';
import { isValidStorageAccount } from '../../_lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export interface StorageContainerRow {
  name: string;
  /** The https data-plane URL of the container (sovereign-suffix correct). */
  url: string;
  lastModified?: string;
}

/** Containers listed before the answer is reported partial. */
const MAX_CONTAINERS = 500;

export const GET = withSession<{ account: string }>(async (_req: NextRequest, { params }) => {
  const account = (params.account || '').trim().toLowerCase();
  if (!isValidStorageAccount(account)) {
    return apiError(
      `'${account.slice(0, 40)}' is not a valid storage account name (3-24 lower-case letters and digits).`,
      400,
      { code: 'bad_request' },
    );
  }

  const base = dfsUrl(account).replace(/\/$/, '');
  let svc: ReturnType<typeof getServiceClientFor>;
  try {
    svc = getServiceClientFor(account);
  } catch (e: any) {
    return apiError(`Could not build a data-lake client for '${account}': ${String(e?.message || e).slice(0, 200)}`, 502, {
      code: 'client_error',
    });
  }

  const containers: StorageContainerRow[] = [];
  try {
    for await (const fs of svc.listFileSystems()) {
      if (!fs.name) continue;
      containers.push({
        name: fs.name,
        url: `${base}/${fs.name}`,
        lastModified: fs.properties?.lastModified ? new Date(fs.properties.lastModified).toISOString() : undefined,
      });
      if (containers.length >= MAX_CONTAINERS) break;
    }
  } catch (e: any) {
    const status = Number(e?.statusCode || e?.status || 0);
    // R7 — say what was actually established. A 403 is a missing grant and we
    // name it; anything else is reported as "could not list", not as "empty".
    if (status === 403) {
      return apiError(
        `Storage denied the listing of containers on '${account}'. Grant the Loom Console identity ` +
          '(LOOM_UAMI_CLIENT_ID) the "Storage Blob Data Reader" role on that storage account — ' +
          'account-scope is required to ENUMERATE containers; a container-scope grant can read inside one ' +
          'but cannot list them.',
        403,
        { code: 'forbidden', account },
      );
    }
    if (status === 404) {
      return apiError(`Storage account '${account}' was not found at ${base}.`, 404, { code: 'not_found', account });
    }
    return apiError(
      `Could not list containers on '${account}': ${String(e?.message || e).slice(0, 300)}`,
      502,
      { code: 'list_failed', account },
    );
  }

  containers.sort((a, b) => a.name.localeCompare(b.name));
  return apiOk({
    account,
    host: new URL(base).host,
    containers,
    ...(containers.length >= MAX_CONTAINERS ? { truncated: true } : {}),
  });
});

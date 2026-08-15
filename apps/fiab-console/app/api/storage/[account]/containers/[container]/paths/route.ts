/**
 * GET /api/storage/[account]/containers/[container]/paths?prefix=&maxResults=
 * ---------------------------------------------------------------------------
 * A flat directory listing INSIDE an arbitrary storage account's container —
 * the second half of the ADLS browse path, and the reason the container-list
 * sibling is not a dead end.
 *
 * `/api/lakehouse/paths` serves the same shape but only for the four DLZ
 * containers (`KNOWN_CONTAINERS`) on the account parsed out of
 * LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL, and it takes no `account` parameter.
 * `adls-client.listPaths(container, prefix, max, account?)` has always accepted
 * one; this route is the missing BFF surface over it, so a picker can walk any
 * account the Console identity can read instead of asking a user to compose an
 * `abfss://` URI by hand.
 *
 * Auth: withSession. A storage 403 is surfaced verbatim with the exact role to
 * grant (no-vaporware.md); it is never turned into an empty folder.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { listPaths, type PathEntry } from '@/lib/azure/adls-client';
import { isValidStorageAccount, isValidContainerName, isSafePrefix } from '../../../../_lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const GET = withSession<{ account: string; container: string }>(
  async (req: NextRequest, { params }) => {
    const account = (params.account || '').trim().toLowerCase();
    const container = (params.container || '').trim().toLowerCase();
    const prefix = req.nextUrl.searchParams.get('prefix') || '';
    const maxResults = Math.min(Number(req.nextUrl.searchParams.get('maxResults') || '200') || 200, 1000);

    if (!isValidStorageAccount(account)) {
      return apiError(`'${account.slice(0, 40)}' is not a valid storage account name.`, 400, { code: 'bad_request' });
    }
    if (!isValidContainerName(container)) {
      return apiError(`'${container.slice(0, 70)}' is not a valid container name.`, 400, { code: 'bad_request' });
    }
    if (!isSafePrefix(prefix)) {
      return apiError('The `prefix` must be a path inside the container (no scheme, no `..`, no query).', 400, {
        code: 'bad_request',
      });
    }

    let paths: PathEntry[];
    try {
      paths = await listPaths(container, prefix, maxResults, account);
    } catch (e: any) {
      const status = Number(e?.statusCode || e?.status || 0);
      if (status === 403) {
        return apiError(
          `Storage denied the listing of '${container}' on '${account}'. Grant the Loom Console identity ` +
            '(LOOM_UAMI_CLIENT_ID) the "Storage Blob Data Reader" role on that container or storage account.',
          403,
          { code: 'forbidden', account, container },
        );
      }
      if (status === 404) {
        return apiError(`Container '${container}' was not found on '${account}'.`, 404, {
          code: 'not_found',
          account,
          container,
        });
      }
      return apiError(
        `Could not list '${container}' on '${account}': ${String(e?.message || e).slice(0, 300)}`,
        502,
        { code: 'list_failed', account, container },
      );
    }

    return apiOk({
      account,
      container,
      prefix,
      paths,
      ...(paths.length >= maxResults ? { truncated: true } : {}),
    });
  },
);

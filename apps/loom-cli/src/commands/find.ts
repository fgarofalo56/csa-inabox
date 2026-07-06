/**
 * `loom find <query>` — estate-wide catalog search.
 *
 * Calls GET /api/catalog/find (the same endpoint the Console search UI uses,
 * backed by the shared searchCatalog library) with the stored session cookie,
 * and prints ranked item hits from every workspace the caller can access —
 * owned AND shared. Text is matched against name, item type, description, and
 * tags. Azure-native by default; no Microsoft Fabric tenant required.
 *
 *   loom find "bronze"                     Search everything for "bronze".
 *   loom find sales --type lakehouse       Restrict to lakehouses.
 *   loom find --all --limit 100            Browse the 100 most-recent items.
 */
import { requireAuth, CliError } from './context.js';
import type { GlobalOptions } from '../config.js';
import { flagStr, flagBool, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';

interface FindHit {
  id: string;
  workspaceId: string;
  workspaceName: string;
  itemType: string;
  displayName: string;
  description?: string;
  tags: string[];
  updatedAt?: string;
  url: string;
  score: number;
}

interface FindResponse {
  ok: boolean;
  q: string;
  backend: 'ai-search' | 'cosmos';
  total: number;
  workspacesSearched: number;
  hits: FindHit[];
}

const FIND_COLUMNS = ['itemType', 'displayName', 'workspaceName', 'id'];

export async function runFind(args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  // Everything after `find` (minus flags) is the query — support multi-word.
  const query = args.positionals.join(' ').trim() || flagStr(args.flags, 'query') || '';
  const browseAll = flagBool(args.flags, 'all');
  if (!query && !browseAll) {
    throw new CliError('Usage: loom find <query> [--type <itemType>] [--limit N]   (or --all to browse recent items)');
  }

  const { client, output } = await requireAuth(opts);

  const params = new URLSearchParams();
  params.set('q', query);
  const type = flagStr(args.flags, 'type');
  if (type) params.set('type', type);
  const limit = flagStr(args.flags, 'limit');
  if (limit) params.set('limit', limit);

  const res = await client.request<FindResponse>('GET', `/api/catalog/find?${params.toString()}`);

  if (output === 'table') {
    if (!res.hits.length) {
      process.stdout.write(
        `No items found${query ? ` for "${query}"` : ''} across ${res.workspacesSearched} accessible workspace(s).\n`,
      );
      return;
    }
    printResult(res.hits, 'table', FIND_COLUMNS);
    process.stdout.write(
      `\n${res.total} result(s) across ${res.workspacesSearched} workspace(s) (backend: ${res.backend}).\n`,
    );
    return;
  }
  // json / yaml — hand back the full envelope (backend + counts + hits).
  printResult(res, output);
}

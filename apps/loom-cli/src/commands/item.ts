/**
 * `loom item` — list | create | show | update | delete | types.
 *
 * list/create scope to a workspace (GET/POST /api/workspaces/:id/items).
 * show/update/delete use the generic typed CRUD (/api/cosmos-items/:type/:id).
 * `--type` is validated against the real item taxonomy (item-types.ts).
 *
 * Every item type is Azure-native by default — no Microsoft Fabric tenant
 * required (.claude/rules/no-fabric-dependency.md).
 */
import { requireAuth, CliError } from './context.js';
import type { GlobalOptions } from '../config.js';
import { flagStr, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';
import { ITEM_TYPES, isKnownItemType, suggestItemTypes } from '../item-types.js';

interface Item {
  id: string;
  workspaceId: string;
  itemType: string;
  displayName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

const ITEM_COLUMNS = ['id', 'itemType', 'displayName', 'description', 'createdAt'];

export async function runItem(sub: string, args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  // `types` needs no auth — it lists the local taxonomy.
  if (sub === 'types') {
    const out = (opts.output || process.env.LOOM_OUTPUT || 'table').toLowerCase();
    if (out === 'json') printResult(ITEM_TYPES, 'json');
    else if (out === 'yaml') printResult(ITEM_TYPES, 'yaml');
    else printResult(ITEM_TYPES.map((t) => ({ itemType: t })), 'table', ['itemType']);
    return;
  }

  const { client, output } = await requireAuth(opts);

  switch (sub) {
    case 'list': {
      const wsId = args.positionals[0];
      if (!wsId) throw new CliError('Usage: loom item list <workspaceId>');
      const items = await client.request<Item[]>('GET', `/api/workspaces/${encodeURIComponent(wsId)}/items`);
      printResult(items, output, ITEM_COLUMNS);
      return;
    }
    case 'create': {
      const wsId = args.positionals[0];
      const itemType = flagStr(args.flags, 'type');
      const displayName = flagStr(args.flags, 'name') || args.positionals[1];
      if (!wsId || !itemType || !displayName) {
        throw new CliError('Usage: loom item create <workspaceId> --type <itemType> --name <displayName> [--description]');
      }
      assertItemType(itemType);
      const item = await client.request<Item>('POST', `/api/workspaces/${encodeURIComponent(wsId)}/items`, {
        itemType,
        displayName,
        description: flagStr(args.flags, 'description'),
      });
      printResult(item, output);
      return;
    }
    case 'show': {
      const [type, id] = args.positionals;
      if (!type || !id) throw new CliError('Usage: loom item show <type> <id>');
      assertItemType(type);
      const item = await client.request<Item>('GET', `/api/cosmos-items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
      printResult(item, output);
      return;
    }
    case 'update': {
      const [type, id] = args.positionals;
      if (!type || !id) throw new CliError('Usage: loom item update <type> <id> [--name --description]');
      assertItemType(type);
      const patch: Record<string, string> = {};
      const name = flagStr(args.flags, 'name');
      const description = flagStr(args.flags, 'description');
      if (name !== undefined) patch.displayName = name;
      if (description !== undefined) patch.description = description;
      if (Object.keys(patch).length === 0) {
        throw new CliError('Nothing to update. Provide --name and/or --description.');
      }
      const item = await client.request<Item>('PATCH', `/api/cosmos-items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, patch);
      printResult(item, output);
      return;
    }
    case 'delete': {
      const [type, id] = args.positionals;
      if (!type || !id) throw new CliError('Usage: loom item delete <type> <id>');
      assertItemType(type);
      await client.request('DELETE', `/api/cosmos-items/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
      printResult({ ok: true, deleted: id, itemType: type }, output);
      return;
    }
    default:
      throw new CliError(`Unknown item subcommand "${sub}". Use: list | create | show | update | delete | types`);
  }
}

function assertItemType(t: string): void {
  if (isKnownItemType(t)) return;
  throw new CliError(
    `Unknown item type "${t}". Did you mean: ${suggestItemTypes(t).join(', ')}? ` +
      'Run `loom item types` for the full list.',
  );
}

/**
 * `loom workspace` — list | show | create | update | delete | bulk-delete.
 * Maps 1:1 to lib/api/workspaces.ts (the same verbs the Console UI uses).
 *
 * Backend: Cosmos-backed BFF routes under /api/workspaces. Azure-native by
 * default — `--capacity` / `--domain` are optional (Fabric is opt-in only;
 * never required). No api.fabric.microsoft.com / api.powerbi.com is ever hit.
 */
import { requireAuth, CliError } from './context.js';
import type { GlobalOptions } from '../config.js';
import { flagBool, flagStr, type ParsedArgs } from '../args.js';
import { printResult } from '../output.js';

interface Workspace {
  id: string;
  name: string;
  description?: string;
  capacity?: string;
  domain?: string;
  itemCount?: number;
  createdAt: string;
  updatedAt: string;
}

const WS_COLUMNS = ['id', 'name', 'capacity', 'domain', 'itemCount', 'createdAt'];

export async function runWorkspace(sub: string, args: ParsedArgs, opts: GlobalOptions): Promise<void> {
  const { client, output } = await requireAuth(opts);
  const id = args.positionals[0];

  switch (sub) {
    case 'list': {
      const count = flagBool(args.flags, 'count');
      const data = await client.request<Workspace[]>('GET', `/api/workspaces${count ? '?count=true' : ''}`);
      printResult(data, output, count ? WS_COLUMNS : WS_COLUMNS.filter((c) => c !== 'itemCount'));
      return;
    }
    case 'show': {
      if (!id) throw new CliError('Usage: loom workspace show <id>');
      const ws = await client.request<Workspace>('GET', `/api/workspaces/${encodeURIComponent(id)}`);
      printResult(ws, output);
      return;
    }
    case 'create': {
      const name = id || flagStr(args.flags, 'name');
      if (!name) throw new CliError('Usage: loom workspace create <name> [--description --capacity --domain]');
      const ws = await client.request<Workspace>('POST', '/api/workspaces', {
        name,
        description: flagStr(args.flags, 'description'),
        capacity: flagStr(args.flags, 'capacity'),
        domain: flagStr(args.flags, 'domain'),
      });
      printResult(ws, output);
      return;
    }
    case 'update': {
      if (!id) throw new CliError('Usage: loom workspace update <id> [--name --description --capacity --domain]');
      const patch: Record<string, string> = {};
      for (const k of ['name', 'description', 'capacity', 'domain'] as const) {
        const v = flagStr(args.flags, k);
        if (v !== undefined) patch[k] = v;
      }
      if (Object.keys(patch).length === 0) {
        throw new CliError('Nothing to update. Provide at least one of --name --description --capacity --domain.');
      }
      const ws = await client.request<Workspace>('PATCH', `/api/workspaces/${encodeURIComponent(id)}`, patch);
      printResult(ws, output);
      return;
    }
    case 'delete': {
      if (!id) throw new CliError('Usage: loom workspace delete <id>');
      await client.request('DELETE', `/api/workspaces/${encodeURIComponent(id)}`);
      printResult({ ok: true, deleted: id }, output);
      return;
    }
    case 'bulk-delete': {
      const ids = args.positionals;
      if (ids.length === 0) throw new CliError('Usage: loom workspace bulk-delete <id> [<id> ...]');
      const result = await client.request('POST', '/api/workspaces/bulk-delete', { ids });
      printResult(result, output);
      return;
    }
    default:
      throw new CliError(`Unknown workspace subcommand "${sub}". Use: list | show | create | update | delete | bulk-delete`);
  }
}

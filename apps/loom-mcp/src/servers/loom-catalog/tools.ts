/**
 * M1 `loom-catalog` tools — the read-only foundation (PRP §4.2). Every tool
 * calls the Loom SDK (never raw REST), is marked `readOnly`, requires at most a
 * `read-only` scope, and returns metadata only. None mutates; none exposes data
 * rows, secrets, or connection strings (the core scrub is the backstop).
 *
 * | tool                   | SDK call                          | endpoint (via SDK)                 |
 * |------------------------|-----------------------------------|------------------------------------|
 * | loom.catalog.find      | client.catalog.search(q, opts)    | GET /api/catalog/search            |
 * | loom.item.get          | client.items.get(type, id)        | GET /api/cosmos-items/{type}/{id}  |
 * | loom.workspaces.list   | client.workspaces.list({count})   | GET /api/workspaces                |
 * | loom.item.list         | client.items.list(workspaceId)    | GET /api/workspaces/{id}/items     |
 */
import { z } from 'zod';
import type { Item } from '@csa-loom/sdk';
import type { ToolSpec } from '../../core/types.js';

/** The four M1 tools. Pure data — the caller's SDK client comes from `ctx.auth`. */
export function catalogTools(): ToolSpec[] {
  return [
    {
      name: 'loom.catalog.find',
      title: 'Search the Loom catalog',
      description:
        'Federated catalog search across Purview, Unity Catalog, and OneLake. Returns matching items ' +
        '(name, type, workspace, owner) — metadata only, no data rows. Pass an empty query to browse recent items.',
      inputSchema: {
        query: z.string().describe('Search text. Empty string browses recent items.'),
        source: z
          .string()
          .optional()
          .describe('Optional source filter: purview | unity-catalog | onelake (comma-separated for several).'),
        limit: z.number().int().min(1).max(100).optional().describe('Per-source result cap (max 100).'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const query = (args.query as string | undefined) ?? '';
        const source = args.source as string | undefined;
        const limit = args.limit as number | undefined;
        const res = await auth.client.catalog.search(query, { source, limit });
        return { data: res, count: res.hits?.length };
      },
    },
    {
      name: 'loom.item.get',
      title: 'Get a Loom item',
      description:
        'Fetch one item by type and id (its name, description, workspace, timestamps, and non-secret state). ' +
        'Returns metadata only. The item type is validated against the Loom taxonomy.',
      inputSchema: {
        type: z.string().describe('Item type, e.g. lakehouse, warehouse, notebook, data-pipeline.'),
        id: z.string().describe('Item id (GUID).'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const item = await auth.client.items.get(args.type as string, args.id as string);
        return { data: item };
      },
    },
    {
      name: 'loom.workspaces.list',
      title: 'List Loom workspaces',
      description:
        'List every workspace the caller can access (id, name, description, domain). Optionally include the ' +
        'item count per workspace. Scoped to the caller by the Loom BFF ACL.',
      inputSchema: {
        count: z.boolean().optional().describe('Include per-workspace item counts.'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const ws = await auth.client.workspaces.list({ count: args.count as boolean | undefined });
        return { data: ws, count: ws.length };
      },
    },
    {
      name: 'loom.item.list',
      title: 'List items in a workspace',
      description:
        'List the items in a workspace, optionally filtered to a single item type. Returns metadata only ' +
        '(id, type, display name, description, timestamps).',
      inputSchema: {
        workspaceId: z.string().describe('Workspace id (GUID).'),
        type: z.string().optional().describe('Optional item-type filter, e.g. lakehouse.'),
      },
      readOnly: true,
      minScope: 'read-only',
      async run({ auth, args }) {
        const all: Item[] = await auth.client.items.list(args.workspaceId as string);
        const type = args.type as string | undefined;
        const items = type ? all.filter((i) => i.itemType === type) : all;
        return { data: items, count: items.length };
      },
    },
  ];
}

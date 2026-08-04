/**
 * M3 `loom-author` tools — the WRITE surface (PRP §4.2, §5.1). Creates and
 * modifies Loom items. Every tool is `readOnly:false`, requires `read-write`
 * scope, and is **dry-run by default**: an `apply` argument (default `false`)
 * makes the tool return the PLANNED change WITHOUT calling the mutating
 * endpoint; only `apply:true` performs the real SDK write. This mirrors
 * `loom policy apply --yes` (plan-then-apply) and PRP §5.1 "`confirm` argument
 * required to leave dry-run".
 *
 * Never deletes, never provisions — that blast radius lives in M4/M5.
 *
 * | tool                          | SDK call                                   | endpoint (via SDK)                       |
 * |-------------------------------|--------------------------------------------|------------------------------------------|
 * | loom.item.create             | items.createByType(type, input)            | POST  /api/cosmos-items/{type}           |
 * | loom.item.update             | items.update(type, id, patch)              | PATCH /api/cosmos-items/{type}/{id}      |
 * | loom.item.definition.update  | items.update(type, id, { state })          | PATCH /api/cosmos-items/{type}/{id}      |
 *
 * `loom.item.definition.update` targets the SAME generic Cosmos route as
 * `update`, but replaces the item's `state` — the definition surface. In Loom an
 * item's definition IS its `state` (the per-type `/definition` routes are
 * sanitizing front-ends that ultimately persist to `state`), so this is the
 * uniform, Azure-native, all-types definition-write, with no Fabric/Power BI
 * workspace required (`no-fabric-dependency.md`).
 */
import { z } from 'zod';
import type { ToolSpec } from '../../core/types.js';

/** `apply` arg shared by every mutating tool. Absent/false ⇒ dry-run (no write). */
const applyArg = z
  .boolean()
  .optional()
  .describe('Execute the change. Default false = DRY-RUN: returns the plan WITHOUT writing. Set true to apply.');

/** True only when `apply === true` — anything else (undefined/false/truthy) stays a dry-run. */
function shouldApply(args: Record<string, unknown>): boolean {
  return args.apply === true;
}

/** The three M3 write tools. The caller's SDK client comes from `ctx.auth`. */
export function authorTools(): ToolSpec[] {
  return [
    {
      name: 'loom.item.create',
      title: 'Create a Loom item',
      description:
        'Create a new item of the given type in a workspace (POST /api/cosmos-items/{type}). ' +
        'DRY-RUN by default — returns the planned create without writing; pass apply:true to create. ' +
        'Azure-native; no Fabric workspace required.',
      inputSchema: {
        type: z.string().describe('Item type, e.g. lakehouse, warehouse, notebook, data-pipeline.'),
        workspaceId: z.string().describe('Target workspace id (GUID). The caller must have write access.'),
        displayName: z.string().min(1).describe('Display name for the new item.'),
        description: z.string().optional().describe('Optional description.'),
        state: z.record(z.unknown()).optional().describe('Optional initial definition/state (structured object).'),
        apply: applyArg,
      },
      readOnly: false,
      minScope: 'read-write',
      async run({ auth, args }) {
        const type = args.type as string;
        const input = {
          workspaceId: args.workspaceId as string,
          displayName: args.displayName as string,
          description: args.description as string | undefined,
          state: args.state as Record<string, unknown> | undefined,
        };
        const plan = { action: 'create', method: 'POST', endpoint: `/api/cosmos-items/${type}`, body: input };
        if (!shouldApply(args)) {
          return {
            data: { mode: 'dry-run', wouldMutate: true, plan, note: 'Re-invoke with apply:true to execute this create.' },
            audit: { mutation: 'planned', target: `${type}:${input.displayName}` },
          };
        }
        const item = await auth.client.items.createByType(type, input);
        return {
          data: { mode: 'applied', action: 'create', item },
          audit: { mutation: 'applied', target: `${type}:${item.id}` },
        };
      },
    },
    {
      name: 'loom.item.update',
      title: 'Update a Loom item',
      description:
        "Update an item's name / description / state (PATCH /api/cosmos-items/{type}/{id}). " +
        'DRY-RUN by default — returns the planned patch without writing; pass apply:true to update. ' +
        'For the full definition surface use loom.item.definition.update.',
      inputSchema: {
        type: z.string().describe('Item type, e.g. lakehouse, notebook.'),
        id: z.string().describe('Item id (GUID).'),
        displayName: z.string().optional().describe('New display name.'),
        description: z.string().optional().describe('New description.'),
        state: z.record(z.unknown()).optional().describe('New state object (replaces the item state).'),
        apply: applyArg,
      },
      readOnly: false,
      minScope: 'read-write',
      async run({ auth, args }) {
        const type = args.type as string;
        const id = args.id as string;
        const patch = {
          displayName: args.displayName as string | undefined,
          description: args.description as string | undefined,
          state: args.state as Record<string, unknown> | undefined,
        };
        const plan = { action: 'update', method: 'PATCH', endpoint: `/api/cosmos-items/${type}/${id}`, body: patch };
        if (!shouldApply(args)) {
          return {
            data: { mode: 'dry-run', wouldMutate: true, plan, note: 'Re-invoke with apply:true to execute this update.' },
            audit: { mutation: 'planned', target: `${type}:${id}` },
          };
        }
        const item = await auth.client.items.update(type, id, patch);
        return {
          data: { mode: 'applied', action: 'update', item },
          audit: { mutation: 'applied', target: `${type}:${id}` },
        };
      },
    },
    {
      name: 'loom.item.definition.update',
      title: "Update a Loom item's definition",
      description:
        "Replace an item's DEFINITION (its structured state) — PATCH /api/cosmos-items/{type}/{id} with { state }. " +
        'DRY-RUN by default — returns the planned definition write without persisting; pass apply:true to save. ' +
        'Uniform across all item types (Azure-native; no Fabric/Power BI workspace required).',
      inputSchema: {
        type: z.string().describe('Item type, e.g. report, notebook, data-pipeline.'),
        id: z.string().describe('Item id (GUID).'),
        definition: z.record(z.unknown()).describe("The full item definition — persisted as the item's state."),
        apply: applyArg,
      },
      readOnly: false,
      minScope: 'read-write',
      async run({ auth, args }) {
        const type = args.type as string;
        const id = args.id as string;
        const definition = args.definition as Record<string, unknown>;
        const patch = { state: definition };
        const plan = {
          action: 'definition.update',
          method: 'PATCH',
          endpoint: `/api/cosmos-items/${type}/${id}`,
          body: { state: definition },
        };
        if (!shouldApply(args)) {
          return {
            data: {
              mode: 'dry-run',
              wouldMutate: true,
              plan,
              note: 'Re-invoke with apply:true to persist this definition.',
            },
            audit: { mutation: 'planned', target: `${type}:${id}` },
          };
        }
        const item = await auth.client.items.update(type, id, patch);
        return {
          data: { mode: 'applied', action: 'definition.update', item },
          audit: { mutation: 'applied', target: `${type}:${id}` },
        };
      },
    },
  ];
}

/**
 * workspace-bundle-io — EXP1 server-side collector/executor for `.loomws`
 * workspace portability bundles.
 *
 * The PURE halves live next door (workspace-export.ts serialize,
 * workspace-import.ts validate/plan); this module is the ONLY place the EXP1
 * feature touches Cosmos:
 *
 *   • collectWorkspaceBundle — real single-partition reads of the workspace's
 *     item docs (FULL state — the export needs content, unlike the list
 *     route's shapeForList projection), folder docs, and permission rows.
 *   • executeWorkspaceImport — persists a planned import: folder creates,
 *     item creates, in-place overwrites (point-read → merge → replace), and
 *     the AI-Search doc upserts every other item write path does.
 *   • auditWorkspacePortability — the audit standard (mirrors
 *     lib/admin/finops-audit): best-effort `_auditLog` Cosmos row + ALWAYS an
 *     `emitAuditEvent` fan-out (SIEM/webhooks) for export / import / clone.
 *
 * Server-only: never import into a client component.
 */

import {
  itemsContainer,
  foldersContainer,
  workspacePermissionsContainer,
  auditLogContainer,
} from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';
import type { Workspace, WorkspaceItem, WorkspaceFolder } from '@/lib/types/workspace';
import { buildWorkspaceBundle, type LoomWsBundle, type WorkspacePermissionRow } from './workspace-export';
import { summarizePlan, type ImportPlan, type ImportSummary } from './workspace-import';

/**
 * Read everything the bundle needs from Cosmos and serialize it. All item /
 * folder / permission queries are single-partition (PK = workspaceId).
 */
export async function collectWorkspaceBundle(
  workspace: Workspace,
  exportedBy: string,
): Promise<LoomWsBundle> {
  const [items, folders, roles] = await Promise.all([
    (async () => {
      const c = await itemsContainer();
      const { resources } = await c.items
        .query<WorkspaceItem>({
          query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.createdAt',
          parameters: [{ name: '@w', value: workspace.id }],
        }, { partitionKey: workspace.id })
        .fetchAll();
      return resources;
    })(),
    (async () => {
      const c = await foldersContainer();
      const { resources } = await c.items
        .query<WorkspaceFolder>({
          query: 'SELECT * FROM c WHERE c.workspaceId = @w ORDER BY c.name',
          parameters: [{ name: '@w', value: workspace.id }],
        })
        .fetchAll();
      return resources;
    })(),
    (async () => {
      const c = await workspacePermissionsContainer();
      const { resources } = await c.items
        .query<WorkspacePermissionRow>({
          query: 'SELECT c.upn, c.role, c.name FROM c WHERE c.workspaceId = @w',
          parameters: [{ name: '@w', value: workspace.id }],
        }, { partitionKey: workspace.id })
        .fetchAll();
      return resources;
    })(),
  ]);
  return buildWorkspaceBundle(workspace, items, folders, roles, { exportedBy });
}

/**
 * Persist a planned import into `target`. Folder creates first (items
 * reference them), then item creates / in-place overwrites. Every item write
 * upserts its AI-Search doc, matching the create/update routes. Individual
 * write failures throw — the route's error path reports them; already-written
 * docs remain (imports are re-runnable: 'skip-existing' makes a retry
 * idempotent).
 */
export async function executeWorkspaceImport(
  plan: ImportPlan,
  target: Workspace,
): Promise<ImportSummary> {
  const folders = await foldersContainer();
  for (const f of plan.foldersToCreate) {
    await folders.items.create(f);
  }
  const items = await itemsContainer();
  for (const planned of plan.items) {
    if (planned.action === 'create' && planned.doc) {
      const { resource } = await items.items.create<WorkspaceItem>(planned.doc);
      if (resource) void upsertLoomDoc(docForItem(resource, target.tenantId));
    } else if (planned.action === 'overwrite' && planned.existingId && planned.overwrite) {
      const handle = items.item(planned.existingId, target.id);
      let existing: WorkspaceItem | undefined;
      try {
        existing = (await handle.read<WorkspaceItem>()).resource;
      } catch (e) {
        if ((e as { code?: number })?.code !== 404) throw e;
      }
      if (!existing) continue; // raced away — nothing to overwrite
      const next: WorkspaceItem = {
        ...existing,
        displayName: planned.overwrite.displayName,
        description: planned.overwrite.description,
        folderId: planned.overwrite.folderId,
        state: planned.overwrite.state,
        updatedAt: planned.overwrite.updatedAt,
      };
      const { resource } = await handle.replace<WorkspaceItem>(next);
      if (resource) void upsertLoomDoc(docForItem(resource, target.tenantId));
    }
  }
  return summarizePlan(plan);
}

// ── Audit (mirrors lib/admin/finops-audit — the audit standard) ────────────

export type PortabilityAction = 'export' | 'import' | 'clone';

export interface PortabilityAuditActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

export interface PortabilityAuditInput {
  action: PortabilityAction;
  workspaceId: string;
  workspaceName: string;
  detail?: Record<string, unknown>;
}

/**
 * Write the `_auditLog` row + emit the SIEM audit event for one portability
 * operation. Best-effort on the Cosmos row (the operation is never blocked by
 * an audit hiccup, matching setRuntimeFlag / auditFinopsMutation) but ALWAYS
 * emits the audit event.
 */
export async function auditWorkspacePortability(
  actor: PortabilityAuditActor,
  input: PortabilityAuditInput,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `workspace:${input.workspaceId}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at: now,
        kind: 'workspace.portability',
        action: input.action,
        target: input.workspaceId,
        targetName: input.workspaceName,
        detail: input.detail ?? null,
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: `workspace.${input.action}`,
    targetType: 'workspace',
    targetId: input.workspaceId,
    tenantId: actor.tenantId,
    detail: { workspaceName: input.workspaceName, ...(input.detail ?? {}) },
  });
}

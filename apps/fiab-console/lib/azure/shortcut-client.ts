/**
 * Internal (lakehouse-to-lakehouse) shortcut orchestration — Azure-native
 * parity with Microsoft Fabric OneLake **internal** shortcuts, NO Fabric
 * dependency.
 *
 * This is the thin orchestration layer the item-level BFF routes
 * (`/api/items/[type]/[id]/shortcuts/**`) call. It isolates the live ADLS
 * passthrough validation + status mapping from the route layer and re-uses the
 * existing building blocks rather than duplicating them:
 *   - registry persistence  → lib/azure/lakehouse-shortcuts.ts (Cosmos)
 *   - URI resolve + engine   → lib/azure/shortcut-engines.ts
 *   - ADLS data-plane        → lib/azure/adls-client.ts (Console UAMI)
 *
 * "Internal" shortcuts point at another Loom lakehouse path on the **primary**
 * ADLS Gen2 account (`internal://<container>/<path>`). The UAMI already holds
 * Storage Blob Data Reader on that account, so no extra credential is needed —
 * this works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, per
 * .claude/rules/no-fabric-dependency.md.
 *
 * Per .claude/rules/no-vaporware.md — every call hits a real Azure backend
 * (Cosmos reads/writes + a live ADLS HEAD / listPaths). No mock arrays.
 */

import {
  parseAbfss,
  resolveAndTestAdls,
  createTablesShortcut,
  dropShortcutObject,
  testEngineObject,
  type EngineGate,
} from './shortcut-engines';
import { getMetadata, getAccountName, listPaths } from './adls-client';
import {
  listShortcuts,
  getShortcut,
  createShortcut,
  deleteShortcut,
  updateShortcutStatus,
  type LakehouseShortcut,
  type ShortcutKind,
} from './lakehouse-shortcuts';

/** UI-facing status pill value — derived from the stored ShortcutStatus. */
export type ShortcutDisplayStatus = 'OK' | 'Broken' | 'Pending';

/** Map the registry status to the list grid's status pill. */
export function displayStatus(s: LakehouseShortcut['status']): ShortcutDisplayStatus {
  if (s === 'active') return 'OK';
  if (s === 'error') return 'Broken';
  return 'Pending';
}

function isGate(x: unknown): x is EngineGate {
  return !!x && typeof x === 'object' && (x as EngineGate).gated === true;
}

/** Strip any HTML and collapse whitespace so a firewall/gateway page never leaks raw. */
function sanitize(e: any): string {
  return (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export interface CreateInternalArgs {
  /** Destination Loom lakehouse (Cosmos item id / partition key). */
  lakehouseId: string;
  tenantId?: string;
  name: string;
  kind: ShortcutKind;
  parentPath?: string;
  /** `internal://<container>/<path>` — resolved to the primary ADLS account. */
  targetUri: string;
  format?: LakehouseShortcut['format'];
  createdBy: string;
}

export type CreateInternalResult =
  /** Created + reachable (Files) or registered as a real external table (Tables). */
  | { ok: true; shortcut: LakehouseShortcut }
  /** A Tables shortcut where no query engine is configured — persisted 'pending'. */
  | { ok: false; gate: EngineGate; shortcut: LakehouseShortcut };

/**
 * Create an internal (lakehouse-to-lakehouse) shortcut on ADLS passthrough.
 *
 *  1. Resolve `internal://…` to the primary account + prove the UAMI can read
 *     the target with a real `listPaths` probe (resolveAndTestAdls).
 *  2. For a Tables shortcut, register a real external table on the configured
 *     engine (Synapse Serverless / Databricks UC) — or persist 'pending' + an
 *     honest gate when no engine is set.
 *  3. Upsert the registry row (deterministic id ⇒ re-creating the same shortcut
 *     is an idempotent upsert).
 *
 * Throws the raw ADLS / engine error on a real failure; the route maps it to a
 * precise message + HTTP status.
 */
export async function createInternalShortcut(args: CreateInternalArgs): Promise<CreateInternalResult> {
  // 1. Real UAMI reachability test on the internal target path.
  const resolved = await resolveAndTestAdls('internal', args.targetUri, getAccountName);
  const abfssUri = resolved.abfssUri!;

  // 2. Tables → register a real external table (or honest-gate when no engine).
  let engine: LakehouseShortcut['engine'] = 'none';
  let engineObject: string | undefined;
  if (args.kind === 'tables') {
    const reg = await createTablesShortcut({
      lakehouseId: args.lakehouseId,
      name: args.name,
      abfssUri,
      format: args.format,
    });
    if (isGate(reg)) {
      const pending = await createShortcut({
        lakehouseId: args.lakehouseId,
        tenantId: args.tenantId,
        name: args.name,
        kind: args.kind,
        parentPath: args.parentPath,
        targetType: 'internal',
        targetUri: args.targetUri,
        abfssUri,
        engine: 'none',
        format: args.format,
        status: 'pending',
        statusDetail: reg.hint,
        createdBy: args.createdBy,
      });
      return { ok: false, gate: reg, shortcut: pending };
    }
    engine = reg.engine;
    engineObject = reg.engineObject;
  }

  // 3. Persist the registry row (active — proven reachable above).
  const row = await createShortcut({
    lakehouseId: args.lakehouseId,
    tenantId: args.tenantId,
    name: args.name,
    kind: args.kind,
    parentPath: args.parentPath,
    targetType: 'internal',
    targetUri: args.targetUri,
    abfssUri,
    engine,
    engineObject,
    format: args.format,
    status: 'active',
    createdBy: args.createdBy,
  });
  return { ok: true, shortcut: row };
}

/**
 * Run a live ADLS HEAD (`getProperties`) against an internal shortcut's target
 * path and update its registry status — this powers the "Test" action + the
 * list grid's status pill.
 *
 *   - target path missing (404)   → status='error'  (pill 'Broken')
 *   - access denied (403)         → status='error'  (pill 'Broken')
 *   - reachable                   → status='active' (pill 'OK')
 *
 * For a Tables shortcut we additionally prove the backing engine object still
 * reads with a real `SELECT TOP 1`. Returns the updated row, or `null` when the
 * shortcut id doesn't exist (the route maps that to a 404).
 *
 * Per no-vaporware.md: a real `getMetadata`/`listPaths` call — no mock.
 */
export async function testInternalShortcut(lakehouseId: string, id: string): Promise<LakehouseShortcut | null> {
  const sc = await getShortcut(lakehouseId, id);
  if (!sc) return null;

  const parts = parseAbfss(sc.targetUri, getAccountName);
  if (!parts) {
    return updateShortcutStatus(
      lakehouseId,
      id,
      'error',
      `Target URI is not a valid internal lakehouse path: ${sc.targetUri}`,
    );
  }

  try {
    if (parts.path) {
      // Live ADLS HEAD on the target file/folder.
      const meta = await getMetadata(parts.container, parts.path);
      if (!meta.exists) {
        return updateShortcutStatus(
          lakehouseId,
          id,
          'error',
          'Target path not found (404). The lakehouse folder/table this shortcut points at no longer exists. ' +
            'Re-create the source data or delete this shortcut.',
        );
      }
    } else {
      // Container-root shortcut — HEAD-equivalent reachability probe.
      await listPaths(parts.container, '', 1);
    }

    // Tables shortcut: prove the engine object backing it still reads.
    if (sc.kind === 'tables' && sc.engine && sc.engine !== 'none' && sc.engineObject) {
      await testEngineObject(sc.engine, sc.engineObject);
    }

    return updateShortcutStatus(lakehouseId, id, 'active', undefined);
  } catch (e: any) {
    const msg = sanitize(e);
    const denied = e?.statusCode === 403 || /\b403\b|forbidden|denied|not allowed/i.test(msg);
    const detail = denied
      ? `Access denied (403). Grant the Console UAMI "Storage Blob Data Reader" on the target ` +
        `container, then Test again. (${msg})`
      : `Target not reachable: ${msg}`;
    return updateShortcutStatus(lakehouseId, id, 'error', detail);
  }
}

// Re-export the registry/engine primitives the routes need so a route imports
// from a single module rather than three.
export {
  listShortcuts,
  getShortcut,
  deleteShortcut,
  createShortcut,
  updateShortcutStatus,
  dropShortcutObject,
};
export type { LakehouseShortcut, ShortcutKind };

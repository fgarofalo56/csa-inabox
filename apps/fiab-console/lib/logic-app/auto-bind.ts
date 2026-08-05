/**
 * Auto-bind for Logic Apps — per `.claude/rules/auto-bind-by-default.md`.
 *
 * The platform PROVISIONS AND BINDS the backing Azure object itself. A user who
 * creates a Loom `logic-app` item never sees a "bind a Logic App first" form:
 * on first touch (open, save, run, or run-history) this module ensures a real
 * `Microsoft.Logic/workflows` resource exists, named identically to the Loom
 * item, and stamps the binding into the item's Cosmos state.
 *
 * SELF-HEALING. The binding is re-validated on every call, so all of these
 * recover automatically instead of dead-ending the editor:
 *   - item created in the UI, never installed from a bundle → create + bind
 *   - binding stamped but the workflow was deleted in Azure (ARM 404) → recreate
 *   - binding stamped against a stale subscription/RG (estate moved) → re-target
 *     to the current coordinates and recreate
 *
 * WHAT IS NOT AUTO-HEALED: a genuine Azure-side authorization or configuration
 * problem. Those still surface as an honest gate (`no-vaporware.md`) naming the
 * exact role/env var — because inventing a workflow the caller cannot actually
 * reach would be worse than telling the truth.
 *
 * ── Consumption vs Standard ──────────────────────────────────────────────────
 * We bind **Consumption** (`Microsoft.Logic/workflows`, multitenant). Rationale:
 *   1. It is a single ARM resource with the workflow definition INLINE in
 *      `properties.definition`. Auto-bind can therefore create the backing
 *      object in ONE idempotent PUT with no prerequisites.
 *   2. Standard requires a dedicated App Service plan (Workflow Standard SKU) +
 *      a storage account + a Logic App site *before* any workflow exists, and
 *      its definitions live in the site's file system, edited over a separate
 *      Kudu/`workflow.json` data-plane rather than ARM. That is a multi-resource
 *      standing deployment — it cannot be conjured per item on first open, and
 *      it would put a per-item cost floor on every workflow a user creates,
 *      which the default-ON/opt-out rule forbids.
 *   3. Consumption's ARM surface (`create-or-update`, `triggers/{n}/run`,
 *      `runs`, `runs/{n}/actions`) covers create → edit → save → run → history,
 *      which is exactly the vertical slice this feature must prove.
 * The existing platform bicep already provisions a Consumption workflow and
 * grants the Console UAMI **Logic App Contributor at RESOURCE-GROUP scope**
 * (`platform/fiab/bicep/modules/deploy-planner/logic-app.bicep`), which is what
 * makes creating sibling workflows by name possible day one.
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/logic/workflows/create-or-update
 *   https://learn.microsoft.com/azure/logic-apps/logic-apps-overview#consumption-vs-standard
 */

import type { WorkspaceItem } from '@/lib/types/workspace';
import { armBase } from '@/lib/azure/cloud-endpoints';
import {
  callLogicArm,
  logicAppArmMissing,
  readLogicAppArmConfig,
  LOGIC_API,
} from '@/lib/install/provisioners/logic-app';
import { emptyDefinition, type WdlDefinition } from './wdl-model';

export interface LogicAppBinding {
  subscriptionId: string;
  resourceGroup: string;
  workflowName: string;
}

export interface BindGate {
  /**
   * Which KIND of gate this is, so the UI can pick the right remediation
   * surface (G2, `ux-baseline.md`):
   *   'not-configured' → an ENV gate; renders the shared <HonestGate> with an
   *                      inline Fix-it wizard bound to registry id `svc-logic-apps`.
   *   'not-authorized' → an RBAC grant; a Fix-it env wizard cannot resolve it,
   *                      so it stays an honest MessageBar naming the exact role.
   *   'arm-error'      → Azure rejected the call; surface its own message.
   */
  code: 'not-configured' | 'not-authorized' | 'arm-error';
  reason: string;
  remediation: string;
  link?: string;
  /** For 'not-configured': the env vars the deployment is missing. */
  missing?: string[];
}

/** The registry gate id this module's config gate resolves through.
 *  Defined in its own import-free module so CLIENT components can read it
 *  without dragging this server-only module (and @azure/identity → node:crypto)
 *  into the browser bundle. */
export { LOGIC_APP_GATE_ID } from './gate-id';

export type EnsureBindingResult =
  | { ok: true; binding: LogicAppBinding; created: boolean; definition?: WdlDefinition; statePatch?: Record<string, unknown> }
  | { ok: false; gate: BindGate };

/**
 * Derive the Azure workflow name from the Loom item. Per the auto-bind rule the
 * backing object is **named identically to the Loom item** — we only apply the
 * character restrictions Azure enforces on a workflow name (letters, digits,
 * `-`, `_`, `(`, `)`, `.`; 1-80 chars), and fall back to the item id when a
 * display name sanitizes down to nothing (e.g. a purely non-Latin name).
 */
export function workflowNameForItem(item: Pick<WorkspaceItem, 'id' | 'displayName'>): string {
  const cleaned = (item.displayName || '')
    .replace(/[^A-Za-z0-9\-_().]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  if (cleaned.length > 0) return cleaned;
  // Cosmos ids may carry the synthetic `loom:` prefix — strip it for the name.
  const id = String(item.id || '').replace(/^loom:/, '');
  return `loom-workflow-${id}`.replace(/[^A-Za-z0-9\-_().]/g, '-').slice(0, 80);
}

export function workflowUrlFor(b: LogicAppBinding): string {
  return `${armBase()}/subscriptions/${b.subscriptionId}/resourceGroups/${b.resourceGroup}/providers/Microsoft.Logic/workflows/${encodeURIComponent(b.workflowName)}`;
}

/**
 * Read whatever binding the item already carries. Accepts both the shape the
 * bundle installer stamps (`state.provisioning.secondaryIds`) and the shape
 * this module stamps (`state.logicAppBinding`), plus the legacy
 * `state.logicAppName`.
 */
export function readStoredBinding(state: unknown): Partial<LogicAppBinding> {
  const s = (state || {}) as Record<string, any>;
  const stamped = (s.logicAppBinding || {}) as Partial<LogicAppBinding>;
  const sec = (s.provisioning?.secondaryIds || {}) as Record<string, string>;
  return {
    workflowName: stamped.workflowName || s.logicAppName || sec.workflowName,
    subscriptionId: stamped.subscriptionId || sec.subscriptionId,
    resourceGroup: stamped.resourceGroup || sec.resourceGroup,
  };
}

/** The gate returned when the deployment has no Logic Apps ARM coordinates. */
function configGate(missing: string[]): BindGate {
  return {
    code: 'not-configured',
    missing,
    reason: 'Azure Logic Apps target not configured in this deployment.',
    remediation:
      `Set ${missing.join(', ')} on the Console container app so Loom can create ` +
      'the backing Microsoft.Logic/workflows resource, and grant the Console ' +
      'UAMI the "Logic App Contributor" role on that resource group.',
    link: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-securing-a-logic-app',
  };
}

function authGate(status: number, resourceGroup: string): BindGate {
  return {
    code: 'not-authorized',
    reason: `Azure returned ${status} creating the backing Logic App workflow.`,
    remediation:
      'Grant the Console UAMI the "Logic App Contributor" role on resource ' +
      `group ${resourceGroup} so Loom can create and manage workflows.`,
    link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-contributor',
  };
}

/**
 * Ensure the item has a live, reachable Logic App workflow behind it.
 *
 * @param item     the Loom item (for its name + current state)
 * @param seed     definition to stamp when CREATING the workflow (defaults to
 *                 the item's saved/bundled definition, else an empty workflow)
 *
 * Returns the binding plus a `statePatch` the caller merges into the item's
 * Cosmos state (this module never writes Cosmos itself, so it stays usable from
 * GET/PUT/run without each route double-writing).
 */
export async function ensureLogicAppBinding(
  item: Pick<WorkspaceItem, 'id' | 'displayName' | 'state'>,
  seed?: WdlDefinition | null,
): Promise<EnsureBindingResult> {
  const missing = logicAppArmMissing();
  if (missing.length > 0) return { ok: false, gate: configGate(missing) };

  const cfg = readLogicAppArmConfig();
  const stored = readStoredBinding(item.state);

  // Target coordinates: the CURRENT deployment always wins for sub/RG so an
  // estate move re-targets rather than pointing at a dead subscription. The
  // workflow NAME sticks to whatever was already bound (renaming the Loom item
  // must not orphan a live workflow that may already have run history).
  const binding: LogicAppBinding = {
    subscriptionId: cfg.subscriptionId,
    resourceGroup: cfg.resourceGroup,
    workflowName: stored.workflowName || workflowNameForItem(item),
  };

  const url = workflowUrlFor(binding);

  // 1) Is it already there and reachable?
  try {
    const g = await callLogicArm(`${url}?api-version=${LOGIC_API}`);
    if (g.ok) {
      const wf = await g.json().catch(() => ({} as any));
      const definition = wf?.properties?.definition as WdlDefinition | undefined;
      return {
        ok: true,
        binding,
        created: false,
        definition,
        statePatch: bindingPatch(binding, item.state),
      };
    }
    if (g.status === 401 || g.status === 403) {
      return { ok: false, gate: authGate(g.status, binding.resourceGroup) };
    }
    // 404 → fall through and create (this is the self-heal path).
  } catch {
    /* ARM unreachable on GET — still attempt the create, which reports truthfully. */
  }

  // 2) Create it. Idempotent PUT keyed on name.
  const definition =
    seed && typeof seed === 'object' && Object.keys(seed).length > 0 ? seed : emptyDefinition();
  const body = {
    location: cfg.location,
    tags: { 'loom-managed': 'true', 'loom-item-id': String(item.id).replace(/^loom:/, '').slice(0, 256) },
    properties: { state: 'Enabled', definition },
  };

  try {
    let target = binding;
    let put = await callLogicArm(`${url}?api-version=${LOGIC_API}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    // SELF-HEAL #2: the configured resource group does not exist.
    //
    // Found live: the deployed Console's LOOM_DLZ_RG names an RG that was never
    // created (the estate runs single-RG out of LOOM_ADMIN_RG), so the very
    // first create 404s with ResourceGroupNotFound. Per auto-bind-by-default.md
    // that is the platform's problem to solve, not a message to show the user —
    // retry once against the admin RG, which every deploy creates.
    if (put.status === 404 && cfg.fallbackResourceGroup) {
      const detail = await put.text().catch(() => '');
      if (/ResourceGroupNotFound/i.test(detail)) {
        target = { ...binding, resourceGroup: cfg.fallbackResourceGroup };
        put = await callLogicArm(`${workflowUrlFor(target)}?api-version=${LOGIC_API}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        // Re-wrap so the shared error path below still has the body to report.
        put = { ...put, text: async () => detail, json: async () => ({}) } as unknown as Response;
      }
    }

    if (put.status === 401 || put.status === 403) {
      return { ok: false, gate: authGate(put.status, target.resourceGroup) };
    }
    if (!put.ok && put.status !== 200 && put.status !== 201) {
      const text = await put.text().catch(() => '');
      return {
        ok: false,
        gate: {
          code: 'arm-error',
          reason: `Azure rejected creating the backing workflow (HTTP ${put.status}).`,
          remediation:
            `ARM said: ${text.slice(0, 240) || '(no detail)'} — confirm resource group ` +
            `${target.resourceGroup} exists in subscription ${target.subscriptionId} and that ` +
            'the Console UAMI holds "Logic App Contributor" on it.',
          link: 'https://learn.microsoft.com/rest/api/logic/workflows/create-or-update',
        },
      };
    }
    const created = await put.json().catch(() => ({} as any));
    return {
      ok: true,
      binding: target,
      created: true,
      definition: (created?.properties?.definition as WdlDefinition) || definition,
      statePatch: bindingPatch(target, item.state),
    };
  } catch (e: any) {
    return {
      ok: false,
      gate: {
        code: 'arm-error',
        reason: 'Could not reach Azure Resource Manager to create the backing workflow.',
        remediation: `${e?.message || String(e)} — check the Console's outbound network path to ARM.`,
        link: 'https://learn.microsoft.com/rest/api/logic/workflows/create-or-update',
      },
    };
  }
}

/** Merge the binding into an item's state without disturbing anything else. */
export function bindingPatch(
  binding: LogicAppBinding,
  state: unknown,
): Record<string, unknown> {
  const s = (state || {}) as Record<string, unknown>;
  return {
    ...s,
    logicAppBinding: { ...binding },
    // Keep the legacy field in sync so older readers (the bundle installer's
    // receipt view, the run route's fallback) keep resolving.
    logicAppName: binding.workflowName,
  };
}

/** True when the stored binding already matches what auto-bind would produce. */
export function bindingIsCurrent(state: unknown, binding: LogicAppBinding): boolean {
  const stored = readStoredBinding(state);
  return (
    stored.workflowName === binding.workflowName &&
    stored.subscriptionId === binding.subscriptionId &&
    stored.resourceGroup === binding.resourceGroup
  );
}

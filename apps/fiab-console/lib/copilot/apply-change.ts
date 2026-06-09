/**
 * apply-change — editor-mutation bridge registry.
 *
 * The approval-diff contract: any Copilot tool that proposes a code / query /
 * transform change emits an OrchestratorStep
 *   { kind: 'proposed_change', target, before, after }
 * The CopilotDiff modal renders a real Monaco DiffEditor and gates the
 * mutation behind an explicit **Keep**. ONLY on Keep does the owning editor
 * mutate — never before. On **Undo** the change is discarded and the editor
 * is left byte-for-byte unchanged.
 *
 * This module is the routing layer between "Keep was clicked" and "the editor
 * that owns `target` actually changes". Each editor / pane that owns a mutable
 * surface (notebook cells, SQL editor, KQL editor) registers a bridge keyed by
 * a deterministic `target` string and deregisters it on unmount via the
 * returned cleanup function.
 *
 * Design constraints honored:
 *  - No free-form config (loom-no-freeform-config): bridge keys are
 *    deterministic strings derived from itemId / cellId — never arbitrary,
 *    user-authored JSON paths.
 *  - No Fabric dependency (no-fabric-dependency): bridges call local React
 *    state setters (updateCell / setValue), never a Fabric REST API. Works with
 *    LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *  - No vaporware (no-vaporware): a missing bridge returns false so the caller
 *    can surface an honest "editor no longer open" message rather than silently
 *    dropping the change.
 *
 * Target key convention (deterministic, not user-configurable):
 *   notebook-cell:<cellId>      — a single notebook code cell
 *   query-editor:<itemId>       — a SQL / KQL query editor surface
 */

/** A bridge receives the approved `after` text and mutates its owned editor. */
export type BridgeFn = (after: string) => void;

const _registry = new Map<string, BridgeFn>();

/**
 * Register an editor bridge for `target`. Returns a cleanup function that
 * removes exactly this registration (it will not clobber a newer bridge that
 * replaced it). Call the cleanup from a React `useEffect` return.
 *
 * Re-registering the same key (e.g. when a cell's identity is stable but its
 * closure changed) is allowed and replaces the prior bridge.
 */
export function registerBridge(target: string, fn: BridgeFn): () => void {
  _registry.set(target, fn);
  return () => {
    if (_registry.get(target) === fn) _registry.delete(target);
  };
}

/**
 * Apply an approved change to the editor that owns `target`. Returns true when
 * a bridge was found and invoked, false when no bridge is currently registered
 * (e.g. a stale proposed_change whose editor has since closed). The caller uses
 * false to show a precise warning instead of pretending the change applied.
 *
 * This is the ONLY function that mutates an editor on behalf of a proposed
 * change, and it is only ever called from the CopilotDiff Keep handler — never
 * automatically.
 */
export function applyChange(target: string, after: string): boolean {
  const fn = _registry.get(target);
  if (!fn) return false;
  fn(after);
  return true;
}

/** True when a bridge is currently registered for `target`. */
export function hasBridge(target: string): boolean {
  return _registry.has(target);
}

/** Number of registered bridges. Exposed for tests + diagnostics. */
export function _registrySize(): number {
  return _registry.size;
}

/** Clear all bridges. Test-only helper; not used in product code. */
export function _resetBridges(): void {
  _registry.clear();
}

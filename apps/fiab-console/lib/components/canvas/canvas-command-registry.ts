'use client';

/**
 * canvas-command-registry — a tiny global registry that lets the currently
 * focused canvas expose its actions to the existing global command palette
 * (PRP-surface-max-enhancements W21). The palette (`command-palette.tsx`)
 * subscribes; a canvas host `register()`s its command set on focus and calls the
 * returned dispose fn on blur/unmount, so canvas commands are only searchable
 * while a canvas is active and can never leak between editors.
 *
 * This is a pure module singleton (no React) so it can be imported by both the
 * palette and any host without a provider, and unit-tested directly.
 */

export interface CanvasCommand {
  /** Stable id, e.g. "canvas:undo". */
  id: string;
  /** Palette label, e.g. "Canvas: Undo". */
  label: string;
  /** One-line hint shown under the label. */
  sub: string;
  /** Invoked when the user selects the command. */
  run: () => void;
  /** Optional disabled predicate (e.g. undo with an empty stack). */
  disabled?: () => boolean;
}

type Listener = () => void;

let commands: CanvasCommand[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Register a set of canvas commands. Returns a dispose fn that removes exactly
 * these commands. A host typically calls this in a focus effect and disposes on
 * blur/unmount. Re-registering replaces the prior set for the same host by
 * disposing first.
 */
export function registerCanvasCommands(set: CanvasCommand[]): () => void {
  commands = [...commands, ...set];
  emit();
  return () => {
    const ids = new Set(set.map((c) => c.id));
    commands = commands.filter((c) => !ids.has(c.id));
    emit();
  };
}

/** Current snapshot of registered canvas commands (excludes disabled ones). */
export function getCanvasCommands(): CanvasCommand[] {
  return commands.filter((c) => !c.disabled?.());
}

/** Subscribe to registry changes; returns an unsubscribe fn. */
export function subscribeCanvasCommands(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test-only: clear all registered commands. */
export function __resetCanvasCommands() {
  commands = [];
  emit();
}

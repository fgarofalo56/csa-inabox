'use client';

/**
 * use-copilot-context — cross-tree bridge that lets any editor pane register
 * the Copilot context for the surface the user is currently working in.
 *
 * The right-rail {@link CopilotPane} is mounted in AppShell as a SIBLING of the
 * editor tree (a fixed-position overlay), not a descendant — so a React Context
 * provider would have to wrap the whole shell. Instead we follow the existing
 * cross-tree pattern in this codebase (copilot-pane.tsx `csaloom:open-copilot`
 * / `csaloom:toggle-copilot`, cross-item-copilot-editor.tsx session events):
 * a `window` CustomEvent carries the latest context, the pane subscribes.
 *
 * Editors call {@link registerCopilotContext} on mount + whenever the pane's
 * state changes (e.g. the active SQL text). The pane reads the latest via
 * {@link useCopilotContext} and sends `contextSlug` + `contextPayload` with
 * every orchestrate request — the server composes the persona system prompt
 * from that payload (active query, schema, workspace id).
 *
 * The last-registered context is cached on `window` so the pane picks up the
 * current pane even if it mounts/opens AFTER the editor registered (the
 * CustomEvent itself only reaches already-mounted listeners).
 */

import { useEffect, useState } from 'react';

export interface CopilotContext {
  /** Pane slug — must match a ContextSlug in copilot-personas.ts. */
  slug: string;
  /** Raw editor state the persona system prompt is composed from. */
  payload: Record<string, unknown>;
}

const EVT = 'csaloom:copilot-context';
const DEFAULT_CONTEXT: CopilotContext = { slug: 'default', payload: {} };

interface CopilotContextWindow extends Window {
  __loomCopilotContext?: CopilotContext;
}

/**
 * Register (or update) the current pane's Copilot context. Safe to call on
 * every editor change — it dispatches a CustomEvent the pane listens for and
 * caches the latest value on `window` for late-mounting panes. No-op on the
 * server.
 */
export function registerCopilotContext(ctx: CopilotContext): void {
  if (typeof window === 'undefined') return;
  const w = window as CopilotContextWindow;
  w.__loomCopilotContext = ctx;
  window.dispatchEvent(new CustomEvent<CopilotContext>(EVT, { detail: ctx }));
}

/**
 * Clear the pane context back to the cross-item default. Editors call this on
 * unmount so closing a SQL editor doesn't leave the Copilot stuck in the
 * Warehouse persona.
 */
export function clearCopilotContext(): void {
  registerCopilotContext(DEFAULT_CONTEXT);
}

/**
 * React-side: returns the currently registered Copilot context, updating
 * whenever an editor calls registerCopilotContext. Seeded from the `window`
 * cache so the pane reflects the active pane immediately on open.
 */
export function useCopilotContext(): CopilotContext {
  const [ctx, setCtx] = useState<CopilotContext>(() => {
    if (typeof window === 'undefined') return DEFAULT_CONTEXT;
    return (window as CopilotContextWindow).__loomCopilotContext ?? DEFAULT_CONTEXT;
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CopilotContext>).detail;
      if (detail && typeof detail.slug === 'string') setCtx(detail);
    };
    window.addEventListener(EVT, handler);
    // Re-sync from the cache in case a register fired before this effect ran.
    const cached = (window as CopilotContextWindow).__loomCopilotContext;
    if (cached) setCtx(cached);
    return () => window.removeEventListener(EVT, handler);
  }, []);

  return ctx;
}

/**
 * Editor convenience hook: register a context for the lifetime of the
 * component, auto-clearing on unmount. Pass the slug + a memoized payload (the
 * payload identity drives the re-register effect).
 */
export function useRegisterCopilotContext(slug: string, payload: Record<string, unknown>): void {
  useEffect(() => {
    registerCopilotContext({ slug, payload });
    return () => clearCopilotContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, JSON.stringify(payload)]);
}

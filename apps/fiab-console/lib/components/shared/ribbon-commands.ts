'use client';

/**
 * SC-9 support — turn an editor's existing Ribbon definition into registered
 * surface commands so the in-ribbon <CommandSearch> box (and the Ctrl+K palette)
 * surface every ribbon action with ZERO duplication. An editor keeps ONE source
 * of truth for its actions (the `RibbonTab[]` it already builds) and calls
 * `useRegisterRibbonCommands(ribbon, surfaceId)` to publish them.
 *
 * Kept in its own module (not command-search.tsx) so the visual component never
 * imports the ribbon types — command-search.tsx depends only on the pure
 * registry singleton, and ribbon.tsx can import <CommandSearch> without a cycle.
 */

import { useEffect } from 'react';
import {
  registerCanvasCommands, type CanvasCommand,
} from '@/lib/components/canvas/canvas-command-registry';
import type { RibbonTab } from '@/lib/components/ribbon';

/**
 * Flatten a Ribbon definition into registry commands. Only WIRED actions (those
 * with an `onClick`) become runnable commands — un-wired/decorative labels and
 * disabled actions are represented but flagged disabled (the registry hides
 * disabled ones from search, matching the honest ribbon that greys them out).
 * Split-dropdown menu items are flattened too so each is independently findable.
 */
export function deriveCommandsFromRibbon(tabs: RibbonTab[], surfaceId: string): CanvasCommand[] {
  const out: CanvasCommand[] = [];
  const seen = new Set<string>();
  const push = (cmd: CanvasCommand) => {
    if (seen.has(cmd.id)) return;
    seen.add(cmd.id);
    out.push(cmd);
  };
  for (const tab of tabs) {
    for (const group of tab.groups) {
      for (const a of group.actions) {
        if (a.onClick) {
          const onClick = a.onClick;
          push({
            id: `${surfaceId}:${tab.id}:${group.label}:${a.label}`,
            label: a.label,
            sub: `${tab.label} · ${group.label}`,
            group: tab.label,
            icon: a.icon,
            run: () => onClick(),
            disabled: a.disabled ? () => true : undefined,
          });
        }
        for (const mi of a.dropdownItems ?? []) {
          if (!mi.onClick) continue;
          const onClick = mi.onClick;
          push({
            id: `${surfaceId}:${tab.id}:${group.label}:${a.label}:${mi.label}`,
            label: mi.label,
            sub: `${tab.label} · ${a.label}`,
            group: tab.label,
            icon: mi.icon,
            run: () => onClick(),
            disabled: mi.disabled ? () => true : undefined,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Publish an editor's ribbon actions to the shared command registry for the
 * lifetime of the surface. Re-registers whenever the ribbon changes (deps:
 * [tabs, surfaceId]) and disposes on unmount, so commands never leak between
 * editors. Safe to call unconditionally at the top of an editor (Rules of Hooks).
 */
export function useRegisterRibbonCommands(tabs: RibbonTab[], surfaceId: string): void {
  useEffect(
    () => registerCanvasCommands(deriveCommandsFromRibbon(tabs, surfaceId)),
    [tabs, surfaceId],
  );
}

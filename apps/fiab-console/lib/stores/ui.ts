'use client';

/**
 * Global UI store — the ACTIVE workspace context. Drives the topbar workspace
 * switcher (workspace-switcher.tsx) and seeds the New Item dialog's workspace
 * picker (new-item-dialog.tsx). item-editor-chrome.tsx auto-pins the
 * last-opened workspace here so the switcher follows the user around.
 *
 * Persisted to localStorage ('loom-ui') so the active workspace survives
 * navigation and reloads.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface WorkspaceRef {
  id: string;
  name: string;
}

interface UiState {
  /** The workspace the user is currently working in. null = "All workspaces". */
  activeWorkspace: WorkspaceRef | null;
  /** Last 5 workspaces opened — surfaced under "Recent" in the switcher. */
  recentWorkspaces: WorkspaceRef[];
  /**
   * Set the active workspace (or clear to "All workspaces"). A non-null value is
   * also pinned to the top of the recent list (auto-pin last-opened).
   */
  setActiveWorkspace: (w: WorkspaceRef | null) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      activeWorkspace: null,
      recentWorkspaces: [],
      setActiveWorkspace: (w) => {
        if (!w) {
          set({ activeWorkspace: null });
          return;
        }
        const recent = [w, ...get().recentWorkspaces.filter((x) => x.id !== w.id)].slice(0, 5);
        set({ activeWorkspace: w, recentWorkspaces: recent });
      },
    }),
    {
      name: 'loom-ui',
      storage: createJSONStorage(() => (typeof window === 'undefined' ? ({} as Storage) : window.localStorage)),
    },
  ),
);

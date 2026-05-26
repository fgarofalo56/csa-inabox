'use client';

/**
 * Sidebar collapse + workspace selector state (Phase 1).
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebar: (v: boolean) => void;
  /** Last 3 workspaces opened — pinned at the bottom of the sidebar. */
  recentWorkspaces: { id: string; name: string }[];
  /** Last 3 items opened — pinned at the bottom of the sidebar. */
  recentItems: { key: string; slug: string; id: string; title: string }[];
  pushWorkspace: (w: { id: string; name: string }) => void;
  pushItem: (i: { key: string; slug: string; id: string; title: string }) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setSidebar: (v) => set({ sidebarCollapsed: v }),
      recentWorkspaces: [],
      recentItems: [],
      pushWorkspace: (w) => {
        const list = [w, ...get().recentWorkspaces.filter((x) => x.id !== w.id)].slice(0, 3);
        set({ recentWorkspaces: list });
      },
      pushItem: (i) => {
        const list = [i, ...get().recentItems.filter((x) => x.key !== i.key)].slice(0, 3);
        set({ recentItems: list });
      },
    }),
    {
      name: 'loom-ui',
      storage: createJSONStorage(() => (typeof window === 'undefined' ? ({} as Storage) : window.localStorage)),
    },
  ),
);

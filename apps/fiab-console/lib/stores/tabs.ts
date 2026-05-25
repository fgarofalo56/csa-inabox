'use client';

/**
 * Open-tabs store — every opened item is tracked here so the top tab strip
 * can render them with × close + dirty marker + saved status, regardless of
 * which Next.js route the user is currently in.
 *
 * Persisted to localStorage so a hard refresh keeps the user's tab session.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type TabSaveStatus = 'saved' | 'saving' | 'dirty' | 'error';

export interface OpenTab {
  /** Stable key — `${slug}:${id}` */
  key: string;
  /** Item-type slug */
  slug: string;
  /** Item id (workspace item id or 'new') */
  id: string;
  /** Display title shown on the tab */
  title: string;
  /** Last-known route for this tab */
  href: string;
  /** Visual status for the trailing badge */
  status: TabSaveStatus;
  /** Workspace id if known (for breadcrumb) */
  workspaceId?: string;
  /** Item category for the icon swatch */
  category?: string;
  /** Created-at ms timestamp (used for sort + LRU eviction) */
  openedAt: number;
}

interface TabsState {
  tabs: OpenTab[];
  activeKey: string | null;
  open: (tab: Omit<OpenTab, 'openedAt' | 'status'> & { status?: TabSaveStatus }) => void;
  close: (key: string) => void;
  setStatus: (key: string, status: TabSaveStatus) => void;
  setActive: (key: string) => void;
  closeAll: () => void;
}

const MAX_TABS = 20;

export const useOpenTabs = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeKey: null,
      open: (t) => {
        const tabs = [...get().tabs];
        const existing = tabs.findIndex((x) => x.key === t.key);
        if (existing >= 0) {
          // bump to active, keep existing status
          set({ activeKey: t.key });
          return;
        }
        const next: OpenTab = {
          ...t,
          status: t.status ?? 'saved',
          openedAt: Date.now(),
        };
        tabs.push(next);
        // LRU evict
        while (tabs.length > MAX_TABS) tabs.shift();
        set({ tabs, activeKey: next.key });
      },
      close: (key) => {
        const tabs = get().tabs.filter((t) => t.key !== key);
        const active = get().activeKey;
        const nextActive =
          active === key ? (tabs[tabs.length - 1]?.key ?? null) : active;
        set({ tabs, activeKey: nextActive });
      },
      setStatus: (key, status) => {
        set({
          tabs: get().tabs.map((t) => (t.key === key ? { ...t, status } : t)),
        });
      },
      setActive: (key) => set({ activeKey: key }),
      closeAll: () => set({ tabs: [], activeKey: null }),
    }),
    {
      name: 'loom-open-tabs',
      storage: createJSONStorage(() => (typeof window === 'undefined' ? ({} as Storage) : window.localStorage)),
    },
  ),
);

'use client';
/**
 * sql-editor-kit — shared multi-tab + run-selection primitives reused by the
 * Databricks / Synapse Dedicated / Synapse Serverless / Warehouse SQL editors
 * so all four get identical Fabric-parity behaviour from one implementation.
 *
 *  - useSqlTabs:   per-query tabs (SQL text + result + loading + queryId)
 *  - SqlTabBar:    Fluent TabList with add (+) and per-tab close (×)
 *  - getRunSql:    run-selection — returns the highlighted text if any, else
 *                  the full editor text (SSMS / Azure Data Studio behaviour)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Tab, TabList, Button, Spinner, tokens,
} from '@fluentui/react-components';
import { Add16Regular, Dismiss12Regular } from '@fluentui/react-icons';
import { getRunSql } from './sql-run-selection';
import { registerCopilotContext, clearCopilotContext } from '@/lib/copilot/use-copilot-context';

export { getRunSql };

let tabSeq = 1;
function rid(): string {
  // crypto.randomUUID is available in the browser; fall back to a counter for
  // non-secure contexts / SSR safety.
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `tab-${Date.now()}-${tabSeq++}`;
}

/**
 * Opt-in Copilot persona wiring for a SQL editor. When passed to useSqlTabs the
 * active tab's SQL is registered as the right-rail Copilot's `activeQuery`
 * context under the given persona `slug` (e.g. 'warehouse'), so "Explain this
 * query" produces a persona-flavored answer grounded in the real editor text.
 */
export interface SqlCopilotBinding {
  /** ContextSlug from copilot-personas.ts, e.g. 'warehouse'. */
  slug: string;
  /** Loom workspace id (optional grounding). */
  workspaceId?: string;
  /** Loom item id (optional grounding). */
  itemId?: string;
  /** Table/column schema text (optional grounding). */
  schema?: string;
}

export interface SqlTab<R = unknown> {
  id: string;
  label: string;
  sql: string;
  result: R | null;
  loading: boolean;
  /** client-generated id used to cancel this tab's in-flight query */
  queryId?: string;
}

export interface SqlTabsApi<R = unknown> {
  tabs: SqlTab<R>[];
  activeTabId: string;
  activeTab: SqlTab<R>;
  setActiveTabId: (id: string) => void;
  addTab: () => void;
  closeTab: (id: string) => void;
  patchTab: (id: string, patch: Partial<SqlTab<R>>) => void;
  /** set the SQL text of the active tab (drop-in for setSqlText) */
  setActiveSql: (sql: string) => void;
  /** set the result of the active tab (drop-in for setResult) */
  setActiveResult: (result: R | null) => void;
}

/**
 * Multi-tab query state. The active tab's `sql` / `result` / `loading` replace
 * the editors' former single useState values one-for-one.
 */
export function useSqlTabs<R = unknown>(defaultSql: string, copilot?: SqlCopilotBinding): SqlTabsApi<R> {
  const [tabs, setTabs] = useState<SqlTab<R>[]>(() => [
    { id: 'q1', label: 'Query 1', sql: defaultSql, result: null, loading: false },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('q1');
  const activeIdRef = useRef('q1');
  activeIdRef.current = activeTabId;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // Register the active query as the right-rail Copilot context so the editor's
  // persona ("Warehouse Copilot" etc.) can EXPLAIN / OPTIMIZE the EXACT text the
  // user is editing. Clears back to the default persona on unmount.
  const copilotSlug = copilot?.slug;
  const copilotWorkspaceId = copilot?.workspaceId;
  const copilotItemId = copilot?.itemId;
  const copilotSchema = copilot?.schema;
  const activeSql = activeTab?.sql ?? '';
  useEffect(() => {
    if (!copilotSlug) return;
    registerCopilotContext({
      slug: copilotSlug,
      payload: {
        activeQuery: activeSql,
        ...(copilotSchema ? { schema: copilotSchema } : {}),
        ...(copilotWorkspaceId ? { workspaceId: copilotWorkspaceId } : {}),
        ...(copilotItemId ? { itemId: copilotItemId } : {}),
      },
    });
  }, [copilotSlug, activeSql, copilotSchema, copilotWorkspaceId, copilotItemId]);
  useEffect(() => {
    if (!copilotSlug) return;
    return () => clearCopilotContext();
  }, [copilotSlug]);

  const patchTab = useCallback((id: string, patch: Partial<SqlTab<R>>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const setActiveSql = useCallback((sql: string) => {
    setTabs((ts) => ts.map((t) => (t.id === activeIdRef.current ? { ...t, sql } : t)));
  }, []);

  const setActiveResult = useCallback((result: R | null) => {
    setTabs((ts) => ts.map((t) => (t.id === activeIdRef.current ? { ...t, result } : t)));
  }, []);

  const addTab = useCallback(() => {
    const id = rid();
    setTabs((ts) => {
      const n = ts.length + 1;
      return [...ts, { id, label: `Query ${n}`, sql: '', result: null, loading: false }];
    });
    setActiveTabId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((ts) => {
      if (ts.length === 1) return ts; // always keep at least one tab
      const next = ts.filter((t) => t.id !== id);
      if (activeIdRef.current === id) setActiveTabId(next[next.length - 1].id);
      return next;
    });
  }, []);

  return {
    tabs, activeTabId, activeTab, setActiveTabId,
    addTab, closeTab, patchTab, setActiveSql, setActiveResult,
  };
}

export interface SqlTabBarProps<R = unknown> {
  tabs: SqlTab<R>[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}

export function SqlTabBar<R = unknown>({ tabs, activeTabId, onSelect, onAdd, onClose }: SqlTabBarProps<R>) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, gap: 2 }}>
      <TabList
        selectedValue={activeTabId}
        onTabSelect={(_, d) => onSelect(d.value as string)}
        size="small"
        style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}
      >
        {tabs.map((t) => (
          <Tab key={t.id} value={t.id}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {t.label}
              {t.loading && <Spinner size="extra-tiny" />}
              {tabs.length > 1 && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss12Regular />}
                  aria-label={`Close ${t.label}`}
                  onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                  style={{ minWidth: 'auto', padding: 0, height: 16, width: 16 }}
                />
              )}
            </span>
          </Tab>
        ))}
      </TabList>
      <Button size="small" appearance="subtle" icon={<Add16Regular />} aria-label="New query tab" onClick={onAdd} />
    </div>
  );
}

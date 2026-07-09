/**
 * ExplorerTree model — PURE, DOM-free logic behind the shared `<ExplorerTree>`
 * (SC-7): the typed-icon + right-click context-menu explorer tree lifted out of
 * the ADF `FactoryResourcesTree`. This module owns the generic node shape, the
 * name filter, and the branch/leaf classification so they can be unit-tested in
 * isolation. Every consumer (Synapse workspace tree, Lakehouse explorer, KQL
 * tree, Cosmos container explorer …) feeds it nodes built from its OWN real REST
 * list calls — no mock data (no-vaporware.md), no Fabric dependency.
 */

import type { ReactElement } from 'react';
import type { BadgeProps } from '@fluentui/react-components';

/** A right-click (and optionally inline) action offered on a node. */
export interface ExplorerAction {
  /** Stable key dispatched back to the consumer's `onAction`. */
  key: string;
  /** Menu / tooltip label. */
  label: string;
  /** Icon for the context-menu item + the inline button (when `inline`). */
  icon?: ReactElement;
  /** Also render as a small inline icon button on the row (e.g. Open / Delete). */
  inline?: boolean;
  /** Render a divider before this item + a destructive tint (e.g. Delete). */
  destructive?: boolean;
  /** Greys the action out (kept visible so the affordance is discoverable). */
  disabled?: boolean;
}

/** A generic typed node — one row in the tree. */
export interface ExplorerNode {
  /** Unique id — used as the Fluent Tree item value + React key. */
  id: string;
  /** Row label (the resource / object name). */
  label: string;
  /**
   * Type discriminator the consumer maps to an icon via `iconFor`. Also lets
   * `actionsFor` return a different action set per kind (pipeline vs trigger).
   */
  kind: string;
  /** Preloaded children (branch). Absent + `hasChildren` ⇒ lazy branch. */
  children?: ExplorerNode[];
  /** Mark a branch whose children load lazily on first expand. */
  hasChildren?: boolean;
  /** Right-aligned status badge (e.g. trigger runtime state). */
  badge?: { text: string; color?: BadgeProps['color']; appearance?: BadgeProps['appearance'] };
  /** Right-aligned muted caption (e.g. type, row count). */
  meta?: string;
  /** Bold the label (e.g. the currently-bound pipeline). */
  emphasized?: boolean;
  /** Opaque payload echoed back on `onOpen` / `onAction`. */
  data?: unknown;
}

/** Whether a node renders as an expandable branch (has or will have children). */
export function isBranch(node: ExplorerNode): boolean {
  return !!node.hasChildren || Array.isArray(node.children);
}

/** Case-insensitive label match for the filter box. Empty query matches all. */
export function nodeMatches(node: ExplorerNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return node.label.toLowerCase().includes(q);
}

/**
 * Filter a node forest by name. A branch is kept when it matches OR any
 * descendant matches (and its surviving children are the matches); a leaf is
 * kept only when it matches. Lazy branches (children not yet loaded) are kept
 * when their own label matches — their unloaded contents can't be searched.
 * Empty query returns the forest unchanged (referential identity preserved).
 */
export function filterExplorerNodes(nodes: ExplorerNode[], query: string): ExplorerNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  const out: ExplorerNode[] = [];
  for (const node of nodes) {
    const selfMatch = node.label.toLowerCase().includes(q);
    if (Array.isArray(node.children)) {
      const kids = filterExplorerNodes(node.children, q);
      if (selfMatch || kids.length > 0) {
        // When the branch itself matches, keep all its children; otherwise keep
        // only the surviving (matching) subset.
        out.push({ ...node, children: selfMatch ? node.children : kids });
      }
    } else if (selfMatch) {
      out.push(node);
    }
  }
  return out;
}

/** Total leaf count under a forest (branches with 0 leaves count as 0). */
export function countLeaves(nodes: ExplorerNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (Array.isArray(node.children)) n += countLeaves(node.children);
    else if (!node.hasChildren) n += 1;
  }
  return n;
}

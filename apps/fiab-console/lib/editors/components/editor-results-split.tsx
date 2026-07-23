'use client';

/**
 * EditorResultsSplit — the U6 shared query↔results divider (loom-next-level
 * ws-ui-excellence U6, systemic gap #3).
 *
 * Before U6 no SQL/KQL/graph editor had a draggable divider between the query
 * editor and the results grid — results were capped at a fixed `maxHeight:360`
 * everywhere. This wrapper is the ONE shared implementation the 11 Monaco
 * editors adopt mechanically, so future editors inherit it.
 *
 * Physics: these editors are flow-layout scrolling pages, so a bare divider
 * between two auto-height blocks cannot track the pointer (the query block's
 * height is intrinsic). The correct SSMS/ADS/Fabric model needs a definite
 * workspace height that the divider reallocates. Both halves reuse the
 * sanctioned shared primitives — nothing hand-rolled (G3):
 *
 *   • The WORKSPACE (query + results together) is a `ResizableCanvasRegion`
 *     (bottom grip, persisted under `loom.canvasHeight.<editorKey>.results-workspace`)
 *     so the total editing surface is user-adjustable, never fixed.
 *   • Inside it, a vertical `SplitPane` (persisted under
 *     `loom.splitpane.<editorKey>.results-split`) is the query↔results divider:
 *     dragging it reallocates space between the query pane and the results
 *     pane, tracking the pointer 1:1 exactly like SSMS / Azure Data Studio /
 *     the Fabric SQL editor.
 *
 * The query pane scrolls internally and keeps monaco-textarea's existing
 * height grip untouched (the divider is the NEW piece). The results pane
 * provides `EditorSplitContext=true` so the shared result renderers
 * (PreviewTable, ResultsPanel, KqlResultsPanel, …) swap their fixed
 * `maxHeight` cap for flex-fill (see editor-split-context.ts).
 *
 * Mount semantics: the split renders only while `active` (a query is running
 * or a result exists) AND the FLAG0 runtime kill-switch `u6-monaco-divider`
 * is ON. Otherwise children render in today's flow layout unchanged — clean
 * first-open (no dead half-pane before the first Run) and an instant, no-roll
 * revert path for a GuidedPickerRail-class regression.
 */

import type { CSSProperties, ReactNode } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { ResizableCanvasRegion } from '@/lib/components/canvas/resizable-canvas';
import {
  EditorSplitContext, SPLIT_FILL_STYLE, useInEditorResultsSplit,
} from '@/lib/components/editor/editor-split-context';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const U6_SPLIT_FLAG_ID = 'u6-monaco-divider';

/**
 * FLAG0 read, fail-open. `useRuntimeFlag` needs the app's QueryClientProvider
 * (always present under app/providers.tsx at runtime); bare jsdom mounts of an
 * adopting editor (the auto-generated contract tests) have none and the hook
 * throws synchronously. Provider presence is fixed for the lifetime of a mount
 * tree, so catching here is hook-order-stable — and default-ON matches the
 * kill-switch contract (the flag subsystem can never take a surface down).
 */
function useDividerFlag(): boolean {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRuntimeFlag(U6_SPLIT_FLAG_ID);
  } catch {
    return true;
  }
}

// Inherent layout dimensions (no Fluent token expresses these):
/** Default total workspace height (query + divider + results) in px — matches
 * the pre-U6 stack (~260 editor + bars + 360 results). */
const WORKSPACE_DEFAULT_PX = 680;
/** Workspace floor — below this the two panes are unusable. */
const WORKSPACE_MIN_PX = 400;
/** Query-pane floor (px) — keeps a few Monaco lines + toolbar visible. */
const QUERY_MIN_PX = 160;

const useStyles = makeStyles({
  // Each pane owns its scroll; children keep their natural flow heights
  // (monaco's own grip region, toolbars, message bars). minWidth 0 per
  // web3-ui responsive rules.
  pane: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
  },
  // Results pane gets a hair of top padding so the first row of the grid
  // doesn't butt the divider line.
  resultsPane: {
    paddingTop: tokens.spacingVerticalXS,
  },
});

export interface EditorResultsSplitProps {
  /**
   * Per-editor persistence key, e.g. `'warehouse'` →
   * `loom.splitpane.warehouse.results-split` (divider) +
   * `loom.canvasHeight.warehouse.results-workspace` (workspace height).
   */
  editorKey: string;
  /** Query half: the Monaco editor plus its tightly-coupled bars. */
  query: ReactNode;
  /** Results half: the result renderer (spinner/error/grid states included). */
  results: ReactNode;
  /**
   * Mount the split only when there is something to split against —
   * typically `loading || result != null`. When false the children render
   * in the plain flow layout (identical to pre-U6), keeping first-open clean.
   */
  active: boolean;
  /** Initial workspace height (px). Default 680. */
  defaultWorkspacePx?: number;
  /** Initial query-pane share of the workspace. Default '45%'. */
  defaultQuerySize?: number | string;
}

export function EditorResultsSplit({
  editorKey,
  query,
  results,
  active,
  defaultWorkspacePx = WORKSPACE_DEFAULT_PX,
  defaultQuerySize = '45%',
}: EditorResultsSplitProps) {
  const s = useStyles();
  // FLAG0 kill-switch — default-ON; OFF reverts every adopter to the pre-U6
  // flow layout on the next render, no roll required.
  const dividerOn = useDividerFlag();

  if (!dividerOn || !active) {
    return (
      <>
        {query}
        {results}
      </>
    );
  }

  return (
    <ResizableCanvasRegion
      storageKey={`${editorKey}.results-workspace`}
      defaultPx={defaultWorkspacePx}
      minPx={WORKSPACE_MIN_PX}
      ariaLabel="Resize query workspace height. Use Arrow Up and Arrow Down keys."
    >
      <SplitPane
        direction="vertical"
        primary="first"
        defaultSize={defaultQuerySize}
        minSize={QUERY_MIN_PX}
        storageKey={`${editorKey}.results-split`}
        dividerLabel="Resize query / results split"
      >
        <div className={s.pane}>{query}</div>
        <div className={mergeClasses(s.pane, s.resultsPane)}>
          <EditorSplitContext.Provider value={true}>
            {results}
          </EditorSplitContext.Provider>
        </div>
      </SplitPane>
    </ResizableCanvasRegion>
  );
}

/**
 * SplitFillBox — a plain results container (e.g. an editor's inline
 * `tableWrap` div) that flex-fills the results pane when rendered inside an
 * active EditorResultsSplit and keeps its flow-layout styling (fixed
 * `maxHeight` cap from `className`) otherwise. For editors whose results grid
 * is a bare div rather than a shared renderer component.
 */
export function SplitFillBox({
  className, style, children, ariaLabel,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const inSplit = useInEditorResultsSplit();
  return (
    <div className={className} aria-label={ariaLabel} style={inSplit ? { ...style, ...SPLIT_FILL_STYLE } : style}>
      {children}
    </div>
  );
}

export default EditorResultsSplit;

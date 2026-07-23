'use client';

/**
 * editor-split-context — shared signal for the U6 query↔results split.
 *
 * `EditorResultsSplit` (lib/editors/components/editor-results-split.tsx)
 * provides `true` around its RESULTS pane. Result renderers (PreviewTable,
 * ResultsPanel, KqlResultsPanel/KustoResultsGrid, the Databricks ResultsPanel,
 * the graph ResultsPreview, …) read it to switch from their flow-layout
 * fixed `maxHeight` cap to a flex-fill layout that expands to the pane the
 * user sized with the divider. Outside the split (flag OFF, or a renderer
 * used on a non-U6 surface) the value is `false` and nothing changes.
 *
 * Lives in its own tiny module so both `lib/components/**` renderers and
 * `lib/editors/**` adopters can import it without a dependency cycle.
 */

import { createContext, useContext } from 'react';

export const EditorSplitContext = createContext<boolean>(false);

/** True when rendering inside the results pane of an active EditorResultsSplit. */
export function useInEditorResultsSplit(): boolean {
  return useContext(EditorSplitContext);
}

/**
 * Inline flex-fill overrides for a results grid/box inside the split pane:
 * releases the flow-layout `maxHeight` cap and lets the element take the
 * remaining pane height with its own scrollbar. Values are layout props
 * (flex/min/max), not spacing — no token exists for them.
 */
export const SPLIT_FILL_STYLE = {
  maxHeight: 'none',
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: '0%',
  minHeight: 0,
  overflow: 'auto',
} as const;

import { makeStyles, tokens } from '@fluentui/react-components';

/**
 * Canonical shared style vocabulary for CSA Loom item editors.
 *
 * These are the editor-agnostic primitives (~13 classes) that 40+ editors were
 * each re-declaring verbatim (a `pad`/`toolbar`/`card`/`tableWrap` trio, the
 * Monaco/code surface, the results grid). They live here so there is ONE
 * canonical, fully-tokenized home — no hard-coded px/hex, per
 * .claude/rules/web3-ui.md.
 *
 * OPT-IN: existing editors keep their bespoke `makeStyles` blocks; new editors
 * and the per-folder `shared.tsx` modules SHOULD import from here rather than
 * re-declaring these. `phase3/styles.ts` composes this module (see there).
 */
export const useSharedEditorStyles = makeStyles({
  /** Code / query surface (Monaco-styled textarea fallback). */
  monaco: {
    width: '100%',
    minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  /** Vertical content pad — the default editor body column. */
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  /** Horizontal action row (buttons/inputs) above content. */
  toolbar: { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' },
  /** Elevated content card. */
  card: {
    padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1,
  },
  /** Responsive auto-fill card grid. */
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingVerticalM },
  /**
   * Tab strip container.
   *
   * `flexShrink: 0` is LOAD-BEARING (#2648) — do not drop it. Every editor
   * renders its strip as a direct flex child of ItemEditorChrome's
   * height-constrained `mainPanel` column (`height: calc(100vh - 112px)` →
   * `flex: 1; min-height: 0`). CSS gives a column flex item an automatic
   * minimum size of `min-content` ONLY while its `overflow` is `visible`; the
   * moment a long strip becomes its own scroll container (`overflow-x: auto`,
   * which the 26-tab semantic-model strip and the Foundry hub strip both set)
   * that automatic minimum resolves to **0** instead. The strip then absorbs
   * the column's entire negative free space and collapses to the height of its
   * own horizontal scrollbar — measured live at **9px** — while the
   * `fui-TabList` inside keeps its 32px height and therefore paints OUTSIDE its
   * own scroller, underneath the sibling content divs. The tabs stay visible
   * but stop receiving pointer events entirely: every tab became
   * keyboard-only, including under Playwright `{ force: true }`.
   *
   * Pinning the strip against shrink keeps it at content height, so the tabs
   * stay inside their scroller and clickable. `minHeight: 'fit-content'` is the
   * belt-and-braces for grid/other contexts where `flex-shrink` does not apply.
   */
  tabBar: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
    minHeight: 'fit-content',
  },
  /** Query/exec results container. */
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM, minHeight: '180px' },
  /** Results metadata row (row count, duration…). */
  resultMeta: { display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  /** Scrollable table wrapper (content never butts the border). */
  tableWrap: { overflow: 'auto', maxHeight: '320px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  /** Monospace table cell. */
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  /** Tree/nav pad. */
  treePad: { padding: tokens.spacingVerticalS },
  /** Copilot/assist input bar docked under a surface. */
  assistBar: {
    display: 'flex', gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  /** Copilot/assist rendered result (wraps + scrolls, never overflows). */
  assistResult: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', margin: 0,
    overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%',
    maxHeight: '320px', overflow: 'auto',
  },
});

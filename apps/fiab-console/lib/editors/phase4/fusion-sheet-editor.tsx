'use client';

/**
 * Fusion Sheet editor (Foundry-parity row 3.4). An A1-addressed grid whose
 * cells hold literals or =formulas, evaluated live by the pure
 * fusion-sheet-engine (SUM/AVG/MIN/MAX/COUNT/IF/ROUND/ABS/CONCAT, ranges,
 * cycle detection, Excel-style errors). Persistence via PATCH state.cells.
 * Fluent v9 + Loom tokens. Azure-native — no Fabric.
 *
 * C14/C21 accessibility + canvas-standards fixes. As shipped, this surface was
 * a spreadsheet you had to CLICK every cell of:
 *   - each cell was a bare `<div onClick>` — not focusable, no role, and
 *     therefore UNREACHABLE by keyboard at all (WCAG 2.1.1 Keyboard, 4.1.2
 *     Name/Role/Value). Only Enter/Escape existed, and only once an Input had
 *     already been mounted by a mouse click;
 *   - there was NO UNDO, on a surface whose whole purpose is destructive edits
 *     to a data grid (ux-baseline.md forbids a canvas with no undo/redo);
 *   - the grid was hard-coded 20x10, so a sheet holding data outside that box
 *     rendered as though the data did not exist — the cells were still saved
 *     and still evaluated, just invisible.
 * Now: full roving-tabindex keyboard grid, Ctrl+Z/Ctrl+Y history, and a viewport
 * that always covers the stored data plus room to grow.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Input, Badge, Spinner, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowUndo16Regular, ArrowRedo16Regular, AddRegular } from '@fluentui/react-icons';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { evaluateSheet, indexToCol, colToIndex } from '../fusion-sheet-engine';
import { useItemDocState, ItemLoadErrorBar } from '../use-item-doc-state';

/** The MINIMUM viewport. The real one also covers whatever the sheet stores. */
const MIN_ROWS = 20;
const MIN_COLS = 10;
/** Blank rows/columns kept beyond the last populated cell, so there is always
 *  somewhere to type without pressing "Add" first. */
const HEADROOM_ROWS = 5;
const HEADROOM_COLS = 3;
/** How many the Add buttons append. */
const GROW_ROWS = 10;
const GROW_COLS = 5;
/** Bound on the undo stack — deep enough to be useful, bounded so a long
 *  session cannot grow memory without limit. */
const MAX_HISTORY = 100;

/** Stable identity for the "no cells" state — a fresh `{}` each render would
 *  make the hook's `empty` a new object on every pass. */
const EMPTY_CELLS: Record<string, string> = {};

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minWidth: 0 },
  bar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  gridWrap: { overflowX: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge },
  grid: { borderCollapse: 'collapse' },
  th: { padding: tokens.spacingVerticalXS, backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, textAlign: 'center', minWidth: '72px' },
  thActive: { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2 },
  td: { border: `1px solid ${tokens.colorNeutralStroke2}`, padding: 0, minWidth: '72px' },
  cellShown: {
    padding: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200, cursor: 'cell',
    minHeight: '20px', whiteSpace: 'nowrap', outlineStyle: 'none',
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
      backgroundColor: tokens.colorNeutralBackground1Selected,
    },
  },
  cellActive: { backgroundColor: tokens.colorNeutralBackground1Selected },
  cellErr: { color: tokens.colorPaletteRedForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
});

const cellRef = (r: number, c: number) => `${indexToCol(c)}${r + 1}`;

/** Largest row/column index actually used by the stored cells (-1 when empty). */
function usedExtent(cells: Record<string, string>): { row: number; col: number } {
  let row = -1;
  let col = -1;
  for (const ref of Object.keys(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    col = Math.max(col, colToIndex(m[1]));
    row = Math.max(row, Number(m[2]) - 1);
  }
  return { row, col };
}

export function FusionSheetEditor({ id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** The roving-tabindex anchor: exactly ONE cell is tabbable at a time, and the
   *  arrow keys move it. This is the standard grid pattern — a grid where every
   *  cell is a tab stop is technically reachable and practically unusable. */
  const [active, setActive] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [grown, setGrown] = useState({ rows: 0, cols: 0 });
  const gridRef = useRef<HTMLTableElement>(null);
  /** Set when a keystroke moved the anchor, so focus follows it — but NOT on a
   *  plain re-render, which would steal focus from the toolbar. */
  const focusWanted = useRef(false);

  const doc = useItemDocState<Record<string, string>>({
    slug: 'fusion-sheet',
    id,
    empty: EMPTY_CELLS,
    select: (d) => {
      const cells = (d as { state?: { cells?: unknown } } | undefined)?.state?.cells;
      return cells && typeof cells === 'object' ? (cells as Record<string, string>) : undefined;
    },
    toPatchBody: (cells) => ({ state: { cells } }),
  });
  const { state: cells, setState: setCells, load, canSave, saving, saveMessage, save } = doc;

  // ── undo / redo ───────────────────────────────────────────────────────────
  const [past, setPast] = useState<Record<string, string>[]>([]);
  const [future, setFuture] = useState<Record<string, string>[]>([]);

  /** The ONE mutation path. Everything that changes a cell goes through this so
   *  no edit can escape the history (an undo that silently misses one kind of
   *  edit is worse than no undo). */
  const mutate = useCallback((next: Record<string, string>) => {
    setPast((p) => [...p, cells].slice(-MAX_HISTORY));
    setFuture([]);
    setCells(next);
  }, [cells, setCells]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [cells, ...f].slice(0, MAX_HISTORY));
      setCells(prev);
      return p.slice(0, -1);
    });
  }, [cells, setCells]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const nextState = f[0];
      setPast((p) => [...p, cells].slice(-MAX_HISTORY));
      setCells(nextState);
      return f.slice(1);
    });
  }, [cells, setCells]);

  // ── viewport: always covers the stored data ───────────────────────────────
  const { rows, cols } = useMemo(() => {
    const used = usedExtent(cells);
    return {
      rows: Math.max(MIN_ROWS, used.row + 1 + HEADROOM_ROWS) + grown.rows,
      cols: Math.max(MIN_COLS, used.col + 1 + HEADROOM_COLS) + grown.cols,
    };
  }, [cells, grown]);

  const evaluated = useMemo(() => evaluateSheet(cells), [cells]);

  const commitDraft = useCallback(() => {
    if (editing === null) return;
    const next = { ...cells };
    if (draft === '') delete next[editing]; else next[editing] = draft;
    mutate(next);
    setEditing(null);
    focusWanted.current = true;
  }, [editing, draft, cells, mutate]);

  const beginEdit = useCallback((ref: string, initial?: string) => {
    setEditing(ref);
    setDraft(initial !== undefined ? initial : (cells[ref] || ''));
  }, [cells]);

  const move = useCallback((dr: number, dc: number) => {
    setActive((a) => ({
      r: Math.min(rows - 1, Math.max(0, a.r + dr)),
      c: Math.min(cols - 1, Math.max(0, a.c + dc)),
    }));
    focusWanted.current = true;
  }, [rows, cols]);

  // Focus follows the anchor, but only when a keystroke asked for it.
  useEffect(() => {
    if (!focusWanted.current || editing !== null) return;
    focusWanted.current = false;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${cellRef(active.r, active.c)}"]`);
    el?.focus();
  }, [active, editing]);

  /** Grid keyboard model. Mirrors the spreadsheet conventions a user already
   *  has: arrows move, Enter/F2 edit, a printable character starts an edit with
   *  that character, Delete clears, Tab moves right. */
  const onCellKeyDown = useCallback((e: React.KeyboardEvent, r: number, c: number) => {
    const ref = cellRef(r, c);
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }

    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); move(-1, 0); return;
      case 'ArrowDown': e.preventDefault(); move(1, 0); return;
      case 'ArrowLeft': e.preventDefault(); move(0, -1); return;
      case 'ArrowRight': e.preventDefault(); move(0, 1); return;
      case 'Home':
        e.preventDefault();
        setActive(mod ? { r: 0, c: 0 } : { r, c: 0 });
        focusWanted.current = true;
        return;
      case 'End':
        e.preventDefault();
        setActive(mod ? { r: rows - 1, c: cols - 1 } : { r, c: cols - 1 });
        focusWanted.current = true;
        return;
      case 'PageUp': e.preventDefault(); move(-10, 0); return;
      case 'PageDown': e.preventDefault(); move(10, 0); return;
      case 'Tab':
        // Let Shift+Tab leave the grid; plain Tab walks right like a spreadsheet.
        if (!e.shiftKey) { e.preventDefault(); move(0, 1); }
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        beginEdit(ref);
        return;
      case 'Delete':
      case 'Backspace':
        if (cells[ref] !== undefined) {
          e.preventDefault();
          const next = { ...cells };
          delete next[ref];
          mutate(next);
        }
        return;
      default:
        // A printable character starts an edit seeded with it — the behaviour
        // every spreadsheet has and the reason this grid felt broken without it.
        if (e.key.length === 1 && !mod && !e.altKey) {
          e.preventDefault();
          beginEdit(ref, e.key);
        }
    }
  }, [cells, move, beginEdit, mutate, undo, redo, rows, cols]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <Subtitle2>Fusion sheet</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
        <Tooltip content="Undo (Ctrl+Z)" relationship="label">
          <Button appearance="subtle" icon={<ArrowUndo16Regular />} disabled={!canUndo} onClick={undo} aria-label="Undo" />
        </Tooltip>
        <Tooltip content="Redo (Ctrl+Y)" relationship="label">
          <Button appearance="subtle" icon={<ArrowRedo16Regular />} disabled={!canRedo} onClick={redo} aria-label="Redo" />
        </Tooltip>
        <span className={s.spacer} />
        {load.status === 'loading' && <Spinner size="tiny" label="Reading the sheet…" labelPosition="after" />}
        {/* Save is DISABLED while the stored cells are unknown — the visible half
            of the data-loss guard. `save()` refuses independently, so a
            programmatic call cannot route around this. */}
        <Button appearance="primary" onClick={() => void save()} disabled={!canSave || saving}>Save</Button>
        {saveMessage && <Caption1>{saveMessage}</Caption1>}
      </div>
      <ItemLoadErrorBar load={load} subject="fusion sheet" />
      <Body1>
        Type a value, or start with = for a formula — SUM, AVG, MIN, MAX, COUNT, IF, ROUND, ABS, CONCAT
        over cells and A1:B3 ranges.
      </Body1>
      <Caption1 className={s.hint}>
        Keyboard: arrows move · Enter or F2 edits · typing replaces · Delete clears · Tab moves right ·
        Home/End jump to the row edge (Ctrl+Home/End for the sheet) · Ctrl+Z undo · Ctrl+Y redo.
      </Caption1>
      <div className={s.gridWrap}>
        <table
          ref={gridRef}
          className={s.grid}
          role="grid"
          aria-label="Fusion sheet grid"
          aria-rowcount={rows}
          aria-colcount={cols}
        >
          <thead>
            {/* No whitespace between <th/> and the map: a text node directly
                inside <tr> is invalid HTML and React reports it as a hydration
                error (found by the C14 editor spec). */}
            <tr><th className={s.th} />{Array.from({ length: cols }, (_, c) => (
              <th key={c} className={`${s.th} ${active.c === c ? s.thActive : ''}`} scope="col">{indexToCol(c)}</th>
            ))}</tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r} aria-rowindex={r + 1}>
                <th className={`${s.th} ${active.r === r ? s.thActive : ''}`} scope="row">{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const ref = cellRef(r, c);
                  const ev = evaluated[ref];
                  const shown = ev ? String(ev.value) : '';
                  const isActive = active.r === r && active.c === c;
                  return (
                    <td key={c} className={s.td} aria-colindex={c + 1}>
                      {editing === ref ? (
                        <Input
                          autoFocus appearance="underline" value={draft}
                          aria-label={`Edit cell ${ref}`}
                          onChange={(_, d) => setDraft(d.value)}
                          onBlur={commitDraft}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); commitDraft(); move(1, 0); }
                            else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); focusWanted.current = true; }
                            else if (e.key === 'Tab') { e.preventDefault(); commitDraft(); move(0, e.shiftKey ? -1 : 1); }
                          }}
                        />
                      ) : (
                        <div
                          data-cell={ref}
                          role="gridcell"
                          // Roving tabindex: one tab stop for the whole grid.
                          tabIndex={isActive ? 0 : -1}
                          aria-label={`${ref}${cells[ref] ? `, ${cells[ref]}` : ', empty'}${ev?.isError ? `, error ${shown}` : ''}`}
                          aria-readonly={false}
                          aria-invalid={ev?.isError || undefined}
                          className={`${s.cellShown} ${isActive ? s.cellActive : ''} ${ev?.isError ? s.cellErr : ''}`}
                          title={cells[ref] || ''}
                          onFocus={() => setActive({ r, c })}
                          onKeyDown={(e) => onCellKeyDown(e, r, c)}
                          onClick={() => { setActive({ r, c }); beginEdit(ref); }}
                        >
                          {shown}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.bar}>
        <Button appearance="subtle" icon={<AddRegular />} onClick={() => setGrown((g) => ({ ...g, rows: g.rows + GROW_ROWS }))}>
          Add {GROW_ROWS} rows
        </Button>
        <Button appearance="subtle" icon={<AddRegular />} onClick={() => setGrown((g) => ({ ...g, cols: g.cols + GROW_COLS }))}>
          Add {GROW_COLS} columns
        </Button>
        <Caption1 className={s.hint}>{rows} x {cols} — the viewport always covers every stored cell.</Caption1>
      </div>
    </div>
  );
}

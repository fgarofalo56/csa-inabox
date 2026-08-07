'use client';

/**
 * Fusion Sheet editor (Foundry-parity row 3.4). An A1-addressed grid whose
 * cells hold literals or =formulas, evaluated live by the pure
 * fusion-sheet-engine (SUM/AVG/MIN/MAX/COUNT/IF/ROUND/ABS/CONCAT, ranges,
 * cycle detection, Excel-style errors). Persistence via PATCH state.cells.
 * Fluent v9 + Loom tokens. Azure-native — no Fabric.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Input, Badge, Spinner, makeStyles, tokens,
} from '@fluentui/react-components';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { evaluateSheet, indexToCol } from '../fusion-sheet-engine';
import { useItemDocState, ItemLoadErrorBar } from '../use-item-doc-state';

const ROWS = 20;
const COLS = 10;

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
  td: { border: `1px solid ${tokens.colorNeutralStroke2}`, padding: 0, minWidth: '72px' },
  cellShown: { padding: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200, cursor: 'cell', minHeight: '20px', whiteSpace: 'nowrap' },
  cellErr: { color: tokens.colorPaletteRedForeground1 },
});

export function FusionSheetEditor({ id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // C19 data-loss fix. The previous load was `catch { /* keep empty */ }`, so a
  // 500/403/network failure rendered a grid indistinguishable from an empty
  // sheet — and Save then PATCHed `{cells:{}}` over the user's real cells.
  // useItemDocState makes the failure an explicit state AND refuses to save
  // while the stored content is unknown.
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

  const evaluated = useMemo(() => evaluateSheet(cells), [cells]);

  const commitDraft = useCallback(() => {
    if (editing === null) return;
    setCells((prev) => {
      const next = { ...prev };
      if (draft === '') delete next[editing]; else next[editing] = draft;
      return next;
    });
    setEditing(null);
  }, [editing, draft, setCells]);

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <Subtitle2>Fusion sheet</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
        <span className={s.spacer} />
        {load.status === 'loading' && <Spinner size="tiny" label="Reading the sheet…" labelPosition="after" />}
        {/* Save is DISABLED while the stored cells are unknown — the visible half
            of the data-loss guard. `save()` refuses independently, so a
            programmatic call cannot route around this. */}
        <Button appearance="primary" onClick={() => void save()} disabled={!canSave || saving}>Save</Button>
        {saveMessage && <Caption1>{saveMessage}</Caption1>}
      </div>
      <ItemLoadErrorBar load={load} subject="fusion sheet" />
      <Body1>Type a value, or start with = for a formula — SUM, AVG, MIN, MAX, COUNT, IF, ROUND, ABS, CONCAT over cells and A1:B3 ranges. Click a cell to edit; Enter commits.</Body1>
      <div className={s.gridWrap}>
        <table className={s.grid} aria-label="Fusion sheet grid">
          <thead>
            {/* No whitespace between <th/> and the map: a text node directly
                inside <tr> is invalid HTML and React reports it as a hydration
                error (found by the C14 editor spec). */}
            <tr><th className={s.th} />{Array.from({ length: COLS }, (_, c) => <th key={c} className={s.th}>{indexToCol(c)}</th>)}</tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, r) => (
              <tr key={r}>
                <th className={s.th}>{r + 1}</th>
                {Array.from({ length: COLS }, (_, c) => {
                  const ref = `${indexToCol(c)}${r + 1}`;
                  const ev = evaluated[ref];
                  const shown = ev ? String(ev.value) : '';
                  return (
                    <td key={c} className={s.td}>
                      {editing === ref ? (
                        <Input autoFocus appearance="underline" value={draft}
                          onChange={(_, d) => setDraft(d.value)}
                          onBlur={commitDraft}
                          onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(); if (e.key === 'Escape') setEditing(null); }} />
                      ) : (
                        <div className={`${s.cellShown} ${ev?.isError ? s.cellErr : ''}`} title={cells[ref] || ''}
                          onClick={() => { setEditing(ref); setDraft(cells[ref] || ''); }}>
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
    </div>
  );
}

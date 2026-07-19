'use client';

/**
 * Fusion Sheet editor (Foundry-parity row 3.4). An A1-addressed grid whose
 * cells hold literals or =formulas, evaluated live by the pure
 * fusion-sheet-engine (SUM/AVG/MIN/MAX/COUNT/IF/ROUND/ABS/CONCAT, ranges,
 * cycle detection, Excel-style errors). Persistence via PATCH state.cells.
 * Fluent v9 + Loom tokens. Azure-native — no Fabric.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Input, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { evaluateSheet, indexToCol } from '../fusion-sheet-engine';

const ROWS = 20;
const COLS = 10;

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
  const [cells, setCells] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!id || id === 'new') return;
    void (async () => {
      try {
        const r = await clientFetch(`/api/cosmos-items/fusion-sheet/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        if (j?.state?.cells && typeof j.state.cells === 'object') setCells(j.state.cells);
      } catch { /* keep empty */ }
    })();
  }, [id]);

  const evaluated = useMemo(() => evaluateSheet(cells), [cells]);

  const commitDraft = useCallback(() => {
    if (editing === null) return;
    setCells((prev) => {
      const next = { ...prev };
      if (draft === '') delete next[editing]; else next[editing] = draft;
      return next;
    });
    setEditing(null);
  }, [editing, draft]);

  const save = useCallback(async () => {
    setSaved(null);
    try {
      const r = await clientFetch(`/api/items/fusion-sheet/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { cells } }),
      });
      setSaved(r.ok ? 'Saved.' : 'Save failed.');
    } catch { setSaved('Save failed.'); }
  }, [id, cells]);

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <Subtitle2>Fusion sheet</Subtitle2>
        <Badge appearance="tint" color="brand">Preview</Badge>
        <span className={s.spacer} />
        <Button appearance="primary" onClick={save}>Save</Button>
        {saved && <Caption1>{saved}</Caption1>}
      </div>
      <Body1>Type a value, or start with = for a formula — SUM, AVG, MIN, MAX, COUNT, IF, ROUND, ABS, CONCAT over cells and A1:B3 ranges. Click a cell to edit; Enter commits.</Body1>
      <div className={s.gridWrap}>
        <table className={s.grid} aria-label="Fusion sheet grid">
          <thead>
            <tr><th className={s.th} /> {Array.from({ length: COLS }, (_, c) => <th key={c} className={s.th}>{indexToCol(c)}</th>)}</tr>
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

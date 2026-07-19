'use client';

/**
 * Notepad editor (Foundry-parity row 3.3) — a live-data document: an ordered
 * list of blocks (heading / text / KQL query). Query blocks run inline against
 * ADX via /run-block and render a live results grid. Persistence via PATCH
 * state.blocks. Fluent v9 + Loom tokens. Azure-native — no Fabric.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Title3, Body1, Caption1, Button, Textarea, Input, Badge, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, Dropdown, Option, Field, makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Play20Regular, Dismiss16Regular, ArrowUp16Regular, ArrowDown16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

type Block = { type: 'heading' | 'text' | 'query'; content: string };
type BlockResult = { columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number };

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minWidth: 0 },
  bar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, boxShadow: tokens.shadow4 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  grid: { overflowX: 'auto' },
  kql: { fontFamily: 'Consolas, monospace' },
});

export function NotepadEditor({ id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [addType, setAddType] = useState<Block['type']>('text');
  const [results, setResults] = useState<Record<number, BlockResult>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!id || id === 'new') return;
    void (async () => {
      try {
        const r = await clientFetch(`/api/cosmos-items/notepad/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        if (Array.isArray(j?.state?.blocks)) setBlocks(j.state.blocks.filter((b: Block) => b && typeof b.content === 'string'));
      } catch { /* keep empty */ }
    })();
  }, [id]);

  const save = useCallback(async () => {
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/notepad/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { blocks } }) });
      setMsg(r.ok ? 'Saved.' : 'Save failed.');
    } catch { setMsg('Save failed.'); }
  }, [id, blocks]);

  const runBlock = useCallback(async (i: number) => {
    setBusy(i); setMsg(null);
    try {
      const r = await clientFetch(`/api/items/notepad/${encodeURIComponent(id)}/run-block`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kql: blocks[i].content }) });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setMsg(`${j?.error || `HTTP ${r.status}`}${j?.gate?.remediation ? ' — ' + j.gate.remediation : ''}`); return; }
      setResults((p) => ({ ...p, [i]: { columns: j.columns, rows: j.rows, rowCount: j.rowCount, executionMs: j.executionMs } }));
    } catch (e: any) { setMsg(e?.message || String(e)); } finally { setBusy(null); }
  }, [id, blocks]);

  const setBlock = (i: number, b: Block) => setBlocks((p) => p.map((x, xi) => (xi === i ? b : x)));
  const move = (i: number, d: -1 | 1) => setBlocks((p) => { const j = i + d; if (j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  return (
    <div className={s.wrap}>
      <div className={s.bar}>
        <Subtitle2>Notepad</Subtitle2>
        <Badge appearance="tint" color="brand">Live-data document</Badge>
        <span className={s.spacer} />
        <Field label="Add block">
          <Dropdown value={addType} selectedOptions={[addType]} onOptionSelect={(_, d) => setAddType((d.optionValue as Block['type']) || 'text')}>
            <Option value="heading">Heading</Option><Option value="text">Text</Option><Option value="query">KQL query</Option>
          </Dropdown>
        </Field>
        <Button icon={<Add20Regular />} onClick={() => setBlocks((p) => [...p, { type: addType, content: '' }])}>Add</Button>
        <Button appearance="primary" onClick={save}>Save</Button>
      </div>
      <Body1>A document whose query blocks run live against Azure Data Explorer — narrative and data together. No Microsoft Fabric.</Body1>
      {msg && <MessageBar intent={msg === 'Saved.' ? 'success' : 'warning'}><MessageBarBody>{msg}</MessageBarBody></MessageBar>}
      {blocks.length === 0 && <Caption1>No blocks yet — add a heading, text, or KQL query block.</Caption1>}
      {blocks.map((b, i) => (
        <div key={i} className={s.card}>
          <div className={s.head}>
            <Badge appearance="tint">{b.type}</Badge>
            <span className={s.spacer} />
            {b.type === 'query' && <Button size="small" icon={busy === i ? <Spinner size="tiny" /> : <Play20Regular />} onClick={() => runBlock(i)} disabled={busy !== null}>Run</Button>}
            <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" onClick={() => move(i, -1)} />
            <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" onClick={() => move(i, 1)} />
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove block" onClick={() => setBlocks((p) => p.filter((_, xi) => xi !== i))} />
          </div>
          {b.type === 'heading' ? (
            <Input value={b.content} onChange={(_, d) => setBlock(i, { ...b, content: d.value })} placeholder="Section heading" />
          ) : (
            <Textarea className={b.type === 'query' ? s.kql : undefined} value={b.content} onChange={(_, d) => setBlock(i, { ...b, content: d.value })}
              placeholder={b.type === 'query' ? 'Events | summarize count() by bin(Timestamp, 1h)' : 'Write narrative…'} resize="vertical" />
          )}
          {b.type === 'heading' && b.content && <Title3>{b.content}</Title3>}
          {b.type === 'query' && results[i] && (
            <div className={s.grid}>
              <Caption1>{results[i].rowCount} row(s) · {results[i].executionMs} ms</Caption1>
              <Table size="small" aria-label="Query block results">
                <TableHeader><TableRow>{results[i].columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                <TableBody>
                  {results[i].rows.slice(0, 100).map((row, ri) => (
                    <TableRow key={ri}>{results[i].columns.map((_, ci) => <TableCell key={ci}>{String((row as unknown[])[ci] ?? '')}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

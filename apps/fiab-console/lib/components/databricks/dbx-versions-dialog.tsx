'use client';

/**
 * DbxVersionsDialog (R4-DBX-3) — notebook revision history + side-by-side diff.
 *
 * Lists the SOURCE snapshots captured for this notebook (POSTed on every Save
 * plus manual "Save version") from `/api/items/databricks-notebook/[id]/versions`
 * — a real Cosmos-backed store. Selecting two versions renders a two-color
 * line diff (added / removed) with `diffLines`. "Restore" loads a version's
 * exact prior SOURCE back into the editor so the user can re-import it to the
 * workspace — matching the Databricks "Revision history → Restore" workflow.
 *
 * Real backend (no-vaporware.md); honest MessageBar on the Cosmos 503.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions, Button, Badge, Caption1, Spinner, Divider,
  Field, Input, Tooltip,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  History20Regular, ArrowClockwise16Regular, Save16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { diffLines, countChanges } from '@/lib/editors/databricks/dbx-line-diff';

interface NbVersion {
  id: string;
  savedAt: string;
  savedBy: string;
  description: string;
  source: string;
  language?: string;
}

const useStyles = makeStyles({
  wrap: { display: 'flex', gap: tokens.spacingHorizontalL, minHeight: '360px' },
  list: { width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, overflowY: 'auto', maxHeight: '60vh' },
  saveRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  row: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
  },
  rowSel: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  rowTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalXS },
  when: { fontSize: tokens.fontSizeBase100, color: tokens.colorNeutralForeground3 },
  diff: { flex: 1, minWidth: 0, overflow: 'auto', maxHeight: '60vh', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  diffLine: { display: 'flex', whiteSpace: 'pre', paddingLeft: tokens.spacingHorizontalXS, paddingRight: tokens.spacingHorizontalXS },
  gutter: { width: '48px', flexShrink: 0, color: tokens.colorNeutralForeground4, textAlign: 'right', paddingRight: tokens.spacingHorizontalS, userSelect: 'none' },
  add: { backgroundColor: tokens.colorStatusSuccessBackground1, color: tokens.colorStatusSuccessForeground1 },
  del: { backgroundColor: tokens.colorStatusDangerBackground1, color: tokens.colorStatusDangerForeground1 },
});

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(t).toLocaleString();
}

export interface DbxVersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  notebookPath: string | null;
  language: string;
  /** Current serialized SOURCE, for the manual "Save version". */
  currentSource: string;
  /** Load a version's SOURCE back into the editor. */
  onRestore: (source: string) => void;
}

export function DbxVersionsDialog({
  open, onOpenChange, itemId, notebookPath, language, currentSource, onRestore,
}: DbxVersionsDialogProps) {
  const s = useStyles();
  const [versions, setVersions] = useState<NbVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const base = `/api/items/databricks-notebook/${encodeURIComponent(itemId)}/versions`;

  const load = useCallback(async () => {
    if (!notebookPath) return;
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch(`${base}?path=${encodeURIComponent(notebookPath)}`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 || j?.code === 'cosmos_not_configured') { setGate(j?.error || 'Version history requires Cosmos DB.'); return; }
      if (!r.ok || !j?.ok) { setError(j?.error || `Failed to load versions (${r.status})`); return; }
      const list: NbVersion[] = j.versions || [];
      setVersions(list);
      if (list.length >= 2) setSelected([list[1].id, list[0].id]);
      else if (list.length === 1) setSelected([list[0].id]);
      else setSelected([]);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, notebookPath]);

  useEffect(() => {
    if (open) { setNotice(null); void load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const saveVersion = useCallback(async () => {
    if (!notebookPath) { setError('Save the notebook to the workspace first.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await clientFetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: notebookPath, language, source: currentSource, description: desc.trim() || 'Manual snapshot' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 || j?.code === 'cosmos_not_configured') { setGate(j?.error || 'Version history requires Cosmos DB.'); return; }
      if (!r.ok || !j?.ok) { setError(j?.error || `Save failed (${r.status})`); return; }
      setDesc(''); setNotice('Version saved.');
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, notebookPath, language, currentSource, desc, load]);

  const toggle = useCallback((id: string) => {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length < 2) return [...cur, id];
      return [cur[1], id];
    });
  }, []);

  // Order the two selections older→newer using the timeline (newest first).
  const [baseId, compareId] = useMemo(() => {
    if (selected.length < 2) return [selected[0], undefined] as const;
    const ia = versions.findIndex((v) => v.id === selected[0]);
    const ib = versions.findIndex((v) => v.id === selected[1]);
    return ia > ib ? [selected[0], selected[1]] as const : [selected[1], selected[0]] as const;
  }, [selected, versions]);

  const diff = useMemo(() => {
    if (!baseId || !compareId) return null;
    const a = versions.find((v) => v.id === baseId);
    const b = versions.find((v) => v.id === compareId);
    if (!a || !b) return null;
    return diffLines(a.source, b.source);
  }, [baseId, compareId, versions]);

  const selIndex = (id: string) => selected.indexOf(id);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '1100px', width: '96vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <History20Regular /> Notebook version history
            </span>
          </DialogTitle>
          <DialogContent>
            {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Version history unavailable</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
            {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            {notice && <MessageBar intent="success"><MessageBarBody>{notice}</MessageBarBody></MessageBar>}

            <div className={s.saveRow} style={{ marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM }}>
              <Field label="Save current as a version" style={{ flex: 1 }}>
                <Input value={desc} onChange={(_, d) => setDesc(d.value)} placeholder="Describe this snapshot (optional)" disabled={!notebookPath} />
              </Field>
              <Button appearance="primary" icon={<Save16Regular />} onClick={saveVersion} disabled={busy || !notebookPath}>Save version</Button>
            </div>

            <div className={s.wrap}>
              <div className={s.list}>
                <Caption1>Select two versions to compare ({selected.length}/2)</Caption1>
                {loading && <Spinner size="tiny" label="Loading…" />}
                {!loading && versions.length === 0 && !gate && (
                  <MessageBar intent="info"><MessageBarBody>No versions yet. Saving the notebook captures a version automatically.</MessageBarBody></MessageBar>
                )}
                {versions.map((v, i) => {
                  const si = selIndex(v.id);
                  return (
                    <div
                      key={v.id}
                      className={`${s.row} ${si >= 0 ? s.rowSel : ''}`}
                      role="button" tabIndex={0} aria-pressed={si >= 0}
                      onClick={() => toggle(v.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(v.id); } }}
                    >
                      <div className={s.rowTop}>
                        <span style={{ display: 'inline-flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                          {si >= 0 && <Badge appearance="filled" color="brand" size="small">{si + 1}</Badge>}
                          {i === 0 && <Badge appearance="tint" color="success" size="small">Current</Badge>}
                          <Caption1>{v.savedBy}</Caption1>
                        </span>
                        <span className={s.when} title={new Date(v.savedAt).toLocaleString()}>{relTime(v.savedAt)}</span>
                      </div>
                      <Caption1>{v.description || '(no description)'}</Caption1>
                      {i !== 0 && (
                        <Button
                          appearance="subtle" size="small" icon={<ArrowClockwise16Regular />}
                          style={{ alignSelf: 'flex-start' }}
                          onClick={(e) => { e.stopPropagation(); onRestore(v.source); setNotice('Version loaded into the editor — Save to re-import it to the workspace.'); }}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <Caption1>
                  {baseId && compareId
                    ? <>Diff — <Badge appearance="tint" color="danger" size="small">1 older</Badge> → <Badge appearance="tint" color="success" size="small">2 newer</Badge>{diff ? ` · ${countChanges(diff)} changed line(s)` : ''}</>
                    : 'Select two versions to see a line-by-line diff'}
                </Caption1>
                {diff && (
                  <div className={s.diff}>
                    {diff.map((l, idx) => (
                      <div key={idx} className={`${s.diffLine} ${l.op === 'added' ? s.add : l.op === 'removed' ? s.del : ''}`}>
                        <span className={s.gutter}>{l.op === 'added' ? '+' : l.op === 'removed' ? '-' : (l.oldNo ?? '')}</span>
                        <span>{l.text || ' '}</span>
                      </div>
                    ))}
                    {diff.length === 0 && <Caption1 style={{ padding: tokens.spacingVerticalM }}>Identical — no changes.</Caption1>}
                  </div>
                )}
              </div>
            </div>
            <Divider style={{ marginTop: tokens.spacingVerticalM }} />
            <Caption1>Restoring loads the selected SOURCE into the editor. Click Save to re-import it to the Databricks workspace.</Caption1>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button appearance="primary" onClick={() => void load()} disabled={loading}>Refresh</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

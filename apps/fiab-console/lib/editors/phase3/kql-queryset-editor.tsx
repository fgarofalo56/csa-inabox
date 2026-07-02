'use client';

/**
 * KqlQuerysetEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Azure-native by DEFAULT — wired live against the shared Loom ADX cluster via
 * the Console UAMI (Kusto raw REST: /v1/rest/query + /v1/rest/mgmt); no Fabric
 * is required. The editor's exclusive helpers (QuerySourceType / SavedQuery /
 * QuerysetState types + SAMPLE_QS) move with it. The shared KQL results /
 * visualization surface (KqlResultsPanel + the KqlResult model) is imported from
 * ./kql-results; the shared phase3 styles hook from ./styles. phase3-editors.tsx
 * re-exports KqlQuerysetEditor from a barrel line, so the registry resolves it
 * unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, Textarea,
  tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Save20Regular, Play20Regular,
  DocumentTable20Regular, DatabaseLink20Regular,
  Sparkle16Regular, Info16Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ItemEditorChrome } from '../item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { KqlResultsPanel, type KqlResult } from './kql-results';
import { useStyles } from './styles';

type QuerySourceType = 'adx' | 'log-analytics' | 'app-insights';
interface SavedQuery { title: string; kql: string; database?: string; sourceType?: QuerySourceType; }
interface QuerysetState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  queries?: SavedQuery[];
  error?: string;
  // Cross-service source binder — carried from the GET response.
  laGate?: { missing: string } | null;
  laProxyUri?: string | null;
  laWorkspaceName?: string | null;
}
const SAMPLE_QS: SavedQuery = { title: 'Smoke test', kql: 'print smoke = "ok", server_time = now()' };

export function KqlQuerysetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [qs, setQs] = useState<QuerysetState | null>(null);
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [draft, setDraft] = useState<SavedQuery>(SAMPLE_QS);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Cancel-running-query support — abort the in-flight fetch so the UI
  // doesn't block on a slow KQL. The Kusto cluster keeps running the
  // query server-side until completion, but we drop the response per
  // KQL Queryset Fabric-parity behavior. Real per-request cancellation
  // via X-Cancel-Request-Id is logged as TODO; this is the same level
  // Fabric ships in 2026-Q1.
  const abortRef = useRef<AbortController | null>(null);
  // Save-to-dashboard + Set-alert dialog state
  const [pinDlgOpen, setPinDlgOpen] = useState(false);
  const [pinTitle, setPinTitle] = useState('');
  const [pinDashboardId, setPinDashboardId] = useState('');
  const [pinDashboards, setPinDashboards] = useState<Array<{ id: string; name: string }>>([]);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [alertDlgOpen, setAlertDlgOpen] = useState(false);
  const [alertActivatorId, setAlertActivatorId] = useState('');
  const [alertName, setAlertName] = useState('');
  const [alertActivators, setAlertActivators] = useState<Array<{ id: string; name: string }>>([]);
  const [alertErr, setAlertErr] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);
  // Cross-service source binder — bind a Log Analytics / App Insights workspace
  // as the query source; federated queries run via the ADX cluster() proxy.
  const [srcDlgOpen, setSrcDlgOpen] = useState(false);
  const [draftSrcType, setDraftSrcType] = useState<QuerySourceType>('adx');
  // Share dialog — one-for-one with the ADX web UI / Fabric "Share" affordance:
  // copy the canonical item URL so a workspace member with view access can open
  // the same queryset. Loom RBAC governs who can actually open it.
  const [shareOpen, setShareOpen] = useState(false);
  // NL2KQL Copilot assist (generate / explain / fix) — inline build-assist over
  // the Loom AOAI deployment. State machine mirrors the Notebook assist edge.
  type AssistView = 'idle' | 'prompt' | 'loading' | 'suggestion' | 'explain-result';
  const [assistView, setAssistView] = useState<AssistView>('idle');
  const [assistPrompt, setAssistPrompt] = useState('');
  const [assistResult, setAssistResult] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const lastModeRef = useRef<'generate' | 'explain' | 'fix'>('generate');

  const load = useCallback(async () => {
    // Pre-save gate: /items/kql-queryset/new fires this before any record exists.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}`);
      const j = (await r.json()) as QuerysetState;
      setQs(j);
      const arr = j.queries || [];
      setQueries(arr);
      if (arr.length) { setSelectedIdx(0); setDraft(arr[0]); }
    } catch (e: any) {
      setQs({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Phase 4.5: refuse to silently clobber unsaved edits. If the user
  // selects a different saved query while the current draft is dirty,
  // ask before overwriting. This was the implicit data-loss bug
  // (run-then-edit-then-select-another clobber).
  const select = useCallback((idx: number) => {
    if (dirty && idx !== selectedIdx) {
      const proceed = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes to the current query?')
        : true;
      if (!proceed) return;
    }
    setSelectedIdx(idx); setDraft(queries[idx] || SAMPLE_QS); setDirty(false); setResult(null);
    setSaveErr(null); setSaveMsg(null);
  }, [queries, dirty, selectedIdx]);

  const addQuery = useCallback(() => {
    // Phase 4.5 — functional setQueries so back-to-back clicks before
    // re-render cannot drop entries. Carry the dirty draft of the
    // currently-selected query into the queries[] array before appending
    // — otherwise the new entry replaces the user's unsaved edit.
    setQueries((prev) => {
      const carried = prev.map((q, i) => i === selectedIdx ? draft : q);
      const next = [...carried, { title: `Query ${carried.length + 1}`, kql: '' }];
      setSelectedIdx(next.length - 1);
      setDraft(next[next.length - 1]);
      return next;
    });
    setDirty(true); setSaveMsg(null);
  }, [selectedIdx, draft]);

  const deleteQuery = useCallback((idx: number) => {
    // Phase 4.5 — functional setter so multiple deletes in flight don't
    // operate on a stale array.
    setQueries((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const newIdx = Math.max(0, Math.min(idx - 1, next.length - 1));
      setSelectedIdx(newIdx);
      setDraft(next[newIdx] || SAMPLE_QS);
      return next;
    });
    setDirty(true); setSaveMsg(null);
  }, []);

  const saveAll = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    // Capture the queries snapshot WITH the current draft folded in at
    // click time. If a Run is in flight when save fires, runs only read
    // draft.kql — they never write back to queries[] — so the merge here
    // is the authoritative source.
    const updated = queries.map((q, i) => i === selectedIdx ? draft : q);
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: updated }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
        return;
      }
      // Server-confirmed queries. Adopt them, but preserve the user's
      // selected index — server may reorder/normalize but in practice the
      // PUT echoes back the same array we sent.
      const serverQueries: SavedQuery[] = j.queries || updated;
      setQueries(serverQueries);
      // Re-sync draft from the saved row so dirty=false is honest.
      const savedRow = serverQueries[selectedIdx] || serverQueries[0] || SAMPLE_QS;
      setDraft(savedRow);
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, queries, selectedIdx, draft]);

  // Ctrl+S / Cmd+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving && queries.length) saveAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, queries.length, saveAll]);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    // Pin the kql/database we're sending at click-time so any subsequent
    // edits the user makes mid-run cannot influence what was executed.
    const payload = { kql: draft.kql, database: draft.database, sourceType: draft.sourceType || 'adx' };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setResult({ ok: false, error: 'Cancelled by user' });
      } else {
        setResult({ ok: false, error: e?.message || String(e) });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [id, draft]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Pin to dashboard — list dashboards, then PUT the dashboard with a new tile.
  const openPinDialog = useCallback(async () => {
    setPinDlgOpen(true);
    setPinErr(null);
    setPinTitle(draft.title || 'Pinned from queryset');
    try {
      const r = await fetch('/api/items?type=kql-dashboard');
      const j = await r.json();
      const arr: Array<{ id: string; displayName?: string; name?: string }> = j?.items || j?.value || [];
      const dashboards = arr.map((d) => ({ id: d.id, name: d.displayName || d.name || d.id }));
      setPinDashboards(dashboards);
      if (dashboards[0]) setPinDashboardId(dashboards[0].id);
    } catch (e: any) {
      setPinErr(e?.message || String(e));
    }
  }, [draft.title]);

  const submitPin = useCallback(async () => {
    if (!pinDashboardId) { setPinErr('Choose a dashboard'); return; }
    if (!draft.kql.trim()) { setPinErr('Query is empty'); return; }
    setPinBusy(true); setPinErr(null);
    try {
      // Read current tiles + append; PUT the new array.
      const cur = await fetch(`/api/items/kql-dashboard/${pinDashboardId}`).then((r) => r.json());
      const tiles = Array.isArray(cur?.tiles) ? cur.tiles : [];
      tiles.push({ title: pinTitle || draft.title || 'Pinned tile', kql: draft.kql, viz: 'table', database: draft.database });
      const r = await fetch(`/api/items/kql-dashboard/${pinDashboardId}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tiles }),
      });
      const j = await r.json();
      if (!j.ok) { setPinErr(j.error || 'pin failed'); return; }
      setPinDlgOpen(false);
    } catch (e: any) {
      setPinErr(e?.message || String(e));
    } finally {
      setPinBusy(false);
    }
  }, [pinDashboardId, pinTitle, draft]);

  // Set alert (Activator rule from query). List activators, post rule.
  const openAlertDialog = useCallback(async () => {
    setAlertDlgOpen(true);
    setAlertErr(null);
    setAlertName(`alert-${(draft.title || 'queryset').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    try {
      const r = await fetch('/api/items?type=activator');
      const j = await r.json();
      const arr: Array<{ id: string; displayName?: string; name?: string }> = j?.items || j?.value || [];
      const acts = arr.map((d) => ({ id: d.id, name: d.displayName || d.name || d.id }));
      setAlertActivators(acts);
      if (acts[0]) setAlertActivatorId(acts[0].id);
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    }
  }, [draft.title]);

  const submitAlert = useCallback(async () => {
    if (!alertActivatorId) { setAlertErr('Choose an Activator'); return; }
    if (!draft.kql.trim()) { setAlertErr('Query is empty'); return; }
    setAlertBusy(true); setAlertErr(null);
    try {
      const r = await fetch(`/api/items/activator/${alertActivatorId}/rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: alertName,
          trigger: { kind: 'kql', kql: draft.kql, database: draft.database },
          action: { kind: 'noop', note: 'Pinned from KQL Queryset — choose an action template in Activator' },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setAlertErr(j.error || 'create-rule failed'); return; }
      setAlertDlgOpen(false);
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    } finally {
      setAlertBusy(false);
    }
  }, [alertActivatorId, alertName, draft]);

  const callAssist = useCallback(async (mode: 'generate' | 'explain' | 'fix') => {
    lastModeRef.current = mode;
    setAssistView('loading'); setAssistError(null);
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/assist`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          kql: draft.kql,
          prompt: mode === 'generate' ? assistPrompt : undefined,
          errorText: mode === 'fix' ? (result?.error || '') : undefined,
          database: draft.database || qs?.database || qs?.defaultDatabase,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setAssistView('idle');
        setAssistError(j?.code === 'no_aoai'
          ? `KQL Copilot not configured: ${j?.hint || 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.'}`
          : (j?.error || 'AI assist failed'));
        return;
      }
      setAssistResult(j.result);
      setAssistView(mode === 'explain' ? 'explain-result' : 'suggestion');
    } catch (e: any) {
      setAssistView('idle');
      setAssistError(e?.message || String(e));
    }
  }, [id, draft, assistPrompt, result, qs]);

  const canRun = !loading && !!draft.kql.trim();
  const canSave = !saving && queries.length > 0 && dirty;
  const canPinAlert = !!draft.kql.trim();
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun },
        { label: 'Cancel', onClick: loading ? cancel : undefined, disabled: !loading },
      ]},
      { label: 'Save', actions: [
        { label: saving ? 'Saving…' : 'Save query', onClick: canSave ? saveAll : undefined, disabled: !canSave },
        { label: 'Save to dashboard', onClick: canPinAlert ? openPinDialog : undefined, disabled: !canPinAlert },
        { label: 'Set alert', onClick: canPinAlert ? openAlertDialog : undefined, disabled: !canPinAlert },
      ]},
      { label: 'Share', actions: [
        { label: 'Copy link', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [loading, canRun, run, cancel, saving, canSave, saveAll, canPinAlert, openPinDialog, openAlertDialog]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacingVerticalS}}>
            <Subtitle2>Queries</Subtitle2>
            <Button size="small" icon={<Add20Regular />} onClick={addQuery} appearance="subtle">New</Button>
          </div>
          <Tree aria-label="Saved queries">
            {queries.length === 0 && <Caption1>No queries yet. Click <strong>New</strong>.</Caption1>}
            {queries.map((q, i) => (
              <TreeItem key={i} itemType="leaf" value={`q-${i}`} onClick={() => select(i)}>
                <TreeItemLayout
                  iconBefore={<DocumentTable20Regular />}
                  aside={
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e: any) => { e.stopPropagation(); deleteQuery(i); }} aria-label="Delete query" />
                  }
                >
                  {i === selectedIdx ? <strong>{q.title}</strong> : q.title}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Input value={draft.title} onChange={(_: unknown, d: any) => { setDraft({ ...draft, title: d.value }); setDirty(true); }} placeholder="Query title" style={{ minWidth: 220 }} />
            <Caption1>db: <strong>{draft.database || qs?.database || qs?.defaultDatabase || 'loomdb-default'}</strong></Caption1>
            <Button
              size="small"
              appearance="outline"
              icon={<DatabaseLink20Regular />}
              onClick={() => { setDraftSrcType(draft.sourceType || 'adx'); setSrcDlgOpen(true); }}
            >
              Source{draft.sourceType && draft.sourceType !== 'adx' ? ` (${draft.sourceType})` : ''}
            </Button>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || queries.length === 0 || !dirty} onClick={saveAll}>
              {saving ? 'Saving…' : 'Save (Ctrl+S)'}
            </Button>
            <Tooltip content="Generate KQL from a description" relationship="label">
              <Button size="small" appearance="subtle" icon={<Sparkle16Regular />}
                disabled={assistView === 'loading'}
                onClick={() => { setAssistResult(null); setAssistError(null); setAssistView('prompt'); }}
                aria-label="Ask Copilot to generate KQL">Ask Copilot</Button>
            </Tooltip>
            <Tooltip content="Explain this query" relationship="label">
              <Button size="small" appearance="subtle" icon={<Info16Regular />}
                disabled={!draft.kql.trim() || assistView === 'loading'}
                onClick={() => callAssist('explain')}
                aria-label="Explain KQL">Explain</Button>
            </Tooltip>
            {result && !result.ok && result.error && (
              <Tooltip content="Fix the KQL error" relationship="label">
                <Button size="small" appearance="subtle" icon={<Wrench16Regular />}
                  disabled={assistView === 'loading'}
                  onClick={() => callAssist('fix')}
                  aria-label="Fix KQL error">
                  {assistView === 'loading' && lastModeRef.current === 'fix' ? 'Fixing…' : 'Fix'}
                </Button>
              </Tooltip>
            )}
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !draft.kql.trim()} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run'}
            </Button>
          </div>
          {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
          {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
          {qs && !qs.ok && <MessageBar intent="error"><MessageBarBody>{qs.error}</MessageBarBody></MessageBar>}
          <MonacoTextarea
            value={draft.kql}
            onChange={(v) => { setDraft({ ...draft, kql: v }); setDirty(true); }}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query"
          />
          {/* NL prompt input — generate mode */}
          {assistView === 'prompt' && (
            <div className={s.assistBar}>
              <Input size="small" autoFocus style={{ flex: 1 }}
                placeholder="Describe the query (e.g. 'count events by source in the last hour')…"
                value={assistPrompt}
                onChange={(_: unknown, d: any) => setAssistPrompt(d.value)}
                onKeyDown={(e: any) => {
                  if (e.key === 'Enter' && assistPrompt.trim()) callAssist('generate');
                  if (e.key === 'Escape') setAssistView('idle');
                }}
                aria-label="AI KQL generation prompt" />
              <Button size="small" appearance="primary"
                disabled={!assistPrompt.trim()}
                onClick={() => callAssist('generate')}>Generate</Button>
              <Button size="small" onClick={() => { setAssistView('idle'); setAssistPrompt(''); }}>Cancel</Button>
            </div>
          )}
          {/* Loading spinner */}
          {assistView === 'loading' && (
            <div className={s.assistBar}>
              <Spinner size="tiny" labelPosition="after"
                label={lastModeRef.current === 'generate' ? 'Generating…' : lastModeRef.current === 'explain' ? 'Explaining…' : 'Fixing…'} />
            </div>
          )}
          {/* Suggestion / explanation result */}
          {(assistView === 'suggestion' || assistView === 'explain-result') && assistResult && (
            <MessageBar intent={assistView === 'explain-result' ? 'info' : 'success'} style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>
                <pre className={s.assistResult}>{assistResult}</pre>
              </MessageBarBody>
              <MessageBarActions>
                {assistView === 'suggestion' && (
                  <Button size="small" appearance="primary"
                    onClick={() => { setDraft({ ...draft, kql: assistResult }); setDirty(true); setAssistView('idle'); setAssistResult(null); setAssistPrompt(''); }}>
                    Apply
                  </Button>
                )}
                <Button size="small" onClick={() => { setAssistView('idle'); setAssistResult(null); }}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {/* Honest config gate / error */}
          {assistError && (
            <MessageBar intent="error" style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>{assistError}</MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => setAssistError(null)}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          <KqlResultsPanel result={result} loading={loading} itemId={id} itemType="kql-queryset" />

          <Dialog open={pinDlgOpen} onOpenChange={(_: unknown, d: any) => setPinDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save query to KQL Dashboard</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <Caption1>Tile title</Caption1>
                    <Input value={pinTitle} onChange={(_: unknown, d: any) => setPinTitle(d.value)} />
                    <Caption1>Dashboard</Caption1>
                    <Select value={pinDashboardId} onChange={(_: unknown, d: any) => setPinDashboardId(d.value)}>
                      <option value="">(select…)</option>
                      {pinDashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    {pinErr && <MessageBar intent="error"><MessageBarBody>{pinErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPinDlgOpen(false)} disabled={pinBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitPin} disabled={pinBusy}>{pinBusy ? 'Saving…' : 'Pin'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={alertDlgOpen} onOpenChange={(_: unknown, d: any) => setAlertDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create Activator rule from query</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <Caption1>Rule name</Caption1>
                    <Input value={alertName} onChange={(_: unknown, d: any) => setAlertName(d.value)} />
                    <Caption1>Activator</Caption1>
                    <Select value={alertActivatorId} onChange={(_: unknown, d: any) => setAlertActivatorId(d.value)}>
                      <option value="">(select…)</option>
                      {alertActivators.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    {alertErr && <MessageBar intent="error"><MessageBarBody>{alertErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setAlertDlgOpen(false)} disabled={alertBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitAlert} disabled={alertBusy}>{alertBusy ? 'Creating…' : 'Create rule'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ── Cross-service source binding dialog ── */}
          <Dialog open={srcDlgOpen} onOpenChange={(_: unknown, d: any) => setSrcDlgOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 560 }}>
              <DialogBody>
                <DialogTitle>Bind query source</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <Caption1>
                      Select the data source for this query. Log Analytics and Application
                      Insights sources run as federated cross-cluster queries from the ADX
                      cluster using the KQL <code>cluster()</code> proxy — join them with ADX
                      tables via <code>union</code> or an explicit join.
                    </Caption1>

                    <Field label="Source type">
                      <Select
                        value={draftSrcType}
                        onChange={(_: unknown, d: any) => setDraftSrcType(d.value as QuerySourceType)}
                      >
                        <option value="adx">Azure Data Explorer (ADX) — default</option>
                        <option value="log-analytics">Log Analytics workspace</option>
                        <option value="app-insights">Application Insights</option>
                      </Select>
                    </Field>

                    {/* Honest gate: no LA workspace configured */}
                    {draftSrcType !== 'adx' && qs?.laGate && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>No workspace configured</MessageBarTitle>
                          Set <code>{qs.laGate.missing}</code> in the container environment
                          (wired automatically when <code>adxEnabled = true</code> in{' '}
                          <code>platform/fiab/bicep/modules/admin-plane/main.bicep</code>). The
                          Console UAMI also needs Log Analytics Reader on the workspace
                          (granted by <code>monitoring.bicep</code> <code>consoleLaReader</code>).
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* Available: show the proxy URI and a copy-ready KQL snippet */}
                    {draftSrcType === 'log-analytics' && !qs?.laGate && qs?.laProxyUri && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                        <Caption1>Workspace: <strong>{qs.laWorkspaceName}</strong></Caption1>
                        <Caption1>Cross-cluster KQL snippet — paste into your query:</Caption1>
                        <Textarea
                          readOnly
                          value={
                            `// Join ADX + Log Analytics\n` +
                            `let LA = cluster('${qs.laProxyUri}').database('${qs.laWorkspaceName}');\n` +
                            `union MyAdxTable, LA.Heartbeat\n| take 10`
                          }
                          rows={5}
                          style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200}}
                        />
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          The UAMI holds Log Analytics Reader on this workspace. Queries run via
                          ADX <code>/v1/rest/query</code> — no separate token needed.
                        </Caption1>
                      </div>
                    )}

                    {draftSrcType === 'app-insights' && !qs?.laGate && qs?.laProxyUri && (
                      <Caption1>
                        Application Insights components in the same subscription are referenced
                        with{' '}
                        <code>cluster('https://adx.monitor.azure.com/subscriptions/.../providers/microsoft.insights/components/&lt;name&gt;').database('&lt;name&gt;')</code>.
                        Substitute the component resource ID, then <code>union</code> with ADX tables.
                      </Caption1>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSrcDlgOpen(false)}>Cancel</Button>
                  <Button
                    appearance="primary"
                    disabled={draftSrcType !== 'adx' && !!qs?.laGate}
                    onClick={() => {
                      setDraft({ ...draft, sourceType: draftSrcType === 'adx' ? undefined : draftSrcType });
                      setDirty(true);
                      setSrcDlgOpen(false);
                    }}
                  >
                    Bind
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Share queryset</DialogTitle>
                <DialogContent>
                  <Caption1>Anyone with access to this Loom item can open it. Permissions are managed via the workspace item ACL (Loom RBAC).</Caption1>
                  <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <Caption1>Canonical URL</Caption1>
                    <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly aria-label="Queryset URL" />
                    <Button appearance="outline" onClick={() => { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(window.location.href).catch(() => {}); }}>Copy URL</Button>
                    <Caption1>To grant another user access, add them to this item via the workspace permissions page. Tenant-wide sharing is not enabled in this deployment.</Caption1>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

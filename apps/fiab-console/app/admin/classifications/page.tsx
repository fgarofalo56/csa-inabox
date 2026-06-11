'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Textarea, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete20Regular, ArrowSync24Regular, Info20Regular, CloudSync24Regular, Play24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface ClassificationRule {
  id: string;
  name: string;
  matchStrategy: 'column-name-regex' | 'data-regex' | 'dictionary';
  matchValue: string;
  classification: string;
  createdAt: string;
  createdBy: string;
}

interface PurviewSyncState {
  purviewConfigured: boolean;
  account: string | null;
  synced: boolean;
  ruleCount: number;
  scanRulesets?: { name: string; kind: string }[];
  error?: string;
  hint?: { missingEnvVar?: string; bicepModule?: string; followUp?: string };
}

interface ScanSource { id: string; name: string; kind?: string }
interface ScanDef { id: string; name: string; kind?: string }

const useStyles = makeStyles({
  explainer: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-start',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '12px' },
  banner: { marginBottom: tokens.spacingVerticalL },
});

const CLASSIFICATION_OPTIONS = ['PII', 'PHI', 'PCI', 'Confidential', 'Internal', 'Public', 'Restricted', 'Other'];
const MATCH_STRATEGY_OPTIONS = [
  { label: 'Column name regex', value: 'column-name-regex' },
  { label: 'Data regex', value: 'data-regex' },
  { label: 'Dictionary', value: 'dictionary' },
];

export default function ClassificationsPage() {
  const s = useStyles();
  const [rules, setRules] = useState<ClassificationRule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMatchStrategy, setNewMatchStrategy] = useState('column-name-regex');
  const [newMatchValue, setNewMatchValue] = useState('');
  const [newClassification, setNewClassification] = useState('PII');
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Purview sync + scan trigger
  const [purview, setPurview] = useState<{ configured: boolean; account: string | null } | null>(null);
  const [sync, setSync] = useState<PurviewSyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/admin/classifications');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setRules(j.rules || []);
      setPurview(j.purview || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!newName.trim() || !newMatchValue.trim()) { setActionErr('Name and match value required'); return; }
    setCreating(true);
    setActionErr(null);
    try {
      const r = await fetch('/api/admin/classifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          matchStrategy: newMatchStrategy,
          matchValue: newMatchValue.trim(),
          classification: newClassification,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setRules(j.rules || []);
      if (j.purview) setSync(j.purview);
      setCreateOpen(false);
      setNewName('');
      setNewMatchStrategy('column-name-regex');
      setNewMatchValue('');
      setNewClassification('PII');
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this classification rule? It will be removed from Microsoft Purview and will not apply to future scans.')) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/admin/classifications?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setRules(j.rules || []);
      if (j.purview) setSync(j.purview);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  async function syncToPurview() {
    setSyncing(true);
    setActionErr(null);
    try {
      const r = await fetch('/api/admin/classifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ syncOnly: true }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      if (j.purview) setSync(j.purview);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setSyncing(false); }
  }

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = rules || [];
    if (!f) return all;
    return all.filter((r) => r.name.toLowerCase().includes(f) || r.classification.toLowerCase().includes(f) || r.matchStrategy.toLowerCase().includes(f) || r.matchValue.toLowerCase().includes(f) || (r.createdBy || '').toLowerCase().includes(f));
  }, [rules, q]);

  const columns: LoomColumn<ClassificationRule>[] = useMemo(() => [
    { key: 'name', label: 'Rule name', width: 180, getValue: (r) => r.name, render: (r) => <strong>{r.name}</strong> },
    { key: 'classification', label: 'Classification', width: 140, getValue: (r) => r.classification, render: (r) => <Badge appearance='tint' color='brand' size='small'>{r.classification}</Badge> },
    { key: 'matchStrategy', label: 'Match strategy', width: 160, getValue: (r) => r.matchStrategy, render: (r) => <Caption1>{MATCH_STRATEGY_OPTIONS.find((m) => m.value === r.matchStrategy)?.label || r.matchStrategy}</Caption1> },
    { key: 'matchValue', label: 'Pattern / value', width: 240, getValue: (r) => r.matchValue, render: (r) => <code style={{ fontSize: '11px' }}>{r.matchValue}</code> },
    { key: 'createdBy', label: 'Created by', width: 160, render: (r) => <Caption1>{r.createdBy}</Caption1> },
    { key: 'actions', label: '', width: 110, sortable: false, filterable: false, render: (r) => <Button size='small' appearance='subtle' icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); remove(r.id); }} aria-label={`Delete rule ${r.name}`}>Delete</Button> },
  ], []);

  const purviewConfigured = purview?.configured ?? false;

  return (
    <AdminShell sectionTitle='Classifications'>
      <Section title='About classification rules'>
        <div className={s.explainer}>
          <Info20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: '2px' }} />
          <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5 }}>
            Classification rules detect sensitive-info types and apply classifications (PII, PHI, PCI, Confidential, etc.) to catalog items on scan. Each rule is pushed to Microsoft Purview as a <strong>custom classification rule</strong> and rolled into a <strong>custom scan rule set</strong>, so it actually classifies data when a scan runs. Choose a <strong>match strategy</strong>:
            <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px' }}>
              <li><strong>Column name regex:</strong> Match column names (e.g., <code>.*email.*</code>)</li>
              <li><strong>Data regex:</strong> Match data values (e.g., <code>{'\\d{3}-\\d{2}-\\d{4}'}</code> for SSN)</li>
              <li><strong>Dictionary:</strong> Match against a word list (comma-separated)</li>
            </ul>
          </Body1>
        </div>
      </Section>

      {/* Live Purview sync state — replaces the old static "applied on next scan" banner. */}
      {!purviewConfigured ? (
        <MessageBar intent='warning' className={s.banner}>
          <MessageBarBody>
            <MessageBarTitle>Microsoft Purview not provisioned</MessageBarTitle>
            Rules are saved to the Loom catalog. To push them as Purview custom classification rules and run scans, set <code>LOOM_PURVIEW_ACCOUNT</code> (deployed by <code>platform/fiab/bicep/modules/admin-plane/catalog.bicep</code>) and grant the Console UAMI <strong>Data Source Administrator</strong> on the root collection.
          </MessageBarBody>
        </MessageBar>
      ) : sync?.error ? (
        <MessageBar intent='error' className={s.banner}>
          <MessageBarBody>
            <MessageBarTitle>Purview sync failed</MessageBarTitle>
            {sync.error} — verify the Console UAMI holds <strong>Data Source Administrator</strong> on <code>{purview?.account}</code> (root collection). Rules are still saved in the Loom catalog.
          </MessageBarBody>
        </MessageBar>
      ) : sync?.synced ? (
        <MessageBar intent='success' className={s.banner}>
          <MessageBarBody>
            <MessageBarTitle>Synced to Microsoft Purview</MessageBarTitle>
            {sync.ruleCount} classification rule(s) pushed to <code>{sync.account}</code>{sync.scanRulesets?.length ? ` and included in scan rule sets: ${sync.scanRulesets.map((rs) => rs.name).join(', ')}` : ''}. Use <strong>Run scan now</strong> to apply them. Existing classifications on assets are not removed retroactively.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <MessageBar intent='info' className={s.banner}>
          <MessageBarBody>
            <MessageBarTitle>Connected to Microsoft Purview</MessageBarTitle>
            Account <code>{purview?.account}</code>. Adding or deleting a rule syncs it to Purview automatically; use <strong>Sync to Purview</strong> to re-push the full taxonomy, then <strong>Run scan now</strong>.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && <MessageBar intent='error' className={s.banner}><MessageBarBody><MessageBarTitle>Could not load rules</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent='error' className={s.banner}><MessageBarBody>{actionErr}</MessageBarBody></MessageBar>}

      <Section
        title='Classification rules'
        actions={
          <>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button icon={<CloudSync24Regular />} onClick={syncToPurview} disabled={syncing || !purviewConfigured || !(rules && rules.length)} title={!purviewConfigured ? 'Set LOOM_PURVIEW_ACCOUNT to enable' : 'Push all rules to Microsoft Purview'}>{syncing ? 'Syncing…' : 'Sync to Purview'}</Button>
            <Button icon={<Play24Regular />} onClick={() => setScanOpen(true)} disabled={!purviewConfigured} title={!purviewConfigured ? 'Set LOOM_PURVIEW_ACCOUNT to enable' : 'Run a Purview scan now'}>Run scan now</Button>
            <Button appearance='primary' icon={<Add24Regular />} onClick={() => setCreateOpen(true)}>Add rule</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder='Search by name, classification, pattern...' />
        {loading && !error ? <Spinner label='Loading rules...' /> : <LoomDataTable columns={columns} rows={filtered} getRowId={(r) => r.id} empty={q ? `No rules match "${q}".` : 'No classification rules defined yet. Click "Add rule" to create your first one.'} ariaLabel='Classification rules' />}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add classification rule</DialogTitle>
            <DialogContent>
              <div className={s.field}>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Rule name</Caption1><Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder='e.g. Email columns' style={{ width: '100%' }} /></div>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Match strategy</Caption1><Dropdown value={MATCH_STRATEGY_OPTIONS.find((m) => m.value === newMatchStrategy)?.label || newMatchStrategy} selectedOptions={[newMatchStrategy]} onOptionSelect={(_, d) => setNewMatchStrategy(d.optionValue || 'column-name-regex')} style={{ width: '100%' }}>{MATCH_STRATEGY_OPTIONS.map((opt) => <Option key={opt.value} value={opt.value}>{opt.label}</Option>)}</Dropdown></div>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Pattern or value{newMatchStrategy === 'column-name-regex' && ' (regex for column names)'}{newMatchStrategy === 'data-regex' && ' (regex for data)'}{newMatchStrategy === 'dictionary' && ' (comma-separated words)'}</Caption1><Textarea value={newMatchValue} onChange={(_, d) => setNewMatchValue(d.value)} placeholder={newMatchStrategy === 'column-name-regex' ? '.*email.*' : newMatchStrategy === 'data-regex' ? '\\d{3}-\\d{2}-\\d{4}' : 'word1, word2, word3'} resize='vertical' style={{ width: '100%' }} /></div>
                <div><Caption1 style={{ display: 'block', marginBottom: '4px' }}>Classification</Caption1><Dropdown value={newClassification} selectedOptions={[newClassification]} onOptionSelect={(_, d) => setNewClassification(d.optionValue || 'PII')} style={{ width: '100%' }}>{CLASSIFICATION_OPTIONS.map((opt) => <Option key={opt} value={opt}>{opt}</Option>)}</Dropdown></div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance='secondary' onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance='primary' onClick={create} disabled={creating || !newName.trim() || !newMatchValue.trim()}>{creating ? 'Creating...' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <RunScanDialog open={scanOpen} onClose={() => setScanOpen(false)} account={purview?.account || null} />
    </AdminShell>
  );
}

/**
 * Run scan now — picks a registered Purview data source + a scan defined on it
 * (both loaded live from /api/governance/scans) and triggers a real scan run.
 * Mirrors the Purview portal "Scans → Run now" action. No JSON freeform; every
 * input is a guided Fluent Dropdown.
 */
function RunScanDialog({ open, onClose, account }: { open: boolean; onClose: () => void; account: string | null }) {
  const [sources, setSources] = useState<ScanSource[] | null>(null);
  const [scans, setScans] = useState<ScanDef[] | null>(null);
  const [source, setSource] = useState('');
  const [scan, setScan] = useState('');
  const [loadingSrc, setLoadingSrc] = useState(false);
  const [loadingScans, setLoadingScans] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error' | 'warning'; text: string } | null>(null);

  const loadSources = useCallback(async () => {
    setLoadingSrc(true);
    setMsg(null);
    try {
      const r = await fetch('/api/governance/scans');
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'warning', text: j.error || `HTTP ${r.status}` }); setSources([]); return; }
      setSources(j.sources || []);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); setSources([]); }
    finally { setLoadingSrc(false); }
  }, []);

  useEffect(() => {
    if (open) { setSource(''); setScan(''); setScans(null); setMsg(null); loadSources(); }
  }, [open, loadSources]);

  const loadScans = useCallback(async (src: string) => {
    if (!src) { setScans(null); return; }
    setLoadingScans(true);
    setScan('');
    try {
      const r = await fetch(`/api/governance/scans?source=${encodeURIComponent(src)}`);
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'warning', text: j.error || `HTTP ${r.status}` }); setScans([]); return; }
      setScans(j.scans || []);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); setScans([]); }
    finally { setLoadingScans(false); }
  }, []);

  async function run() {
    if (!source || !scan) { setMsg({ intent: 'warning', text: 'Pick a data source and a scan.' }); return; }
    setRunning(true);
    setMsg(null);
    try {
      const r = await fetch('/api/governance/scans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ run: true, source, scan }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setMsg({ intent: 'success', text: `Scan run triggered${j.runId ? ` (run ${j.runId})` : ''} on "${scan}".` });
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setRunning(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Run a Purview scan</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>
                Triggers a real scan run on a registered Microsoft Purview data source{account ? ` (${account})` : ''}. The scan applies the classification rules included in its scan rule set.
              </Caption1>
              <div>
                <Caption1 style={{ display: 'block', marginBottom: '4px' }}>Data source</Caption1>
                <Dropdown
                  placeholder={loadingSrc ? 'Loading sources…' : (sources && sources.length === 0 ? 'No registered data sources' : 'Select a data source')}
                  value={source}
                  selectedOptions={source ? [source] : []}
                  onOptionSelect={(_, d) => { const v = d.optionValue || ''; setSource(v); loadScans(v); }}
                  disabled={loadingSrc || !(sources && sources.length)}
                  style={{ width: '100%' }}
                >
                  {(sources || []).map((src) => <Option key={src.id || src.name} value={src.name}>{src.kind ? `${src.name} (${src.kind})` : src.name}</Option>)}
                </Dropdown>
              </div>
              <div>
                <Caption1 style={{ display: 'block', marginBottom: '4px' }}>Scan</Caption1>
                <Dropdown
                  placeholder={!source ? 'Pick a data source first' : (loadingScans ? 'Loading scans…' : (scans && scans.length === 0 ? 'No scans defined on this source' : 'Select a scan'))}
                  value={scan}
                  selectedOptions={scan ? [scan] : []}
                  onOptionSelect={(_, d) => setScan(d.optionValue || '')}
                  disabled={!source || loadingScans || !(scans && scans.length)}
                  style={{ width: '100%' }}
                >
                  {(scans || []).map((sc) => <Option key={sc.id || sc.name} value={sc.name}>{sc.name}</Option>)}
                </Dropdown>
              </div>
              {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance='secondary' onClick={onClose}>Close</Button>
            <Button appearance='primary' icon={<Play24Regular />} onClick={run} disabled={running || !source || !scan}>{running ? 'Triggering…' : 'Run scan'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

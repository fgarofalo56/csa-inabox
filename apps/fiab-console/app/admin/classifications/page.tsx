'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Subtitle2, Input, Textarea, Button,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete20Regular, ArrowSync24Regular, CloudSync24Regular, Play24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';

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

interface SystemClassification { name: string; classificationName: string; displayName: string; description?: string }
interface SystemGroup { id: string; label: string; description: string; classifications: SystemClassification[] }

const useStyles = makeStyles({
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  banner: { marginBottom: tokens.spacingVerticalL },
  explainerList: { marginTop: tokens.spacingVerticalS, marginBottom: 0, marginLeft: 0, marginRight: 0, paddingLeft: tokens.spacingHorizontalXL },
  // Wrap long no-space tokens (env-var names, bicep paths, error strings) inside
  // MessageBars so they break onto the next line instead of forcing horizontal
  // overflow on narrow viewports.
  bannerBody: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  groupList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  groupHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  groupDesc: { color: tokens.colorNeutralForeground3 },
  chipWrap: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
});

const CLASSIFICATION_OPTIONS = ['PII', 'PHI', 'PCI', 'Confidential', 'Internal', 'Public', 'Restricted', 'Other'];
const MATCH_STRATEGY_OPTIONS = [
  { label: 'Column name regex', value: 'column-name-regex' },
  { label: 'Data regex', value: 'data-regex' },
  { label: 'Dictionary', value: 'dictionary' },
];

export default function ClassificationsPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
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

  // Built-in (Purview system) classifications — read-only STATIC catalog +
  // dropdown source. Served from a no-network reference list, so this load
  // never times out and is the RELIABLE provisioned signal for the page.
  const [systemGroups, setSystemGroups] = useState<SystemGroup[] | null>(null);
  const [systemErr, setSystemErr] = useState<string | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemConfigured, setSystemConfigured] = useState<boolean | null>(null);
  const [systemAccount, setSystemAccount] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The custom-rules load reads Cosmos (and can be cold) — give the
      // browser→BFF hop a generous ceiling (25s) so a slow-but-healthy backend
      // doesn't surface as a 6s "timed out". A timeout here is now an honest,
      // retryable "could not load rules" — it NO LONGER implies "not
      // provisioned" because the provisioned signal comes from loadSystem().
      const r = await clientFetch('/api/admin/classifications', undefined, 25000);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setRules(j.rules || []);
      setPurview(j.purview || null);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadSystem = useCallback(async () => {
    setSystemLoading(true);
    setSystemErr(null);
    try {
      const r = await clientFetch('/api/governance/classifications/system');
      const j = await r.json();
      if (!j.ok) { setSystemErr(j.error || `HTTP ${r.status}`); setSystemGroups([]); return; }
      setSystemGroups(j.groups || []);
      // Reliable, no-network provisioned signal (env-var presence) used by the
      // top banner so a slow custom-rules load can't show a false "not
      // provisioned" warning when LOOM_PURVIEW_ACCOUNT IS set.
      setSystemConfigured(!!j.configured);
      setSystemAccount(j.account || null);
    } catch (e: any) { setSystemErr(e?.message || String(e)); setSystemGroups([]); }
    finally { setSystemLoading(false); }
  }, []);

  useEffect(() => { load(); loadSystem(); }, [load, loadSystem]);

  const systemFlat = useMemo(
    () => (systemGroups || []).flatMap((g) => g.classifications),
    [systemGroups],
  );
  const classDisplay = systemFlat.find((c) => c.classificationName === newClassification)?.displayName || newClassification;

  async function create() {
    if (!newName.trim() || !newMatchValue.trim()) { setActionErr('Name and match value required'); return; }
    setCreating(true);
    setActionErr(null);
    try {
      const r = await clientFetch('/api/admin/classifications', {
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
      const r = await clientFetch(`/api/admin/classifications?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
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
      const r = await clientFetch('/api/admin/classifications', {
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
    { key: 'matchValue', label: 'Pattern / value', width: 240, getValue: (r) => r.matchValue, render: (r) => <code className={a.codeCell}>{r.matchValue}</code> },
    { key: 'createdBy', label: 'Created by', width: 160, render: (r) => <Caption1>{r.createdBy}</Caption1> },
    { key: 'actions', label: '', width: 110, sortable: false, filterable: false, render: (r) => <Button size='small' appearance='subtle' icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); remove(r.id); }} aria-label={`Delete rule ${r.name}`}>Delete</Button> },
  ], [a]);

  // Provisioned signal — prefer the custom-rules GET's purview state, but fall
  // back to the STATIC system route's `configured` (a pure env-var check that
  // never times out). This is what fixes the false "Purview not provisioned"
  // banner: a slow/timed-out custom-rules load leaves `purview` null, but
  // `systemConfigured` still reflects LOOM_PURVIEW_ACCOUNT correctly.
  const purviewConfigured = (purview?.configured ?? systemConfigured) ?? false;
  const purviewAccount = purview?.account ?? systemAccount;
  // Only render the provisioned banner once we have a definitive signal, so the
  // alarming "not provisioned" warning never flashes during initial load.
  const purviewKnown = purview !== null || systemConfigured !== null;

  return (
    <AdminShell sectionTitle='Classifications'>
      <Section title='About classification rules'>
        <SectionExplainer>
          Classification rules detect sensitive-info types and apply classifications (PII, PHI, PCI, Confidential, etc.) to catalog items on scan. Each rule is pushed to Microsoft Purview as a <strong>custom classification rule</strong> and rolled into a <strong>custom scan rule set</strong>, so it actually classifies data when a scan runs. Choose a <strong>match strategy</strong>:
          <ul className={s.explainerList}>
            <li><strong>Column name regex:</strong> Match column names (e.g., <code>.*email.*</code>)</li>
            <li><strong>Data regex:</strong> Match data values (e.g., <code>{'\\d{3}-\\d{2}-\\d{4}'}</code> for SSN)</li>
            <li><strong>Dictionary:</strong> Match against a word list (comma-separated)</li>
          </ul>
        </SectionExplainer>
      </Section>

      {/* Live Purview sync state — replaces the old static "applied on next scan" banner. */}
      {purviewKnown && (!purviewConfigured ? (
        <MessageBar intent='warning' className={s.banner}>
          <MessageBarBody className={s.bannerBody}>
            <MessageBarTitle>Microsoft Purview not provisioned</MessageBarTitle>
            Rules are saved to the Loom catalog. To push them as Purview custom classification rules and run scans, set <code>LOOM_PURVIEW_ACCOUNT</code> (deployed by <code>platform/fiab/bicep/modules/admin-plane/catalog.bicep</code>) and grant the Console UAMI <strong>Data Source Administrator</strong> on the root collection.
          </MessageBarBody>
        </MessageBar>
      ) : sync?.error ? (
        <MessageBar intent='error' className={s.banner}>
          <MessageBarBody className={s.bannerBody}>
            <MessageBarTitle>Purview sync failed</MessageBarTitle>
            {sync.error} — verify the Console UAMI holds <strong>Data Source Administrator</strong> on <code>{purviewAccount}</code> (root collection). Rules are still saved in the Loom catalog.
          </MessageBarBody>
        </MessageBar>
      ) : sync?.synced ? (
        <MessageBar intent='success' className={s.banner}>
          <MessageBarBody className={s.bannerBody}>
            <MessageBarTitle>Synced to Microsoft Purview</MessageBarTitle>
            {sync.ruleCount} classification rule(s) pushed to <code>{sync.account}</code>{sync.scanRulesets?.length ? ` and included in scan rule sets: ${sync.scanRulesets.map((rs) => rs.name).join(', ')}` : ''}. Use <strong>Run scan now</strong> to apply them. Existing classifications on assets are not removed retroactively.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <MessageBar intent='info' className={s.banner}>
          <MessageBarBody className={s.bannerBody}>
            <MessageBarTitle>Connected to Microsoft Purview</MessageBarTitle>
            Account <code>{purviewAccount}</code>. Adding or deleting a rule syncs it to Purview automatically; use <strong>Sync to Purview</strong> to re-push the full taxonomy, then <strong>Run scan now</strong>.
          </MessageBarBody>
        </MessageBar>
      ))}

      {error && <MessageBar intent='error' className={s.banner}><MessageBarBody className={s.bannerBody}><MessageBarTitle>Could not load rules</MessageBarTitle>{error} The built-in classification catalog below is unaffected.</MessageBarBody><MessageBarActions><Button size='small' icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Retry</Button></MessageBarActions></MessageBar>}
      {actionErr && <MessageBar intent='error' className={s.banner}><MessageBarBody className={s.bannerBody}>{actionErr}</MessageBarBody></MessageBar>}

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

      <Section
        title='Built-in classifications'
        actions={<Button icon={<ArrowSync24Regular />} onClick={loadSystem} disabled={systemLoading}>Refresh</Button>}
      >
        <SectionExplainer>
          Microsoft Purview ships 200+ built-in <strong>system classifications</strong> (sensitive-information types) — government IDs, financial, personal (PII), security credentials and health. This is a curated, read-only reference catalog of the real Microsoft classification names; the types are applied automatically when a Purview scan runs, and are also selectable as the target when you author a custom rule above.
        </SectionExplainer>
        {systemErr ? (
          <MessageBar intent='error'><MessageBarBody className={s.bannerBody}><MessageBarTitle>Could not load built-in classifications</MessageBarTitle>{systemErr}</MessageBarBody></MessageBar>
        ) : (systemGroups === null || systemLoading) ? (
          <Spinner label='Loading built-in classifications…' />
        ) : systemGroups.length === 0 ? (
          <Caption1>No built-in classifications available.</Caption1>
        ) : (
          <div className={s.groupList}>
            {systemGroups.map((g) => (
              <div key={g.id} className={s.group}>
                <div className={s.groupHead}>
                  <Subtitle2>{g.label}</Subtitle2>
                  <Badge appearance='tint' color='informative' size='small'>{g.classifications.length}</Badge>
                </div>
                <Caption1 className={s.groupDesc}>{g.description}</Caption1>
                <div className={s.chipWrap}>
                  {g.classifications.map((c) => (
                    <Badge key={c.name} appearance='outline' color='brand' title={c.description || c.classificationName}>{c.displayName}</Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add classification rule</DialogTitle>
            <DialogContent>
              <div className={s.field}>
                <div><Caption1 className={a.fieldLabel}>Rule name</Caption1><Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder='e.g. Email columns' className={a.fullWidth} /></div>
                <div><Caption1 className={a.fieldLabel}>Match strategy</Caption1><Dropdown value={MATCH_STRATEGY_OPTIONS.find((m) => m.value === newMatchStrategy)?.label || newMatchStrategy} selectedOptions={[newMatchStrategy]} onOptionSelect={(_, d) => setNewMatchStrategy(d.optionValue || 'column-name-regex')} className={a.fullWidth}>{MATCH_STRATEGY_OPTIONS.map((opt) => <Option key={opt.value} value={opt.value}>{opt.label}</Option>)}</Dropdown></div>
                <div><Caption1 className={a.fieldLabel}>Pattern or value{newMatchStrategy === 'column-name-regex' && ' (regex for column names)'}{newMatchStrategy === 'data-regex' && ' (regex for data)'}{newMatchStrategy === 'dictionary' && ' (comma-separated words)'}</Caption1><Textarea value={newMatchValue} onChange={(_, d) => setNewMatchValue(d.value)} placeholder={newMatchStrategy === 'column-name-regex' ? '.*email.*' : newMatchStrategy === 'data-regex' ? '\\d{3}-\\d{2}-\\d{4}' : 'word1, word2, word3'} resize='vertical' className={a.fullWidth} /></div>
                <div><Caption1 className={a.fieldLabel}>Classification</Caption1><Dropdown value={classDisplay} selectedOptions={[newClassification]} onOptionSelect={(_, d) => setNewClassification(d.optionValue || 'PII')} className={a.fullWidth}>
                  {CLASSIFICATION_OPTIONS.map((opt) => <Option key={opt} value={opt}>{opt}</Option>)}
                  {systemFlat.length > 0 && <Option key='__system_header' value='__system_header' disabled>— Built-in (Microsoft Purview system) —</Option>}
                  {systemFlat.map((c) => <Option key={c.classificationName} value={c.classificationName} text={c.displayName}>{c.displayName}</Option>)}
                </Dropdown></div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance='secondary' onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance='primary' onClick={create} disabled={creating || !newName.trim() || !newMatchValue.trim()}>{creating ? 'Creating...' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <RunScanDialog open={scanOpen} onClose={() => setScanOpen(false)} account={purviewAccount || null} />
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
  const s = useStyles();
  const a = useAdminTabStyles();
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
      const r = await clientFetch('/api/governance/scans');
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
      const r = await clientFetch(`/api/governance/scans?source=${encodeURIComponent(src)}`);
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
      const r = await clientFetch('/api/governance/scans', {
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
            <div className={s.field}>
              <Caption1 className={a.explainerText}>
                Triggers a real scan run on a registered Microsoft Purview data source{account ? ` (${account})` : ''}. The scan applies the classification rules included in its scan rule set.
              </Caption1>
              <div>
                <Caption1 className={a.fieldLabel}>Data source</Caption1>
                <Dropdown
                  placeholder={loadingSrc ? 'Loading sources…' : (sources && sources.length === 0 ? 'No registered data sources' : 'Select a data source')}
                  value={source}
                  selectedOptions={source ? [source] : []}
                  onOptionSelect={(_, d) => { const v = d.optionValue || ''; setSource(v); loadScans(v); }}
                  disabled={loadingSrc || !(sources && sources.length)}
                  className={a.fullWidth}
                >
                  {(sources || []).map((src) => <Option key={src.id || src.name} value={src.name}>{src.kind ? `${src.name} (${src.kind})` : src.name}</Option>)}
                </Dropdown>
              </div>
              <div>
                <Caption1 className={a.fieldLabel}>Scan</Caption1>
                <Dropdown
                  placeholder={!source ? 'Pick a data source first' : (loadingScans ? 'Loading scans…' : (scans && scans.length === 0 ? 'No scans defined on this source' : 'Select a scan'))}
                  value={scan}
                  selectedOptions={scan ? [scan] : []}
                  onOptionSelect={(_, d) => setScan(d.optionValue || '')}
                  disabled={!source || loadingScans || !(scans && scans.length)}
                  className={a.fullWidth}
                >
                  {(scans || []).map((sc) => <Option key={sc.id || sc.name} value={sc.name}>{sc.name}</Option>)}
                </Dropdown>
              </div>
              {msg && <MessageBar intent={msg.intent}><MessageBarBody className={s.bannerBody}>{msg.text}</MessageBarBody></MessageBar>}
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

'use client';

/**
 * AiSearchServicePanel (AIF-17) — AI Search SERVICE administration in-editor,
 * parity with the portal's Keys / Identity / Networking / Monitoring / and the
 * service-statistics blade. Opened from the service navigator's ⚙ Service action.
 *
 * Every control is a real ARM / Monitor / data-plane call through:
 *   - GET  /api/ai-search/service          → props + admin keys + query keys + stats
 *   - POST /api/ai-search/service          → regenerate key / create+delete query key /
 *                                            set public network access / set semantic tier
 *   - GET  /api/ai-search/service/metrics  → QPS / latency / throttling time-series
 *
 * When ARM env (LOOM_AI_SEARCH_SUB/RG/SERVICE) is unset the routes 503 and this
 * panel renders the honest infra-gate MessageBar. No mocks.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  TabList, Tab, Button, Caption1, Badge, Spinner, Input, Field, Dropdown, Option,
  Subtitle2, Body1Strong,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Tooltip,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Key20Regular, ShieldTask20Regular, Globe20Regular, DataArea20Regular,
  Server20Regular, Eye16Regular, EyeOff16Regular, ArrowSync16Regular,
  Add16Regular, Delete16Regular, ArrowCounterclockwise16Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalM },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    background: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
  },
  kv: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: tokens.spacingHorizontalM, alignItems: 'center' },
  keyRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { overflowX: 'auto', width: '100%' },
});

type Tab5 = 'overview' | 'keys' | 'networking' | 'monitoring' | 'stats';

interface ServiceProps {
  id: string; name: string; location: string; sku: string;
  replicaCount: number; partitionCount: number; provisioningState?: string; status?: string;
  identityType?: string; principalId?: string; userAssignedIdentities?: string[];
  publicNetworkAccess: 'enabled' | 'disabled'; ipRules: string[]; bypass?: string;
  privateEndpointCount: number; privateEndpoints: Array<{ name: string; status?: string }>;
  authMode: string; aadFailureMode?: string;
  semanticSearch: 'disabled' | 'free' | 'standard'; cmkEnforcement?: string;
}
interface Overview { service: ServiceProps; adminKeys: any; queryKeys: any; stats: any; }
interface Metric { name: string; unit: string; points: Array<{ timeStamp: string; value: number | null }>; }

async function readJson(res: Response): Promise<any> {
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { ok: false, error: t || `HTTP ${res.status}` }; }
}
function maskKey(k: string): string { return k ? `${k.slice(0, 4)}${'•'.repeat(Math.max(0, k.length - 8))}${k.slice(-4)}` : ''; }
function metricStat(m: Metric): { latest: number | null; avg: number | null } {
  const vals = m.points.map((p) => p.value).filter((v): v is number => v != null);
  if (!vals.length) return { latest: null, avg: null };
  return { latest: vals[vals.length - 1], avg: vals.reduce((a, b) => a + b, 0) / vals.length };
}

export function AiSearchServicePanel({ onClose }: { onClose?: () => void }) {
  const s = useStyles();
  const [tab, setTab] = useState<Tab5>('overview');
  const [data, setData] = useState<Overview | null>(null);
  const [gate, setGate] = useState<{ missing: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  const [revealAdmin, setRevealAdmin] = useState(false);
  const [newQueryKeyName, setNewQueryKeyName] = useState('');
  const [confirmRegen, setConfirmRegen] = useState<'primary' | 'secondary' | null>(null);

  const [metrics, setMetrics] = useState<Metric[] | null>(null);
  const [metricsTimespan, setMetricsTimespan] = useState('PT6H');
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const j = await readJson(await clientFetch('/api/ai-search/service'));
    if (j?.code === 'not_configured') { setGate({ missing: j.missing || [] }); setLoading(false); return; }
    setGate(null);
    if (!j?.ok) { setError(j?.error || 'failed to load service'); setLoading(false); return; }
    setData(j); setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadMetrics = useCallback(async () => {
    setMetricsLoading(true); setMetricsError(null);
    const j = await readJson(await clientFetch(`/api/ai-search/service/metrics?timespan=${encodeURIComponent(metricsTimespan)}`));
    if (!j?.ok) { setMetricsError(j?.error || 'failed to load metrics'); setMetrics([]); }
    else setMetrics(j.metrics || []);
    setMetricsLoading(false);
  }, [metricsTimespan]);

  useEffect(() => { if (tab === 'monitoring') loadMetrics(); }, [tab, loadMetrics]);

  const post = async (payload: any): Promise<any> => {
    setBusy(true); setMsg(null);
    const j = await readJson(await clientFetch('/api/ai-search/service', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
    setBusy(false);
    if (!j?.ok) { setMsg({ intent: 'error', text: j?.error || 'action failed' }); return null; }
    return j;
  };

  const regenerate = async (keyKind: 'primary' | 'secondary') => {
    setConfirmRegen(null);
    const j = await post({ action: 'regenerateAdminKey', keyKind });
    if (j) { setMsg({ intent: 'success', text: `${keyKind} admin key regenerated.` }); setData((d) => d ? { ...d, adminKeys: j.adminKeys } : d); setRevealAdmin(true); }
  };
  const createQueryKey = async () => {
    if (!newQueryKeyName.trim()) return;
    const j = await post({ action: 'createQueryKey', name: newQueryKeyName.trim() });
    if (j) { setMsg({ intent: 'success', text: `Query key "${j.queryKey.name}" created.` }); setNewQueryKeyName(''); load(); }
  };
  const deleteQueryKey = async (key: string, name: string) => {
    const j = await post({ action: 'deleteQueryKey', key });
    if (j) { setMsg({ intent: 'success', text: `Query key "${name}" revoked.` }); load(); }
  };
  const toggleNetwork = async (enabled: boolean) => {
    const j = await post({ action: 'setPublicNetworkAccess', enabled });
    if (j) { setMsg({ intent: 'success', text: `Public network access ${enabled ? 'enabled' : 'disabled'}.` }); setData((d) => d ? { ...d, service: j.service } : d); }
  };
  const setSemantic = async (tier: 'disabled' | 'free' | 'standard') => {
    const j = await post({ action: 'setSemanticTier', tier });
    if (j) { setMsg({ intent: 'success', text: `Semantic ranker set to "${tier}".` }); setData((d) => d ? { ...d, service: j.service } : d); }
  };

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.head}><Subtitle2>AI Search service administration</Subtitle2><div className={s.spacer} />{onClose && <Button size="small" onClick={onClose}>Close</Button>}</div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>ARM management plane not configured</MessageBarTitle>
            Set <code>{gate.missing.join('</code>, <code>')}</code> on the Console Container App to manage keys, networking,
            semantic tier and metrics. The Loom UAMI needs <strong>Search Service Contributor</strong> (keys / networking /
            semantic) and <strong>Monitoring Reader</strong> (metrics) on the service. Bicep:{' '}
            <code>platform/fiab/bicep/modules/admin-plane/ai-search.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  const svc = data?.service;

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Server20Regular />
        <Subtitle2>Service: {svc?.name || '…'}</Subtitle2>
        {svc?.sku && <Badge appearance="tint" color="brand">{svc.sku}</Badge>}
        {svc?.provisioningState && <Badge appearance="tint">{svc.provisioningState}</Badge>}
        <div className={s.spacer} />
        <Button size="small" icon={<ArrowSync16Regular />} onClick={load} disabled={loading}>Refresh</Button>
        {onClose && <Button size="small" onClick={onClose}>Close</Button>}
      </div>

      {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Service error</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as Tab5)}>
        <Tab value="overview" icon={<Server20Regular />}>Overview</Tab>
        <Tab value="keys" icon={<Key20Regular />}>Keys</Tab>
        <Tab value="networking" icon={<Globe20Regular />}>Networking</Tab>
        <Tab value="monitoring" icon={<DataArea20Regular />}>Monitoring</Tab>
        <Tab value="stats" icon={<ShieldTask20Regular />}>Statistics</Tab>
      </TabList>

      {loading ? <Spinner size="tiny" label="Loading service…" /> : !svc ? null : (
        <>
          {tab === 'overview' && (
            <div className={s.card}>
              <div className={s.kv}>
                <Caption1>Name</Caption1><Body1Strong>{svc.name}</Body1Strong>
                <Caption1>Location</Caption1><span>{svc.location}</span>
                <Caption1>SKU / tier</Caption1><span>{svc.sku}</span>
                <Caption1>Replicas × partitions</Caption1><span>{svc.replicaCount} × {svc.partitionCount}</span>
                <Caption1>Status</Caption1><span>{svc.status || '—'} ({svc.provisioningState || '—'})</span>
                <Caption1>Managed identity</Caption1><span>{svc.identityType || 'None'}{svc.principalId ? ` · ${svc.principalId.slice(0, 8)}…` : ''}</span>
                <Caption1>Auth mode</Caption1><span>{svc.authMode}</span>
                <Caption1>Public network access</Caption1><span><Badge appearance="tint" color={svc.publicNetworkAccess === 'enabled' ? 'warning' : 'success'}>{svc.publicNetworkAccess}</Badge></span>
                <Caption1>Private endpoints</Caption1><span>{svc.privateEndpointCount}</span>
                <Caption1>Semantic ranker</Caption1><span><Badge appearance="tint" color={svc.semanticSearch === 'disabled' ? 'informative' : 'brand'}>{svc.semanticSearch}</Badge></span>
                <Caption1>CMK enforcement</Caption1><span>{svc.cmkEnforcement || '—'}</span>
              </div>
              <Caption1>Scale (replicas/partitions) and cost are managed on the Scaling admin page and via the ARM PATCH; this view is read-only for scale.</Caption1>
            </div>
          )}

          {tab === 'keys' && (
            <>
              <div className={s.card}>
                <div className={s.head}><Body1Strong>Admin keys (read-write)</Body1Strong><div className={s.spacer} />
                  <Button size="small" icon={revealAdmin ? <EyeOff16Regular /> : <Eye16Regular />} onClick={() => setRevealAdmin((r) => !r)}>{revealAdmin ? 'Hide' : 'Reveal'}</Button>
                </div>
                {data?.adminKeys?.error ? (
                  <MessageBar intent="warning"><MessageBarBody>Cannot read admin keys: {data.adminKeys.error}. The UAMI needs Search Service Contributor.</MessageBarBody></MessageBar>
                ) : (
                  <>
                    {(['primary', 'secondary'] as const).map((kind) => {
                      const val = data?.adminKeys?.[`${kind}Key`] || '';
                      return (
                        <div key={kind} className={s.keyRow}>
                          <Caption1 style={{ minWidth: '72px' }}>{kind}</Caption1>
                          <span className={s.mono}>{revealAdmin ? val : maskKey(val)}</span>
                          <div className={s.spacer} />
                          <Button size="small" icon={<ArrowCounterclockwise16Regular />} disabled={busy} onClick={() => setConfirmRegen(kind)}>Regenerate</Button>
                        </div>
                      );
                    })}
                    <Caption1>Rotate one key at a time so live clients using the other key keep working. Regeneration is immediate and irreversible.</Caption1>
                  </>
                )}
              </div>

              <div className={s.card}>
                <Body1Strong>Query keys (read-only)</Body1Strong>
                {data?.queryKeys?.error ? (
                  <MessageBar intent="warning"><MessageBarBody>Cannot read query keys: {data.queryKeys.error}.</MessageBarBody></MessageBar>
                ) : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Query keys">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Key</TableHeaderCell><TableHeaderCell></TableHeaderCell></TableRow></TableHeader>
                      <TableBody>
                        {(Array.isArray(data?.queryKeys) ? data.queryKeys : []).map((k: any, i: number) => (
                          <TableRow key={i}>
                            <TableCell>{k.name || <em>(default)</em>}</TableCell>
                            <TableCell className={s.mono}>{revealAdmin ? k.key : maskKey(k.key)}</TableCell>
                            <TableCell>
                              {k.name ? <Tooltip content="Revoke" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => deleteQueryKey(k.key, k.name)} aria-label={`Revoke ${k.name}`} /></Tooltip> : <Caption1>can&apos;t delete default</Caption1>}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                <div className={s.actions}>
                  <Field label="New query key name"><Input size="small" value={newQueryKeyName} placeholder="app-readonly" onChange={(_, d) => setNewQueryKeyName(d.value)} /></Field>
                  <Button size="small" appearance="primary" icon={<Add16Regular />} disabled={busy || !newQueryKeyName.trim()} onClick={createQueryKey}>Create query key</Button>
                </div>
              </div>
            </>
          )}

          {tab === 'networking' && (
            <div className={s.card}>
              <div className={s.head}><Body1Strong>Public network access</Body1Strong><div className={s.spacer} />
                <Badge appearance="tint" color={svc.publicNetworkAccess === 'enabled' ? 'warning' : 'success'}>{svc.publicNetworkAccess}</Badge>
              </div>
              <div className={s.actions}>
                <Button size="small" disabled={busy || svc.publicNetworkAccess === 'enabled'} onClick={() => toggleNetwork(true)}>Enable public access</Button>
                <Button size="small" disabled={busy || svc.publicNetworkAccess === 'disabled'} onClick={() => toggleNetwork(false)}>Disable (private-only)</Button>
              </div>
              <Caption1>Disabling public access forces all traffic through private endpoints. The default Loom deploy is PE-locked (disabled).</Caption1>
              <div className={s.kv}>
                <Caption1>Bypass</Caption1><span>{svc.bypass || 'None'}</span>
                <Caption1>IP firewall rules</Caption1><span>{svc.ipRules.length ? svc.ipRules.join(', ') : 'None'}</span>
              </div>
              <Body1Strong>Private endpoints ({svc.privateEndpointCount})</Body1Strong>
              {svc.privateEndpoints.length === 0 ? <Caption1>No private endpoint connections.</Caption1> : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Private endpoints">
                    <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell></TableRow></TableHeader>
                    <TableBody>
                      {svc.privateEndpoints.map((pe, i) => (<TableRow key={i}><TableCell>{pe.name}</TableCell><TableCell><Badge appearance="tint" color={pe.status === 'Approved' ? 'success' : 'informative'}>{pe.status || '—'}</Badge></TableCell></TableRow>))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Body1Strong>Semantic ranker tier</Body1Strong>
              <div className={s.actions}>
                <Dropdown value={svc.semanticSearch} selectedOptions={[svc.semanticSearch]} aria-label="semantic-tier"
                  onOptionSelect={(_, d) => d.optionValue && d.optionValue !== svc.semanticSearch && setSemantic(d.optionValue as 'disabled' | 'free' | 'standard')}>
                  <Option value="disabled">disabled</Option>
                  <Option value="free">free (1K requests/mo)</Option>
                  <Option value="standard">standard</Option>
                </Dropdown>
                <Caption1>Semantic ranking L2 re-ranks the top results; standard tier is billed per request.</Caption1>
              </div>
            </div>
          )}

          {tab === 'monitoring' && (
            <div className={s.card}>
              <div className={s.head}><Body1Strong>Query metrics (Azure Monitor)</Body1Strong><div className={s.spacer} />
                <Dropdown size="small" value={metricsTimespan} selectedOptions={[metricsTimespan]} aria-label="metrics-timespan"
                  onOptionSelect={(_, d) => d.optionValue && setMetricsTimespan(d.optionValue)}>
                  <Option value="PT1H">Last hour</Option>
                  <Option value="PT6H">Last 6 hours</Option>
                  <Option value="P1D">Last 24 hours</Option>
                  <Option value="P7D">Last 7 days</Option>
                </Dropdown>
                <Button size="small" icon={<ArrowSync16Regular />} disabled={metricsLoading} onClick={loadMetrics}>Refresh</Button>
              </div>
              {metricsLoading ? <Spinner size="tiny" label="Loading metrics…" /> : metricsError ? (
                <MessageBar intent="warning"><MessageBarBody>{metricsError} — the UAMI needs Monitoring Reader (or Reader) on the service.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Service metrics">
                    <TableHeader><TableRow><TableHeaderCell>Metric</TableHeaderCell><TableHeaderCell>Latest</TableHeaderCell><TableHeaderCell>Average</TableHeaderCell><TableHeaderCell>Unit</TableHeaderCell></TableRow></TableHeader>
                    <TableBody>
                      {(metrics || []).map((m) => {
                        const st = metricStat(m);
                        return (
                          <TableRow key={m.name}>
                            <TableCell>{m.name}</TableCell>
                            <TableCell>{st.latest != null ? st.latest.toFixed(2) : '—'}</TableCell>
                            <TableCell>{st.avg != null ? st.avg.toFixed(2) : '—'}</TableCell>
                            <TableCell>{m.unit || '—'}</TableCell>
                          </TableRow>
                        );
                      })}
                      {(metrics || []).length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No metric data in this window.</Caption1></TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}

          {tab === 'stats' && (
            <div className={s.card}>
              <Body1Strong>Service statistics &amp; quotas</Body1Strong>
              {data?.stats?.error ? (
                <MessageBar intent="warning"><MessageBarBody>Cannot read statistics: {data.stats.error}.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Service statistics">
                    <TableHeader><TableRow><TableHeaderCell>Object</TableHeaderCell><TableHeaderCell>Usage</TableHeaderCell><TableHeaderCell>Quota</TableHeaderCell></TableRow></TableHeader>
                    <TableBody>
                      {Object.entries(data?.stats?.counters || {}).map(([k, v]: [string, any]) => (
                        <TableRow key={k}>
                          <TableCell>{k}</TableCell>
                          <TableCell>{typeof v?.usage === 'number' ? v.usage.toLocaleString() : '—'}</TableCell>
                          <TableCell>{v?.quota != null ? Number(v.quota).toLocaleString() : '∞'}</TableCell>
                        </TableRow>
                      ))}
                      {Object.keys(data?.stats?.counters || {}).length === 0 && <TableRow><TableCell colSpan={3}><Caption1>No counters returned.</Caption1></TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Regenerate-key confirmation */}
      <Dialog open={confirmRegen !== null} onOpenChange={(_, d) => { if (!d.open) setConfirmRegen(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Regenerate {confirmRegen} admin key?</DialogTitle>
            <DialogContent>
              This immediately invalidates the current {confirmRegen} admin key. Any client using it will get 403 until updated.
              Rotate only one key at a time.
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmRegen(null)}>Cancel</Button>
              <Button appearance="primary" disabled={busy} onClick={() => confirmRegen && regenerate(confirmRegen)}>Regenerate</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

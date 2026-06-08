'use client';

/**
 * DlpPanel — DLP tab for /admin/security.
 *
 * Sub-tabs:
 *   - Policies    : list Purview DLP policies + drill into rules
 *   - Violations  : per-item DLP violations via Graph alerts_v2
 *   - Alerts      : recent DLP alerts via Graph
 *   - Simulate    : evaluate sample content against policies
 *
 * Notes on preview status: Graph DLP endpoints are partially in /beta.
 * The simulate endpoint in particular is gated by a tenant-level preview
 * flag — if the tenant doesn't have it enabled, the BFF returns 501 with
 * an explicit remediation hint instead of faking results.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Spinner, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Subtitle2,
  Textarea, Field,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular } from '@fluentui/react-icons';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';

const useStyles = makeStyles({
  subTabs: { marginBottom: 12 },
  section: {
    padding: 12, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  toolbar: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' },
  fieldStack: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 },
});

interface ApiState<T> {
  loading: boolean;
  data: T | null;
  notConfigured?: NotConfiguredHint;
  error?: string;
  errorStatus?: number;
  errorHint?: any;
}

function emptyState<T>(): ApiState<T> { return { loading: false, data: null }; }

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<ApiState<T>> {
  try {
    const r = await fetch(url, init);
    const j = await r.json();
    if (r.status === 503 && j?.code?.endsWith('_not_configured')) {
      return { loading: false, data: null, notConfigured: j.hint, error: j.error, errorStatus: 503 };
    }
    if (!r.ok) {
      return { loading: false, data: null, error: j?.error || `HTTP ${r.status}`, errorStatus: r.status, errorHint: j?.hint };
    }
    return { loading: false, data: j as T };
  } catch (e: any) { return { loading: false, data: null, error: e?.message || String(e) }; }
}

type SubTab = 'policies' | 'violations' | 'alerts' | 'simulate';

interface PolicyRow {
  id: string; name?: string; displayName?: string; description?: string;
  mode?: string; status?: string; locations?: string[]; ruleCount?: number; lastModifiedDateTime?: string;
}
interface PoliciesPayload { ok: boolean; policies?: PolicyRow[] }
interface RulesPayload {
  ok: boolean; policyId?: string;
  rules?: Array<{ id: string; name?: string; description?: string; priority?: number; isEnabled?: boolean; conditions?: unknown; actions?: unknown; exceptions?: unknown }>;
}

interface AlertsPayload {
  ok: boolean;
  alerts?: Array<{ id: string; title?: string; severity?: string; status?: string; createdDateTime?: string; detectionSource?: string; category?: string; description?: string }>;
}

interface Violation {
  alertId: string; policyName?: string; ruleName?: string; severity?: string; status?: string;
  user?: string; itemPath?: string; itemType?: string; workload?: string; action?: string; detectedAt?: string;
}
interface ViolationsPayload { ok: boolean; violations?: Violation[]; count?: number }

export function DlpPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<SubTab>('policies');

  return (
    <div>
      <TabList
        className={s.subTabs}
        selectedValue={tab}
        onTabSelect={(_e: SelectTabEvent, d: SelectTabData) => setTab(d.value as SubTab)}
        size="small"
      >
        <Tab value="policies">Policies</Tab>
        <Tab value="violations">Violations</Tab>
        <Tab value="alerts">Alerts</Tab>
        <Tab value="simulate">Simulate</Tab>
      </TabList>

      {tab === 'policies' && <PoliciesSection />}
      {tab === 'violations' && <ViolationsSection />}
      {tab === 'alerts' && <AlertsSection />}
      {tab === 'simulate' && <SimulateSection />}
    </div>
  );
}

function PoliciesSection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<PoliciesPayload>>(emptyState());
  const [selected, setSelected] = useState<string | null>(null);
  const [rules, setRules] = useState<ApiState<RulesPayload>>(emptyState());

  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    setState(await fetchJson<PoliciesPayload>('/api/admin/security/dlp/policies'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const showRules = async (policyId: string) => {
    setSelected(policyId);
    setRules({ loading: true, data: null });
    setRules(await fetchJson<RulesPayload>(`/api/admin/security/dlp/policies?policyId=${encodeURIComponent(policyId)}`));
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>DLP policies <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
      </div>
      {state.loading && <Spinner label="Loading DLP policies…" />}
      {state.notConfigured && (
        <NotConfiguredBar surface="DLP policies" hint={state.notConfigured}
          portalLink="https://compliance.microsoft.com/datalossprevention"
          portalLabel="Open Microsoft Purview DLP" />
      )}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load policies (HTTP {state.errorStatus})</MessageBarTitle>
            {state.error}
            {state.errorStatus === 403 && (
              <Caption1 block style={{ marginTop: 6 }}>
                403 indicates the <code>Policy.Read.All</code> AppRole has not been admin-consented for the Console UAMI. Run the post-deploy bootstrap job <code>Grant MIP+DLP Graph AppRoles</code> then grant admin consent.
              </Caption1>
            )}
            {state.errorStatus === 404 && (
              <Caption1 block style={{ marginTop: 6 }}>
                The Graph DLP /beta endpoint returned 404 — this tenant is likely not enrolled in the DLP-via-Graph preview. Open a Microsoft support ticket referencing <code>/beta/security/dataLossPreventionPolicies</code>.
              </Caption1>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.policies || []).length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No DLP policies configured.</Caption1>
      )}
      {state.data?.ok && (state.data.policies || []).length > 0 && (
        <Table size="small" aria-label="DLP policies">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Mode</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Locations</TableHeaderCell>
              <TableHeaderCell>Rules</TableHeaderCell>
              <TableHeaderCell>Modified</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.policies!.map((p) => (
              <TableRow key={p.id}>
                <TableCell><strong>{p.displayName || p.name}</strong></TableCell>
                <TableCell><Badge appearance="outline">{p.mode || '—'}</Badge></TableCell>
                <TableCell><Badge color={p.status === 'Enabled' ? 'success' : 'subtle'}>{p.status || '—'}</Badge></TableCell>
                <TableCell>{(p.locations || []).map((l) => <Badge key={l} appearance="outline" style={{ marginRight: 4 }}>{l}</Badge>)}</TableCell>
                <TableCell>{p.ruleCount ?? '—'}</TableCell>
                <TableCell><Caption1>{p.lastModifiedDateTime?.slice(0, 16) || '—'}</Caption1></TableCell>
                <TableCell><Button size="small" onClick={() => showRules(p.id)}>Rules</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selected && (
        <div style={{ marginTop: 16 }}>
          <Subtitle2 block>Rules for {selected}</Subtitle2>
          {rules.loading && <Spinner label="Loading rules…" />}
          {rules.error && (
            <MessageBar intent="error"><MessageBarBody>{rules.error}</MessageBarBody></MessageBar>
          )}
          {rules.data?.ok && (rules.data.rules || []).length === 0 && (
            <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No rules defined for this policy.</Caption1>
          )}
          {rules.data?.ok && (rules.data.rules || []).length > 0 && (
            <Table size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Rule</TableHeaderCell>
                  <TableHeaderCell>Priority</TableHeaderCell>
                  <TableHeaderCell>Enabled</TableHeaderCell>
                  <TableHeaderCell>Description</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.data.rules!.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><strong>{r.name}</strong></TableCell>
                    <TableCell>{r.priority ?? '—'}</TableCell>
                    <TableCell>{r.isEnabled ? <Badge color="success">on</Badge> : <Badge color="subtle">off</Badge>}</TableCell>
                    <TableCell><Caption1>{(r.description || '').slice(0, 120)}</Caption1></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}

function ViolationsSection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<ViolationsPayload>>(emptyState());

  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    setState(await fetchJson<ViolationsPayload>('/api/admin/security/dlp/violations?top=50'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const sevColor = (sev?: string): any =>
    sev === 'high' ? 'danger' : sev === 'medium' ? 'warning' : 'subtle';

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>DLP violations (last 30 days)</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
      </div>
      {state.loading && <Spinner label="Loading violations…" />}
      {state.notConfigured && <NotConfiguredBar surface="DLP violations" hint={state.notConfigured} />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody></MessageBar>
      )}
      {state.data?.ok && (state.data.violations || []).length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No DLP violations detected in the last 30 days.</Caption1>
      )}
      {state.data?.ok && (state.data.violations || []).length > 0 && (
        <Table size="small" aria-label="DLP violations">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Detected</TableHeaderCell>
              <TableHeaderCell>Policy</TableHeaderCell>
              <TableHeaderCell>Item</TableHeaderCell>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell>Severity</TableHeaderCell>
              <TableHeaderCell>Action</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.violations!.map((v) => (
              <TableRow key={v.alertId}>
                <TableCell><Caption1>{v.detectedAt?.slice(0, 16) || '—'}</Caption1></TableCell>
                <TableCell><strong>{v.policyName || '—'}</strong>{v.ruleName ? <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>{v.ruleName}</Caption1> : null}</TableCell>
                <TableCell>
                  <Caption1 title={v.itemPath}>{(v.itemPath || '—').slice(0, 48)}</Caption1>
                  {v.itemType ? <Badge appearance="outline" size="small" style={{ marginLeft: 4 }}>{v.itemType}</Badge> : null}
                </TableCell>
                <TableCell><Caption1>{v.user || '—'}</Caption1></TableCell>
                <TableCell><Badge color={sevColor(v.severity)}>{v.severity || '—'}</Badge></TableCell>
                <TableCell><Caption1>{v.action || v.status || '—'}</Caption1></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function AlertsSection() {
  const s = useStyles();
  const [state, setState] = useState<ApiState<AlertsPayload>>(emptyState());
  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    setState(await fetchJson<AlertsPayload>('/api/admin/security/dlp/alerts?top=50'));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>Recent DLP alerts</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
      </div>
      {state.loading && <Spinner label="Loading alerts…" />}
      {state.notConfigured && <NotConfiguredBar surface="DLP alerts" hint={state.notConfigured} />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody></MessageBar>
      )}
      {state.data?.ok && (state.data.alerts || []).length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No DLP alerts in the last 30 days.</Caption1>
      )}
      {state.data?.ok && (state.data.alerts || []).length > 0 && (
        <Table size="small" aria-label="DLP alerts">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Title</TableHeaderCell>
              <TableHeaderCell>Severity</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Detection source</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.alerts!.map((a) => (
              <TableRow key={a.id}>
                <TableCell><Caption1>{a.createdDateTime?.slice(0, 16) || '—'}</Caption1></TableCell>
                <TableCell><strong>{a.title}</strong></TableCell>
                <TableCell>
                  <Badge color={a.severity === 'high' ? 'danger' : a.severity === 'medium' ? 'warning' : 'subtle'}>{a.severity || '—'}</Badge>
                </TableCell>
                <TableCell><Badge appearance="outline">{a.status || '—'}</Badge></TableCell>
                <TableCell><Caption1>{a.detectionSource || a.category || '—'}</Caption1></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function SimulateSection() {
  const s = useStyles();
  const [content, setContent] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [err, setErr] = useState<{ status: number; message: string; hint?: any } | null>(null);

  const run = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const r = await fetch('/api/admin/security/dlp/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const j = await r.json();
      if (!r.ok) setErr({ status: r.status, message: j?.error || `HTTP ${r.status}`, hint: j?.hint });
      else setResult(j.evaluation);
    } catch (e: any) {
      setErr({ status: 0, message: e?.message || String(e) });
    } finally { setRunning(false); }
  };

  return (
    <div className={s.section}>
      <Subtitle2 block style={{ marginBottom: 8 }}>Simulate DLP policy match <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 10 }}>
        Sends sample text to <code>POST /beta/security/dataLossPrevention/evaluatePolicies</code>. If the tenant hasn't enrolled in this Graph preview, the route returns 501 with explicit remediation.
      </Caption1>
      <div className={s.fieldStack}>
        <Field label="Sample content (up to 64 KB)">
          <Textarea rows={10} value={content} onChange={(_: unknown, d: any) => setContent(d.value)} placeholder="Paste a sample email body / document text…" />
        </Field>
        <div>
          <Button appearance="primary" disabled={!content.trim() || running} onClick={run}>
            {running ? 'Evaluating…' : 'Evaluate'}
          </Button>
        </div>
      </div>
      {err && (
        <MessageBar intent={err.status === 501 ? 'warning' : 'error'} style={{ marginTop: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Simulation {err.status === 501 ? 'unavailable' : 'failed'} (HTTP {err.status})</MessageBarTitle>
            {err.message}
            {err.hint?.followUp && (
              <Caption1 block style={{ marginTop: 6 }}>{err.hint.followUp}</Caption1>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {result !== null && (
        <div style={{ marginTop: 12 }}>
          <Subtitle2 block>Result</Subtitle2>
          <pre style={{ fontSize: 11, backgroundColor: tokens.colorNeutralBackground2, padding: 8, borderRadius: 4, overflow: 'auto', maxHeight: 300 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

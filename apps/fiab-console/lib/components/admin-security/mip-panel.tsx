'use client';

/**
 * MipPanel — Information Protection tab for /admin/security.
 *
 * Sub-tabs:
 *   - Labels    : list tenant sensitivity labels (Graph beta)
 *   - Policies  : list label policies (Graph beta)
 *   - Apply     : evaluate a label against sample text via Graph
 *
 * Everything is Graph-backed. A 503 from a route returns the
 * structured hint payload that names LOOM_MIP_ENABLED + required
 * Graph AppRoles + the bootstrap script that grants them.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Spinner, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Subtitle2,
  Textarea, Field, Input,
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
  // NOTE: makeStyles entries must resolve to class-name strings — a function
  // here makes `s.swatch` a non-callable string and crashed the panel with
  // "s.swatch is not a function". The per-label color is applied inline instead.
  swatch: {
    display: 'inline-block', width: '12px', height: '12px', borderRadius: '2px',
    marginRight: '6px', verticalAlign: 'middle', backgroundColor: '#888',
  },
});

interface ApiState<T> {
  loading: boolean;
  data: T | null;
  notConfigured?: NotConfiguredHint;
  error?: string;
  errorStatus?: number;
}

function emptyState<T>(): ApiState<T> { return { loading: false, data: null }; }

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<ApiState<T>> {
  try {
    const r = await fetch(url, init);
    const j = await r.json();
    if (r.status === 503 && j?.code?.endsWith('_not_configured')) {
      return { loading: false, data: null, notConfigured: j.hint, error: j.error, errorStatus: 503 };
    }
    if (!r.ok) return { loading: false, data: null, error: j?.error || `HTTP ${r.status}`, errorStatus: r.status };
    return { loading: false, data: j as T };
  } catch (e: any) { return { loading: false, data: null, error: e?.message || String(e) }; }
}

type SubTab = 'labels' | 'policies' | 'apply';

interface LabelsPayload {
  ok: boolean;
  labels?: Array<{
    id: string; name: string; displayName?: string; description?: string;
    tooltip?: string; color?: string; sensitivity?: number;
    isActive?: boolean; isAppliable?: boolean; parentId?: string | null;
    applicableTo?: string;
  }>;
}

interface PoliciesPayload {
  ok: boolean;
  policies?: Array<{
    id: string; name?: string; displayName?: string; description?: string;
    isMandatory?: boolean; defaultLabelId?: string; scopes?: string[];
  }>;
}

export function MipPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<SubTab>('labels');
  const [labels, setLabels] = useState<ApiState<LabelsPayload>>(emptyState());

  // Load labels once so all sub-tabs can use the lookup
  const loadLabels = useCallback(async () => {
    setLabels((p) => ({ ...p, loading: true }));
    setLabels(await fetchJson<LabelsPayload>('/api/admin/security/mip/labels'));
  }, []);
  useEffect(() => { loadLabels(); }, [loadLabels]);

  return (
    <div>
      <TabList
        className={s.subTabs}
        selectedValue={tab}
        onTabSelect={(_e: SelectTabEvent, d: SelectTabData) => setTab(d.value as SubTab)}
        size="small"
      >
        <Tab value="labels">Sensitivity labels</Tab>
        <Tab value="policies">Label policies</Tab>
        <Tab value="apply">Apply label</Tab>
      </TabList>

      {tab === 'labels' && <LabelsSection state={labels} onRefresh={loadLabels} />}
      {tab === 'policies' && <PoliciesSection labelsState={labels} />}
      {tab === 'apply' && <ApplyLabelSection labelsState={labels} />}
    </div>
  );
}

function LabelsSection({ state, onRefresh }: { state: ApiState<LabelsPayload>; onRefresh: () => void }) {
  const s = useStyles();
  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>Tenant sensitivity labels</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={onRefresh} disabled={state.loading}>Refresh</Button>
      </div>
      {state.loading && <Spinner label="Loading labels from Microsoft Graph…" />}
      {state.notConfigured && (
        <NotConfiguredBar surface="Sensitivity labels" hint={state.notConfigured}
          portalLink="https://compliance.microsoft.com/informationprotection"
          portalLabel="Open Information Protection (Microsoft Purview)" />
      )}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load labels (HTTP {state.errorStatus})</MessageBarTitle>
            {state.error}
            {state.errorStatus === 403 && (
              <Caption1 block style={{ marginTop: 6 }}>
                403 from Microsoft Graph typically means the <code>InformationProtectionPolicy.Read.All</code> AppRole has not been admin-consented for the Console UAMI. Run the post-deploy bootstrap job <code>Grant MIP+DLP Graph AppRoles</code> then have a Tenant Administrator click <em>Grant admin consent</em> in Entra → Enterprise applications → Console UAMI → Permissions.
              </Caption1>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.labels || []).length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
          No sensitivity labels found in this tenant. Define them in the Purview compliance portal under Information Protection.
        </Caption1>
      )}
      {state.data?.ok && (state.data.labels || []).length > 0 && (
        <Table size="small" aria-label="Sensitivity labels">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Label</TableHeaderCell>
              <TableHeaderCell>Sensitivity</TableHeaderCell>
              <TableHeaderCell>Parent</TableHeaderCell>
              <TableHeaderCell>Applicable to</TableHeaderCell>
              <TableHeaderCell>Active</TableHeaderCell>
              <TableHeaderCell>Tooltip</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.labels!.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  <span className={s.swatch} style={{ backgroundColor: l.color || '#888' }} />
                  <strong>{l.displayName || l.name}</strong>
                </TableCell>
                <TableCell>{l.sensitivity ?? '—'}</TableCell>
                <TableCell><Caption1>{l.parentId || '—'}</Caption1></TableCell>
                <TableCell><Badge appearance="outline">{l.applicableTo || 'file'}</Badge></TableCell>
                <TableCell>{l.isActive ? <Badge color="success">yes</Badge> : <Badge color="subtle">no</Badge>}</TableCell>
                <TableCell><Caption1>{(l.tooltip || l.description || '').slice(0, 120)}</Caption1></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function PoliciesSection({ labelsState }: { labelsState: ApiState<LabelsPayload> }) {
  const s = useStyles();
  const [state, setState] = useState<ApiState<PoliciesPayload>>(emptyState());
  useEffect(() => {
    (async () => {
      setState({ loading: true, data: null });
      setState(await fetchJson<PoliciesPayload>('/api/admin/security/mip/policies'));
    })();
  }, []);

  const lookupLabel = (id?: string): string | undefined => {
    if (!id) return undefined;
    return labelsState.data?.labels?.find((l) => l.id === id)?.displayName;
  };

  return (
    <div className={s.section}>
      <Subtitle2 block style={{ marginBottom: 8 }}>Label policies</Subtitle2>
      {state.loading && <Spinner label="Loading label policies…" />}
      {state.notConfigured && <NotConfiguredBar surface="Label policies" hint={state.notConfigured} />}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.policies || []).length === 0 && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No label policies configured. Define them in the Purview compliance portal.</Caption1>
      )}
      {state.data?.ok && (state.data.policies || []).length > 0 && (
        <Table size="small" aria-label="Label policies">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Scopes</TableHeaderCell>
              <TableHeaderCell>Mandatory</TableHeaderCell>
              <TableHeaderCell>Default label</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.policies!.map((p) => (
              <TableRow key={p.id}>
                <TableCell><strong>{p.displayName || p.name}</strong></TableCell>
                <TableCell>{(p.scopes || []).map((sc) => <Badge key={sc} appearance="outline" style={{ marginRight: 4 }}>{sc}</Badge>)}</TableCell>
                <TableCell>{p.isMandatory ? <Badge color="warning">yes</Badge> : <Badge color="subtle">no</Badge>}</TableCell>
                <TableCell>{lookupLabel(p.defaultLabelId) || p.defaultLabelId || '—'}</TableCell>
                <TableCell><Caption1>{(p.description || '').slice(0, 120)}</Caption1></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ApplyLabelSection({ labelsState }: { labelsState: ApiState<LabelsPayload> }) {
  const s = useStyles();
  const [itemId, setItemId] = useState('');
  const [content, setContent] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  const evaluate = async () => {
    setRunning(true); setErr(null); setResult(null);
    try {
      const r = await fetch('/api/admin/security/mip/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: itemId.trim() || undefined, contentSample: content }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j?.error || `HTTP ${r.status}`);
      else setResult(j.evaluation);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setRunning(false); }
  };

  return (
    <div className={s.section}>
      <Subtitle2 block style={{ marginBottom: 8 }}>Apply a sensitivity label</Subtitle2>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 10 }}>
        Sends sample content to Microsoft Graph (<code>POST /me/informationProtection/policy/labels/evaluateApplication</code>) and returns the recommended label. The MIP-side rule engine decides — Loom only relays.
      </Caption1>
      <div className={s.fieldStack}>
        <Field label="Loom item id (optional, for audit only)">
          <Input value={itemId} onChange={(_: unknown, d: any) => setItemId(d.value)} placeholder="item-12345" />
        </Field>
        <Field label="Content sample (up to 64 KB)">
          <Textarea
            rows={8}
            value={content}
            onChange={(_: unknown, d: any) => setContent(d.value)}
            placeholder="Paste a few lines of content from the item here…"
          />
        </Field>
        <div>
          <Button appearance="primary" disabled={!content.trim() || running} onClick={evaluate}>
            {running ? 'Evaluating…' : 'Evaluate'}
          </Button>
        </div>
      </div>
      {err && (
        <MessageBar intent="error" style={{ marginTop: 12 }}>
          <MessageBarBody><MessageBarTitle>Evaluation failed</MessageBarTitle>{err}</MessageBarBody>
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
      {labelsState.data?.labels && (
        <Caption1 block style={{ marginTop: 12, color: tokens.colorNeutralForeground3 }}>
          {labelsState.data.labels.length} labels available in this tenant.
        </Caption1>
      )}
    </div>
  );
}

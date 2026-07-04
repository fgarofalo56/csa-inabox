'use client';

import { clientFetch } from '@/lib/client-fetch';
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
  Textarea, Field, Dropdown, Option, Input,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, ShieldProhibited24Regular, ShieldLock20Regular, AlertBadge20Regular, ClipboardTextLtr20Regular, History20Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { NotConfiguredBar, type NotConfiguredHint } from './not-configured-bar';
import { DlpManagePolicies } from './dlp-manage-policies';
import { IdentityPicker, type IdentityHit } from '../ui/identity-picker';

const useStyles = makeStyles({
  subTabs: { marginBottom: tokens.spacingVerticalM },
  section: {
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS, alignItems: 'center' },
  fieldStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, maxWidth: '720px' },
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

type SubTab = 'policies' | 'violations' | 'alerts' | 'restrict' | 'simulate';

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
        <Tab value="restrict">Restrict access</Tab>
        <Tab value="simulate">Simulate</Tab>
      </TabList>

      {tab === 'policies' && <PoliciesSection />}
      {tab === 'violations' && <ViolationsSection />}
      {tab === 'alerts' && <AlertsSection />}
      {tab === 'restrict' && <RestrictSection />}
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
      {/* Real DLP policy CRUD (Security & Compliance PowerShell sidecar). Honest-
          gated when LOOM_DLP_ADMIN_ENABLED is unset; the read-only Graph list
          below still works. */}
      <DlpManagePolicies />

      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>DLP policies (Graph read) <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
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
              <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}>
                403 indicates the <code>Policy.Read.All</code> AppRole has not been admin-consented for the Console UAMI. Run the post-deploy bootstrap job <code>Grant MIP+DLP Graph AppRoles</code> then grant admin consent.
              </Caption1>
            )}
            {state.errorStatus === 404 && (
              <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}>
                The Graph DLP /beta endpoint returned 404 — this tenant is likely not enrolled in the DLP-via-Graph preview. Open a Microsoft support ticket referencing <code>/beta/informationProtection/dataLossPreventionPolicies</code>. The Restrict-access tab works without this preview.
              </Caption1>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.policies || []).length === 0 && (
        <EmptyState
          icon={<ClipboardTextLtr20Regular />}
          title="No DLP policies"
          body="No Microsoft Purview DLP policies are configured for this tenant. Create policies in the Microsoft Purview compliance portal."
          primaryAction={{ label: 'Open Purview compliance portal', href: 'https://compliance.microsoft.com/datalossprevention', appearance: 'primary' }}
        />
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
                <TableCell>{(p.locations || []).map((l) => <Badge key={l} appearance="outline" style={{ marginRight: tokens.spacingHorizontalXS }}>{l}</Badge>)}</TableCell>
                <TableCell>{p.ruleCount ?? '—'}</TableCell>
                <TableCell><Caption1>{p.lastModifiedDateTime?.slice(0, 16) || '—'}</Caption1></TableCell>
                <TableCell><Button size="small" onClick={() => showRules(p.id)}>Rules</Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selected && (
        <div style={{ marginTop: tokens.spacingVerticalL }}>
          <Subtitle2 block>Rules for {selected}</Subtitle2>
          {rules.loading && <Spinner label="Loading rules…" />}
          {rules.error && (
            <MessageBar intent="error"><MessageBarBody>{rules.error}</MessageBarBody></MessageBar>
          )}
          {rules.data?.ok && (rules.data.rules || []).length === 0 && (
            <EmptyState
              icon={<ClipboardTextLtr20Regular />}
              title="No rules"
              body="This policy has no rules defined yet."
            />
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
        <EmptyState
          icon={<ShieldLock20Regular />}
          title="No violations"
          body="No DLP violations were detected in the last 30 days. This is a healthy signal — policies are either not triggered or not yet enforced."
        />
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
                  {v.itemType ? <Badge appearance="outline" size="small" style={{ marginLeft: tokens.spacingHorizontalXS }}>{v.itemType}</Badge> : null}
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
        <EmptyState
          icon={<AlertBadge20Regular />}
          title="No alerts"
          body="No DLP alerts were generated in the last 30 days."
        />
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

// ────────────────────────────────────────────────────────────────────────────
// Restrict access — Azure-native DLP "Restrict access" enforcement.
//
// Fabric DLP's "Restrict access" action has no Fabric dependency in Loom: it
// revokes REAL data-plane access on the Azure-native scope (ADLS Gen2 RBAC /
// POSIX ACL, Synapse SQL DENY, ADX). Backed by POST /api/governance/dlp/restrict
// (real ARM DELETE + read-back / TDS DENY / ADX revoke, recorded in Cosmos).
// Works in every cloud with LOOM_DEFAULT_FABRIC_WORKSPACE unset — no Graph,
// no Purview, no Fabric. This is the audit-T99 Azure-native parity surface.
// ────────────────────────────────────────────────────────────────────────────

type RestrictScope = 'adls-container' | 'adls-path' | 'warehouse' | 'warehouse-schema' | 'kql-database';

const RESTRICT_SCOPES: { key: RestrictScope; label: string }[] = [
  { key: 'adls-container', label: 'ADLS container (Storage RBAC)' },
  { key: 'adls-path', label: 'ADLS path (POSIX ACL)' },
  { key: 'warehouse', label: 'Warehouse (Synapse SQL role)' },
  { key: 'warehouse-schema', label: 'Warehouse schema (DENY SELECT)' },
  { key: 'kql-database', label: 'KQL database (ADX)' },
];

interface RestrictResult {
  ok: boolean; restricted?: boolean; armConfirmed?: boolean; aclConfirmed?: boolean;
  revokedRoleNames?: string[]; policiesUpdated?: number; note?: string; detail?: string; error?: string;
}
interface RestrictionRow {
  id: string; at: string; principalName?: string; principalId: string;
  scopeType: string; scopeRef: string; subPath?: string; schema?: string;
  revokedRoleNames?: string[]; armConfirmed?: boolean; aclConfirmed?: boolean;
}

function RestrictSection() {
  const s = useStyles();
  const [scope, setScope] = useState<RestrictScope>('adls-container');
  const [containers, setContainers] = useState<string[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);
  const [container, setContainer] = useState('');
  const [subPath, setSubPath] = useState('');
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemaGate, setSchemaGate] = useState<string | null>(null);
  const [schema, setSchema] = useState('');
  const [kqlDbs, setKqlDbs] = useState<{ id: string; name: string }[]>([]);
  const [kqlLoading, setKqlLoading] = useState(true);
  const [kqlDb, setKqlDb] = useState('');
  const [principal, setPrincipal] = useState<IdentityHit | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RestrictResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<RestrictionRow[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const j = await clientFetch('/api/governance/dlp/meta').then((r) => r.json());
      setHistory(Array.isArray(j?.restrictions) ? j.restrictions : []);
    } catch { /* best-effort */ } finally { setHistoryLoaded(true); }
  }, []);

  useEffect(() => {
    setContainersLoading(true);
    clientFetch('/api/lakehouse/containers').then((r) => r.json())
      .then((d) => setContainers((d?.containers || []).map((c: any) => c.name).filter(Boolean)))
      .catch(() => {})
      .finally(() => setContainersLoading(false));
    setKqlLoading(true);
    clientFetch('/api/items/by-type?types=kql-database').then((r) => r.json())
      .then((d) => setKqlDbs((d?.items || []).map((x: any) => ({ id: x.id, name: x.displayName || x.id }))))
      .catch(() => {})
      .finally(() => setKqlLoading(false));
    loadHistory();
  }, [loadHistory]);

  // Synapse schemas load lazily when the warehouse-schema scope is chosen.
  useEffect(() => {
    if (scope !== 'warehouse-schema') return;
    setSchemaGate(null);
    setSchemasLoading(true);
    clientFetch('/api/governance/dlp/schemas').then(async (r) => {
      const j = await r.json();
      if (r.status === 503 || j?.code === 'warehouse_not_configured') {
        setSchemas([]); setSchemaGate(j?.error || 'The Azure-native warehouse is not configured.');
        return;
      }
      setSchemas(j?.ok ? (j.schemas || []) : []);
    }).catch((e: any) => { setSchemas([]); setSchemaGate(e?.message || String(e)); })
      .finally(() => setSchemasLoading(false));
  }, [scope]);

  const needsRef = scope === 'adls-container' || scope === 'adls-path' || scope === 'kql-database';
  const scopeRef = scope === 'kql-database' ? kqlDb
    : (scope === 'warehouse' || scope === 'warehouse-schema') ? 'warehouse' : container;

  const canRun = !!principal && !running &&
    (!needsRef || !!scopeRef) &&
    (scope !== 'adls-path' || !!subPath.trim()) &&
    (scope !== 'warehouse-schema' || !!schema);

  const run = async () => {
    if (!principal) { setErr('Select a principal to restrict.'); return; }
    setRunning(true); setErr(null); setResult(null);
    try {
      const r = await clientFetch('/api/governance/dlp/restrict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeType: scope,
          scopeRef,
          subPath: scope === 'adls-path' ? subPath.trim() : undefined,
          schema: scope === 'warehouse-schema' ? schema : undefined,
          principalId: principal.id,
          principalName: principal.upn || principal.mail || principal.displayName,
          principalType: principal.type === 'group' ? 'Group' : principal.type === 'spn' ? 'ServicePrincipal' : 'User',
        }),
      });
      const j: RestrictResult = await r.json();
      if (!r.ok || j.ok === false) {
        setErr(j.error || `HTTP ${r.status}`);
      } else {
        setResult(j);
        loadHistory();
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setRunning(false); }
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>Restrict access</Subtitle2>
        <Button icon={<ArrowSync24Regular />} onClick={loadHistory}>Refresh history</Button>
      </div>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalMNudge }}>
        The Azure-native equivalent of Microsoft Purview DLP&apos;s &quot;Restrict access&quot; action.
        Revokes a principal&apos;s real data-plane access on the selected scope — Storage RBAC / POSIX ACL,
        Synapse SQL <code>DENY</code>, or ADX — and records the change. No Microsoft Fabric or Power BI
        dependency; works against the Azure-native backend directly.
      </Caption1>

      <div className={s.fieldStack}>
        <Field label="Scope type">
          <Dropdown
            value={RESTRICT_SCOPES.find((x) => x.key === scope)?.label}
            selectedOptions={[scope]}
            onOptionSelect={(_, d) => { setScope(d.optionValue as RestrictScope); setResult(null); setErr(null); }}
          >
            {RESTRICT_SCOPES.map((x) => <Option key={x.key} value={x.key}>{x.label}</Option>)}
          </Dropdown>
        </Field>

        {(scope === 'adls-container' || scope === 'adls-path') && (
          <Field label="ADLS container">
            <Dropdown
              placeholder={containersLoading ? 'Loading containers…' : containers.length ? 'Select a container' : 'No containers found'}
              value={container}
              selectedOptions={container ? [container] : []}
              onOptionSelect={(_, d) => setContainer(d.optionValue || '')}
            >
              {containers.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
        )}
        {scope === 'adls-path' && (
          <Field label="Path under the container (directory or file)" hint="e.g. bronze/finance/q1.parquet">
            <Input value={subPath} onChange={(_, d) => setSubPath(d.value)} placeholder="directory/or/file" />
          </Field>
        )}
        {scope === 'kql-database' && (
          <Field label="KQL database">
            <Dropdown
              placeholder={kqlLoading ? 'Loading KQL databases…' : kqlDbs.length ? 'Select a KQL database' : 'No KQL databases found'}
              value={kqlDbs.find((k) => k.id === kqlDb)?.name}
              selectedOptions={kqlDb ? [kqlDb] : []}
              onOptionSelect={(_, d) => setKqlDb(d.optionValue || '')}
            >
              {kqlDbs.map((k) => <Option key={k.id} value={k.id}>{k.name}</Option>)}
            </Dropdown>
          </Field>
        )}
        {scope === 'warehouse-schema' && (
          <Field label="Warehouse schema (DENY SELECT)">
            {schemaGate ? (
              <MessageBar intent="warning"><MessageBarBody>{schemaGate}</MessageBarBody></MessageBar>
            ) : (
              <Dropdown
                placeholder={schemasLoading ? 'Loading schemas…' : schemas.length ? 'Select a schema' : 'No schemas found'}
                value={schema}
                selectedOptions={schema ? [schema] : []}
                onOptionSelect={(_, d) => setSchema(d.optionValue || '')}
              >
                {schemas.map((sc) => <Option key={sc} value={sc}>{sc}</Option>)}
              </Dropdown>
            )}
          </Field>
        )}
        {scope === 'warehouse' && (
          <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
            Targets the env-bound Synapse dedicated SQL pool (warehouse). Revokes the principal&apos;s read/write/admin grants.
          </Caption1>
        )}

        <Field label="Principal to restrict">
          <IdentityPicker selected={principal} onSelect={(h) => setPrincipal(h || null)} placeholder="Search users, groups, or service principals…" />
        </Field>

        <div>
          <Button appearance="primary" icon={<ShieldProhibited24Regular />} disabled={!canRun} onClick={run}>
            {running ? 'Restricting…' : 'Restrict access'}
          </Button>
        </div>
      </div>

      {err && (
        <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Restrict failed</MessageBarTitle>{err}</MessageBarBody>
        </MessageBar>
      )}
      {result && (
        <MessageBar intent={result.restricted ? 'success' : 'info'} style={{ marginTop: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>{result.restricted ? 'Access restricted' : 'Nothing to revoke'}</MessageBarTitle>
            {result.detail || (result.restricted
              ? `Revoked: ${(result.revokedRoleNames || []).join(', ') || '—'}${result.armConfirmed ? ' (ARM read-back confirmed)' : ''}${result.aclConfirmed ? ' (ACL read-back confirmed)' : ''}.`
              : 'The principal held no matching access on this scope.')}
            {typeof result.policiesUpdated === 'number' && result.policiesUpdated > 0 && (
              <Caption1 block style={{ marginTop: tokens.spacingVerticalXS }}>{result.policiesUpdated} matching Access policy marked restricted.</Caption1>
            )}
            {result.note && <Caption1 block style={{ marginTop: tokens.spacingVerticalXS }}>{result.note}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      )}

      {historyLoaded && history.length === 0 && (
        <EmptyState
          icon={<History20Regular />}
          title="No restrict-access actions"
          body="No restrict-access actions have been recorded yet. Use the form above to revoke a principal's data-plane access."
        />
      )}
      {history.length > 0 && (
        <div style={{ marginTop: tokens.spacingVerticalL }}>
          <Subtitle2 block style={{ marginBottom: tokens.spacingVerticalSNudge }}>Recent restrict-access actions</Subtitle2>
          <Table size="small" aria-label="DLP restrict-access history">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>When</TableHeaderCell>
                <TableHeaderCell>Principal</TableHeaderCell>
                <TableHeaderCell>Scope</TableHeaderCell>
                <TableHeaderCell>Revoked</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.slice(0, 10).map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Caption1>{r.at?.slice(0, 16) || '—'}</Caption1></TableCell>
                  <TableCell><Caption1>{r.principalName || r.principalId}</Caption1></TableCell>
                  <TableCell>
                    <Caption1>{
                      r.scopeType === 'adls-container' ? r.scopeRef
                        : r.scopeType === 'adls-path' ? `${r.scopeRef}/${r.subPath || ''}`
                        : r.scopeType === 'warehouse-schema' ? `schema ${r.schema || ''}`
                        : r.scopeType
                    }</Caption1>
                  </TableCell>
                  <TableCell><Caption1>{(r.revokedRoleNames || []).join(', ') || '—'}</Caption1></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
      const r = await clientFetch('/api/admin/security/dlp/simulate', {
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
      <Subtitle2 block style={{ marginBottom: tokens.spacingVerticalS }}>Simulate DLP policy match <Badge appearance="tint" color="warning">Preview</Badge></Subtitle2>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalMNudge }}>
        Microsoft Graph exposes no public REST API to simulate DLP policies, so this returns an honest 501 gate (no fabricated results). Test a policy in the Microsoft Purview portal (Data loss prevention &rarr; Policies &rarr; &ldquo;Test policy&rdquo;) or via Security &amp; Compliance PowerShell.
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
        <MessageBar intent={err.status === 501 ? 'warning' : 'error'} style={{ marginTop: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>Simulation {err.status === 501 ? 'unavailable' : 'failed'} (HTTP {err.status})</MessageBarTitle>
            {err.message}
            {err.hint?.followUp && (
              <Caption1 block style={{ marginTop: tokens.spacingVerticalSNudge }}>{err.hint.followUp}</Caption1>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {result !== null && (
        <div style={{ marginTop: tokens.spacingVerticalM }}>
          <Subtitle2 block>Result</Subtitle2>
          <pre style={{ fontSize: tokens.fontSizeBase100, backgroundColor: tokens.colorNeutralBackground2, padding: tokens.spacingVerticalS, borderRadius: 4, overflow: 'auto', maxHeight: 300 }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

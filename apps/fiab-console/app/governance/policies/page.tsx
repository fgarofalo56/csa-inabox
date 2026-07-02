'use client';

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Dropdown, Option, Switch, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Subtitle2, Divider, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { Add24Regular, ArrowSync24Regular, Delete20Regular, Folder20Regular, Document20Regular, ArrowUp16Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Policy {
  id: string;
  name: string;
  kind: 'DLP' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  enforcement?: { status: 'active' | 'pending' | 'error'; roleName?: string; roleAssignmentId?: string; detail?: string };
  /** Set true by the DLP restrict-access action when this grant was revoked. */
  dlpRestricted?: boolean;
  dlpRestrictedAt?: string;
}

interface DlpViolation {
  alertId: string; policyName?: string; ruleName?: string; severity?: string; status?: string;
  user?: string; itemPath?: string; itemType?: string; workload?: string; action?: string; detectedAt?: string;
}
interface DlpMeta {
  boundary: string;
  dlpPolicyApiAvailable: boolean;
  enabled?: boolean;
  lastScannedAt?: string;
  scanTriggeredAt?: string;
  restrictions?: Array<{ id: string; at: string; principalName?: string; principalId: string; scopeType: string; scopeRef: string; subPath?: string; schema?: string; revokedRoleNames: string[]; armConfirmed: boolean; aclConfirmed?: boolean }>;
}

const KINDS = ['DLP', 'Masking', 'RLS', 'Retention', 'Access'] as const;

const useStyles = makeStyles({
  empty: { padding: tokens.spacingVerticalXXL, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, textAlign: 'center' },
  rule: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dlpToolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginBottom: tokens.spacingVerticalS, flexWrap: 'wrap' },
  pickList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' },
  chips: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

function kindColor(k: string): any {
  return k === 'DLP' || k === 'Retention' ? 'danger' :
         k === 'Masking' || k === 'RLS' ? 'warning' : 'informative';
}

export default function PoliciesPage() {
  const s = useStyles();
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cosmosGate, setCosmosGate] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // ── DLP (F22) — violations, last-scan, trigger-scan, restrict-access ────────
  const [dlpMeta, setDlpMeta] = useState<DlpMeta | null>(null);
  const [violations, setViolations] = useState<DlpViolation[]>([]);
  const [vLoading, setVLoading] = useState(false);
  const [vErr, setVErr] = useState<string | null>(null);
  const [vGate, setVGate] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<{ intent: 'warning' | 'success' | 'error'; title: string; body: string; portalLink?: string } | null>(null);
  // Restrict-access dialog
  const [rstOpen, setRstOpen] = useState(false);
  const [rstScope, setRstScope] = useState<'adls-container' | 'adls-path' | 'warehouse' | 'warehouse-schema' | 'kql-database'>('adls-container');
  const [rstRef, setRstRef] = useState('');
  // adls-path: container + drill-down directory picker; warehouse-schema: schema dropdown.
  const [rstSubPath, setRstSubPath] = useState('');
  const [rstPathItems, setRstPathItems] = useState<Array<{ name: string; isDirectory: boolean }>>([]);
  const [rstPathLoading, setRstPathLoading] = useState(false);
  const [rstSchema, setRstSchema] = useState('');
  const [rstSchemas, setRstSchemas] = useState<string[]>([]);
  const [rstSchemaGate, setRstSchemaGate] = useState<string | null>(null);
  const [rstQuery, setRstQuery] = useState('');
  const [rstKind, setRstKind] = useState<'user' | 'group'>('user');
  const [rstResults, setRstResults] = useState<Array<{ id: string; type: string; displayName: string; upn?: string }>>([]);
  const [rstSearching, setRstSearching] = useState(false);
  const [rstPicked, setRstPicked] = useState<{ id: string; name: string; type: 'User' | 'Group'; upn?: string } | null>(null);
  const [rstExempt, setRstExempt] = useState<Array<{ id: string; name: string }>>([]);
  const [rstBusy, setRstBusy] = useState(false);
  const [rstMsg, setRstMsg] = useState<{ intent: 'success' | 'error' | 'warning'; title: string; body: string } | null>(null);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftKind, setDraftKind] = useState<typeof KINDS[number]>('DLP');
  // Scope = selectable dropdowns (type + target) instead of a freeform string.
  const [scopeType, setScopeType] = useState<'tenant' | 'domain' | 'workspace'>('tenant');
  const [scopeTarget, setScopeTarget] = useState('');
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [domains, setDomains] = useState<Array<{ id: string; name: string }>>([]);
  // Per-kind rule wizard fields.
  const [w, setW] = useState<Record<string, string>>({
    dlpDetect: 'Email', dlpAction: 'Audit',
    maskColumn: '', maskFn: 'Hash',
    rlsColumn: '', rlsOp: '=', rlsValue: '',
    retPeriod: '90', retUnit: 'Days', retAction: 'Delete',
    accPrincipal: '', accPermission: 'Read',
  });
  const setWf = (k: string, v: string) => setW((p) => ({ ...p, [k]: v }));
  // Access policy: Entra principal search + ADLS container scope (real RBAC).
  const [accQuery, setAccQuery] = useState('');
  const [accKind, setAccKind] = useState<'user' | 'group'>('user');
  const [accResults, setAccResults] = useState<Array<{ id: string; type: string; displayName: string; upn?: string }>>([]);
  const [accSearching, setAccSearching] = useState(false);
  const [accPicked, setAccPicked] = useState<{ id: string; name: string; type: 'User' | 'Group'; upn?: string } | null>(null);
  const [accContainer, setAccContainer] = useState('');
  // Which data-plane the grant binds to: ADLS container · warehouse (Synapse SQL)
  // · KQL database (ADX). Each is a real Azure-native grant (no Fabric dep).
  const [accScope, setAccScope] = useState<'adls-container' | 'warehouse' | 'kql-database'>('adls-container');
  const [accKqlDb, setAccKqlDb] = useState('');
  const [kqlItems, setKqlItems] = useState<Array<{ id: string; name: string }>>([]);
  // ADLS containers (shared by the access + restrict ADLS-path pickers).
  const [containers, setContainers] = useState<string[]>([]);

  const searchPrincipals = useCallback(async () => {
    const q = accQuery.trim();
    if (q.length < 2) { setAccResults([]); return; }
    setAccSearching(true);
    try {
      const r = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&type=${accKind}`);
      const j = await r.json();
      setAccResults(j.ok ? (j.results || []) : []);
    } catch { setAccResults([]); }
    finally { setAccSearching(false); }
  }, [accQuery, accKind]);

  useEffect(() => {
    clientFetch('/api/workspaces').then((r) => r.json()).then((d) => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list.map((x: any) => ({ id: x.id, name: x.name || x.displayName || x.id })));
    }).catch(() => {});
    clientFetch('/api/admin/domains').then((r) => r.json()).then((d) => {
      setDomains((d?.domains || []).map((x: any) => ({ id: x.id, name: x.name || x.id })));
    }).catch(() => {});
    clientFetch('/api/items/by-type?types=kql-database').then((r) => r.json()).then((d) => {
      setKqlItems((d?.items || []).map((x: any) => ({ id: x.id, name: x.displayName || x.id })));
    }).catch(() => {});
    clientFetch('/api/lakehouse/containers').then((r) => r.json()).then((d) => {
      setContainers((d?.containers || []).map((c: any) => c.name).filter(Boolean));
    }).catch(() => {});
  }, []);

  // Drill the directory tree of an ADLS container for the restrict path picker.
  const loadRstPaths = useCallback(async (container: string, prefix: string) => {
    if (!container) { setRstPathItems([]); return; }
    setRstPathLoading(true);
    try {
      const r = await clientFetch(`/api/lakehouse/paths?container=${encodeURIComponent(container)}&prefix=${encodeURIComponent(prefix)}`);
      const j = await r.json();
      setRstPathItems(j.ok ? (j.paths || []).map((p: any) => ({ name: p.name, isDirectory: !!p.isDirectory })) : []);
    } catch { setRstPathItems([]); }
    finally { setRstPathLoading(false); }
  }, []);

  // Enumerate Synapse SQL schemas for the warehouse-schema restrict dropdown.
  const loadRstSchemas = useCallback(async () => {
    setRstSchemaGate(null);
    try {
      const r = await clientFetch('/api/governance/dlp/schemas');
      const j = await r.json();
      if (r.status === 503 || j?.code === 'warehouse_not_configured') {
        setRstSchemas([]); setRstSchemaGate(j?.error || 'The Azure-native warehouse is not configured.');
        return;
      }
      setRstSchemas(j.ok ? (j.schemas || []) : []);
    } catch (e: any) { setRstSchemas([]); setRstSchemaGate(e?.message || String(e)); }
  }, []);

  const buildScope = (): string => scopeType === 'tenant' ? 'tenant' : `${scopeType}:${scopeTarget}`;
  const buildRule = (): string => {
    switch (draftKind) {
      case 'DLP': return `detect:${w.dlpDetect} action:${w.dlpAction}`;
      case 'Masking': return `mask column:${w.maskColumn || '<column>'} using:${w.maskFn}`;
      case 'RLS': return `filter ${w.rlsColumn || '<column>'} ${w.rlsOp} ${w.rlsValue || '<value>'}`;
      case 'Retention': return `retain ${w.retPeriod} ${w.retUnit} then:${w.retAction}`;
      case 'Access': {
        const tgt = accScope === 'adls-container' ? (accContainer || '<container>')
          : accScope === 'kql-database' ? (accKqlDb || '<kql db>')
          : 'warehouse (Synapse SQL)';
        return `grant ${accPicked?.name || '<principal>'} ${w.accPermission} on ${tgt}`;
      }
      default: return '';
    }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null); setCosmosGate(null);
    try {
      const r = await clientFetch('/api/governance/policies');
      const j = await r.json();
      if (r.status === 503 && j?.code === 'cosmos_not_configured') {
        setCosmosGate(j?.gate?.message || 'Cosmos DB is not configured in this deployment.');
        setPolicies([]);
        return;
      }
      if (!j.ok) { setError(j.error); return; }
      setPolicies(j.policies || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Load DLP surface metadata (boundary gate + last-scan) and per-item violations.
  const loadDlp = useCallback(async () => {
    setVLoading(true); setVErr(null); setVGate(null);
    try {
      const m = await clientFetch('/api/governance/dlp/meta').then((x) => x.json()).catch(() => null);
      if (m?.ok) setDlpMeta(m);
      const r = await clientFetch('/api/governance/dlp/violations?top=100');
      const j = await r.json();
      if (r.status === 503 && j?.code === 'dlp_not_configured') {
        setVGate(j?.hint?.followUp || j?.error || 'DLP is not wired in this deployment.');
        setViolations([]);
        return;
      }
      if (!j.ok) { setVErr(j.error || `HTTP ${r.status}`); return; }
      setViolations(j.violations || []);
      if (j.lastScannedAt) setDlpMeta((prev) => prev ? { ...prev, lastScannedAt: j.lastScannedAt } : prev);
    } catch (e: any) { setVErr(e?.message || String(e)); }
    finally { setVLoading(false); }
  }, []);
  useEffect(() => { loadDlp(); }, [loadDlp]);

  async function triggerScan() {
    setScanning(true); setScanMsg(null);
    try {
      const r = await clientFetch('/api/governance/dlp/scan', { method: 'POST' });
      const j = await r.json();
      if (r.status === 501 || j?.code === 'dlp_scan_trigger_unavailable') {
        setScanMsg({
          intent: 'warning',
          title: 'Scanner trigger routes through Purview',
          body: j?.error || 'No Graph REST API triggers the Purview scanner.',
          portalLink: j?.portalLink,
        });
      } else if (j?.ok) {
        setScanMsg({ intent: 'success', title: 'Scan requested', body: 'A content scan was started.' });
      } else {
        setScanMsg({ intent: 'error', title: `Scan request failed (HTTP ${r.status})`, body: j?.error || 'Unknown error' });
      }
      // refresh last-scan/last-requested timestamps
      loadDlp();
    } catch (e: any) {
      setScanMsg({ intent: 'error', title: 'Scan request failed', body: e?.message || String(e) });
    } finally { setScanning(false); }
  }

  const searchRst = useCallback(async () => {
    const q = rstQuery.trim();
    if (q.length < 2) { setRstResults([]); return; }
    setRstSearching(true);
    try {
      const r = await clientFetch(`/api/admin/permissions/principals?q=${encodeURIComponent(q)}&type=${rstKind}`);
      const j = await r.json();
      setRstResults(j.ok ? (j.results || []) : []);
    } catch { setRstResults([]); }
    finally { setRstSearching(false); }
  }, [rstQuery, rstKind]);

  async function doRestrict() {
    if (!rstPicked) { setRstMsg({ intent: 'error', title: 'Pick a principal', body: 'Search and select the user/group to restrict.' }); return; }
    if ((rstScope === 'adls-container' || rstScope === 'adls-path' || rstScope === 'kql-database') && !rstRef.trim()) {
      setRstMsg({ intent: 'error', title: 'Scope required', body: `Select the ${rstScope === 'kql-database' ? 'KQL database' : 'ADLS container'} to restrict.` });
      return;
    }
    if (rstScope === 'adls-path' && !rstSubPath.trim()) {
      setRstMsg({ intent: 'error', title: 'Path required', body: 'Select the directory/file under the container to restrict.' });
      return;
    }
    if (rstScope === 'warehouse-schema' && !rstSchema) {
      setRstMsg({ intent: 'error', title: 'Schema required', body: 'Select the SQL schema to deny access on.' });
      return;
    }
    setRstBusy(true); setRstMsg(null);
    try {
      const r = await clientFetch('/api/governance/dlp/restrict', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scopeType: rstScope,
          scopeRef: (rstScope === 'warehouse' || rstScope === 'warehouse-schema') ? 'warehouse' : rstRef.trim(),
          subPath: rstScope === 'adls-path' ? rstSubPath.trim() : undefined,
          schema: rstScope === 'warehouse-schema' ? rstSchema : undefined,
          principalId: rstPicked.id,
          principalName: rstPicked.upn || rstPicked.name,
          principalType: rstPicked.type,
          exemptPrincipalIds: rstExempt.map((e) => e.id),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setRstMsg({ intent: 'error', title: `Restrict failed (HTTP ${r.status})`, body: j?.error || 'Unknown error' }); return; }
      if (j.skippedExempt) {
        setRstMsg({ intent: 'warning', title: 'Principal exempt', body: j.detail || 'Left intact (on exempt list).' });
      } else if (!j.restricted) {
        setRstMsg({ intent: 'warning', title: 'Nothing to revoke', body: j.detail || 'Principal held no matching access.' });
      } else {
        const roles = (j.revokedRoleNames || []).join(', ') || '—';
        const confirmedNote = j.armConfirmed ? ' Confirmed via ARM read-back.' : j.aclConfirmed ? ' Confirmed via ACL read-back.' : '';
        setRstMsg({
          intent: 'success',
          title: 'Access restricted',
          body: `Revoked ${roles} for ${rstPicked.name}.${confirmedNote}${j.policiesUpdated ? ` ${j.policiesUpdated} policy record(s) updated.` : ''}${j.note ? ` ${j.note}` : ''}`,
        });
      }
      loadDlp(); load();
    } catch (e: any) { setRstMsg({ intent: 'error', title: 'Restrict failed', body: e?.message || String(e) }); }
    finally { setRstBusy(false); }
  }

  // Best-effort per-policy violation count: match a DLP-kind policy by name
  // against the violation's policy name (Graph alerts_v2 doesn't reliably carry
  // the governance policy id, so this is honest substring matching; unmatched
  // DLP policies show a neutral "monitored" tip).
  function violationTipFor(p: Policy): { count: number } {
    if (p.kind !== 'DLP') return { count: 0 };
    const name = (p.name || '').toLowerCase();
    if (!name) return { count: 0 };
    const count = violations.filter((v) => {
      const vn = (v.policyName || '').toLowerCase();
      return vn && (vn.includes(name) || name.includes(vn));
    }).length;
    return { count };
  }

  async function create() {
    if (!draftName.trim()) { setActionErr('name required'); return; }
    const body: Record<string, unknown> = { name: draftName.trim(), kind: draftKind, scope: buildScope(), rule: buildRule(), enabled: true };
    if (draftKind === 'Access') {
      if (!accPicked) { setActionErr('Search and pick a principal for the access policy.'); return; }
      body.principalId = accPicked.id;
      body.principalName = accPicked.upn || accPicked.name;
      body.principalType = accPicked.type;
      body.scopeType = accScope;
      if (accScope === 'adls-container') {
        if (!accContainer.trim()) { setActionErr('Enter the ADLS container the grant applies to.'); return; }
        body.scopeRef = accContainer.trim();
      } else if (accScope === 'kql-database') {
        if (!accKqlDb) { setActionErr('Pick the KQL database the grant applies to.'); return; }
        body.scopeRef = accKqlDb;
      } else {
        // warehouse → the configured Synapse dedicated pool (resolved server-side).
        body.scopeRef = 'warehouse';
      }
      body.permission = (w.accPermission || 'Read').toLowerCase();
    }
    setBusy(true); setActionErr(null);
    try {
      const r = await clientFetch('/api/governance/policies', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); if (j.policies) setPolicies(j.policies); return; }
      setPolicies(j.policies);
      setOpen(false);
      setDraftName(''); setScopeType('tenant'); setScopeTarget('');
      setAccPicked(null); setAccContainer(''); setAccQuery(''); setAccResults([]);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  async function toggle(p: Policy) {
    try {
      const r = await clientFetch('/api/governance/policies', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: p.id, enabled: !p.enabled }),
      });
      const j = await r.json();
      if (j.ok) setPolicies(j.policies);
      else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this policy?')) return;
    try {
      const r = await clientFetch(`/api/governance/policies?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) setPolicies(j.policies);
      else setActionErr(j.error);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const policyColumns: LoomColumn<Policy>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (p) => p.name, render: (p) => <strong>{p.name}</strong> },
    { key: 'kind', label: 'Kind', sortable: true, filterable: true, width: 120, getValue: (p) => p.kind, render: (p) => <Badge appearance="filled" color={kindColor(p.kind)} size="small">{p.kind}</Badge> },
    { key: 'scope', label: 'Scope', sortable: true, filterable: true, getValue: (p) => p.scope },
    {
      key: 'rule', label: 'Rule', sortable: false, filterable: true, getValue: (p) => p.rule || '',
      render: (p) => {
        const tip = violationTipFor(p);
        return (
          <span>
            <code className={s.rule}>{p.rule || '—'}</code>
            {p.enforcement && (
              <Badge appearance="tint" size="small" style={{ marginLeft: 6 }}
                color={p.enforcement.status === 'active' ? 'success' : p.enforcement.status === 'error' ? 'danger' : 'warning'}
                title={p.enforcement.detail || p.enforcement.roleName}>
                {p.enforcement.status === 'active' ? `enforced${p.enforcement.roleName ? ` · ${p.enforcement.roleName.replace('Storage Blob Data ', '')}` : ''}` : p.enforcement.status}
              </Badge>
            )}
            {/* DLP per-item policy-tip badge (best-effort name match). */}
            {p.kind === 'DLP' && (
              <Tooltip relationship="label" content={tip.count > 0
                ? `${tip.count} active DLP violation(s) matched this policy in the last 30 days`
                : 'No violations matched this policy name; it is actively monitored'}>
                <Badge appearance="tint" size="small" style={{ marginLeft: 6 }}
                  color={tip.count > 0 ? 'danger' : 'subtle'}>
                  {tip.count > 0 ? `${tip.count} tip${tip.count === 1 ? '' : 's'}` : 'monitored'}
                </Badge>
              </Tooltip>
            )}
            {/* Access rows that were revoked by DLP restrict-access. */}
            {p.dlpRestricted && (
              <Badge appearance="tint" size="small" color="warning" style={{ marginLeft: 6 }}
                title={p.dlpRestrictedAt ? `Restricted ${p.dlpRestrictedAt.slice(0, 16)}` : 'Access revoked by DLP'}>
                restricted
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      key: 'enabled', label: 'Enabled', sortable: true, filterable: false, width: 100, getValue: (p) => (p.enabled ? 1 : 0),
      render: (p) => <span onClick={(e) => e.stopPropagation()}><Switch checked={p.enabled} onChange={() => toggle(p)} /></span>,
    },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 110,
      render: (p) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => remove(p.id)}>Delete</Button>
        </span>
      ),
    },
  ];

  return (
    <GovernanceShell sectionTitle="Policies">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM }}>
        DLP, dynamic data masking, row-level security, retention, and access policies. Stored per tenant
        in Cosmos and visible to downstream enforcement code (Synapse SQL, Lakehouse query gate, etc.).
      </Body1>

      <Toolbar actions={
        <>
          <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          <Button appearance="primary" icon={<Add24Regular />} onClick={() => setOpen(true)}>New policy</Button>
        </>
      } />

      {cosmosGate && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            <MessageBarTitle>Cosmos DB not configured</MessageBarTitle>
            {cosmosGate} Set <code>LOOM_COSMOS_ENDPOINT</code> on the Console Container App and grant
            the Console UAMI the <code>Cosmos DB Built-in Data Contributor</code> role at account scope.
          </MessageBarBody>
        </MessageBar>
      )}

      {(error || actionErr) && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error || actionErr}</MessageBarBody>
        </MessageBar>
      )}

      {/* ── DLP (F22): violations · last-scan · trigger-scan · restrict-access ── */}
      <Section title="Data loss prevention" actions={
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {dlpMeta?.boundary ? `${dlpMeta.boundary} · ` : ''}
            Last checked: {dlpMeta?.lastScannedAt ? dlpMeta.lastScannedAt.slice(0, 16).replace('T', ' ') : '—'}
            {dlpMeta?.scanTriggeredAt ? ` · Scan requested: ${dlpMeta.scanTriggeredAt.slice(0, 16).replace('T', ' ')}` : ''}
          </Caption1>
          <Button size="small" icon={<ArrowSync24Regular />} onClick={loadDlp} disabled={vLoading}>Refresh</Button>
          <Button size="small" onClick={triggerScan} disabled={scanning}>{scanning ? 'Requesting…' : 'Trigger scan'}</Button>
          <Button size="small" appearance="primary" onClick={() => { setRstOpen(true); setRstMsg(null); }}>Restrict access</Button>
        </div>
      }>
        {/* Honest-gate MessageBar for Gov/DoD — policy authoring not on Graph there. */}
        {dlpMeta && !dlpMeta.dlpPolicyApiAvailable && (
          <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalS }}>
            <MessageBarBody>
              <MessageBarTitle>Partial DLP in {dlpMeta.boundary}</MessageBarTitle>
              Microsoft Graph&apos;s <code>/beta/security/dataLossPreventionPolicies</code> policy
              segment is not available in the US Government / DoD Graph roots
              (<code>graph.microsoft.us</code> / <code>dod-graph.microsoft.us</code>) as of 2026, so
              the per-policy list/rules read is unavailable here. DLP <strong>violations</strong>{' '}
              (<code>/v1.0/security/alerts_v2</code>) and <strong>restrict-access</strong> enforcement
              below remain fully operational. Author DLP policies at{' '}
              <a href="https://compliance.microsoft.us/datalossprevention" target="_blank" rel="noreferrer">compliance.microsoft.us</a>.
            </MessageBarBody>
          </MessageBar>
        )}

        {scanMsg && (
          <MessageBar intent={scanMsg.intent} style={{ marginBottom: tokens.spacingVerticalS }}>
            <MessageBarBody>
              <MessageBarTitle>{scanMsg.title}</MessageBarTitle>
              {scanMsg.body}
              {scanMsg.portalLink && (
                <Caption1 block style={{ marginTop: 4 }}>
                  Run it now: <a href={scanMsg.portalLink} target="_blank" rel="noreferrer">Purview content scan jobs → Scan now</a>{' '}
                  (or <code>Start-Scan</code> in the PurviewInformationProtection PowerShell module).
                </Caption1>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        {vGate && (
          <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalS }}>
            <MessageBarBody>
              <MessageBarTitle>DLP not wired in this deployment</MessageBarTitle>
              {vGate} Set <code>LOOM_DLP_ENABLED=true</code> on the Console Container App and grant the
              <code> SecurityAlert.Read.All</code> + <code>SecurityIncident.Read.All</code> Graph AppRoles
              (post-deploy bootstrap <code>grant-graph-approles.sh</code>), then have a Tenant Admin grant
              admin consent.
            </MessageBarBody>
          </MessageBar>
        )}
        {vErr && !vGate && (
          <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalS }}>
            <MessageBarBody><MessageBarTitle>Could not load violations</MessageBarTitle>{vErr}</MessageBarBody>
          </MessageBar>
        )}

        {vLoading && <Spinner size="tiny" label="Loading DLP violations…" />}
        {!vLoading && !vGate && !vErr && violations.length === 0 && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No DLP violations detected in the last 30 days.</Caption1>
        )}
        {!vLoading && violations.length > 0 && (
          <LoomDataTable<DlpViolation>
            ariaLabel="DLP violations"
            getRowId={(v) => v.alertId}
            rows={violations.slice(0, 50)}
            columns={[
              { key: 'detectedAt', label: 'Detected', sortable: true, width: 150, getValue: (v) => v.detectedAt || '', render: (v) => <Caption1>{v.detectedAt?.slice(0, 16).replace('T', ' ') || '—'}</Caption1> },
              { key: 'policyName', label: 'Policy', sortable: true, filterable: true, getValue: (v) => v.policyName || '', render: (v) => <><strong>{v.policyName || '—'}</strong>{v.ruleName ? <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>{v.ruleName}</Caption1> : null}</> },
              { key: 'itemPath', label: 'Item', sortable: true, filterable: true, getValue: (v) => v.itemPath || '', render: (v) => <><Caption1 title={v.itemPath}>{(v.itemPath || '—').slice(0, 44)}</Caption1>{v.itemType ? <Badge appearance="tint" size="small" style={{ marginLeft: 4 }}>{v.itemType}</Badge> : null}</> },
              { key: 'user', label: 'User', sortable: true, filterable: true, getValue: (v) => v.user || '', render: (v) => <Caption1>{v.user || '—'}</Caption1> },
              { key: 'severity', label: 'Severity', sortable: true, filterable: true, width: 110, getValue: (v) => v.severity || '', render: (v) => <Badge appearance="tint" color={v.severity === 'high' ? 'danger' : v.severity === 'medium' ? 'warning' : 'subtle'} size="small">{v.severity || '—'}</Badge> },
              { key: 'action', label: 'Action', sortable: true, filterable: true, getValue: (v) => v.action || v.status || '', render: (v) => <Caption1>{v.action || v.status || '—'}</Caption1> },
            ] as LoomColumn<DlpViolation>[]}
          />
        )}

        {(dlpMeta?.restrictions?.length ?? 0) > 0 && (
          <>
            <Divider style={{ marginTop: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalS }} />
            <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 4 }}>Recent restrict-access actions</Caption1>
            <div className={s.chips}>
              {dlpMeta!.restrictions!.slice(0, 8).map((r) => (
                <Badge key={r.id} appearance="tint" color={(r.armConfirmed || r.aclConfirmed) ? 'success' : 'warning'}
                  title={`${r.at.slice(0, 16).replace('T', ' ')} · ${r.revokedRoleNames.join(', ') || 'no roles'}${r.armConfirmed ? ' · ARM-confirmed' : r.aclConfirmed ? ' · ACL-confirmed' : ''}`}>
                  {(r.principalName || r.principalId).slice(0, 28)} ⊘ {
                    r.scopeType === 'adls-container' ? r.scopeRef
                      : r.scopeType === 'adls-path' ? `${r.scopeRef}/${r.subPath || ''}`
                      : r.scopeType === 'warehouse-schema' ? `schema ${r.schema || ''}`
                      : r.scopeType
                  }
                </Badge>
              ))}
            </div>
          </>
        )}
      </Section>

      {loading && !error && <Spinner label="Loading policies…" />}

      {!loading && !error && !cosmosGate && (policies?.length ?? 0) === 0 && (
        <div className={s.empty}>
          No policies defined yet. Click <strong>New policy</strong> to add your first DLP, masking, RLS, retention, or access rule.
        </div>
      )}

      {!error && (
        <LoomDataTable<Policy>
          columns={policyColumns}
          rows={policies || []}
          getRowId={(p) => p.id}
          loading={loading}
          empty="No policies yet. Create one with “New policy”."
        />
      )}

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New policy</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Field label="Name"><Input value={draftName} onChange={(_, d) => setDraftName(d.value)} /></Field>
                <Field label="Kind">
                  <Dropdown value={draftKind} selectedOptions={[draftKind]}
                            onOptionSelect={(_, d) => setDraftKind(d.optionValue as any)}>
                    {KINDS.map((k) => <Option key={k} value={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
                {/* Scope — selectable dropdowns (type + target) */}
                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="Applies to" style={{ flex: 1 }}>
                    <Dropdown value={scopeType} selectedOptions={[scopeType]}
                      onOptionSelect={(_, d) => { setScopeType(d.optionValue as any); setScopeTarget(''); }}>
                      <Option value="tenant">Whole tenant</Option>
                      <Option value="domain">A domain</Option>
                      <Option value="workspace">A workspace</Option>
                    </Dropdown>
                  </Field>
                  {scopeType !== 'tenant' && (
                    <Field label={scopeType === 'domain' ? 'Domain' : 'Workspace'} style={{ flex: 1 }}>
                      <Dropdown value={scopeTarget} selectedOptions={[scopeTarget]} placeholder="Select…"
                        onOptionSelect={(_, d) => setScopeTarget(d.optionValue || '')}>
                        {(scopeType === 'domain' ? domains : workspaces).map((t) => <Option key={t.id} value={t.id}>{t.name}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                </div>

                {/* Rule wizard — fields depend on the policy kind */}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Configure the {draftKind} rule</Caption1>
                {draftKind === 'DLP' && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Field label="Detect" style={{ flex: 1 }}>
                      <Dropdown value={w.dlpDetect} selectedOptions={[w.dlpDetect]} onOptionSelect={(_, d) => setWf('dlpDetect', d.optionValue || '')}>
                        {['Email', 'SSN', 'Credit card', 'Phone', 'IP address', 'Custom classification'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Action" style={{ flex: 1 }}>
                      <Dropdown value={w.dlpAction} selectedOptions={[w.dlpAction]} onOptionSelect={(_, d) => setWf('dlpAction', d.optionValue || '')}>
                        {['Audit', 'Block', 'Notify', 'Quarantine'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                )}
                {draftKind === 'Masking' && (
                  <div style={{ display: 'flex', gap: 12 }}>
                    <Field label="Column" style={{ flex: 1 }}><Input value={w.maskColumn} placeholder="e.g. email" onChange={(_, d) => setWf('maskColumn', d.value)} /></Field>
                    <Field label="Masking function" style={{ flex: 1 }}>
                      <Dropdown value={w.maskFn} selectedOptions={[w.maskFn]} onOptionSelect={(_, d) => setWf('maskFn', d.optionValue || '')}>
                        {['Full', 'Partial', 'Email', 'Hash', 'Random'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                )}
                {draftKind === 'RLS' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Field label="Column" style={{ flex: 1 }}><Input value={w.rlsColumn} placeholder="e.g. region" onChange={(_, d) => setWf('rlsColumn', d.value)} /></Field>
                    <Field label="Operator" style={{ width: 100 }}>
                      <Dropdown value={w.rlsOp} selectedOptions={[w.rlsOp]} onOptionSelect={(_, d) => setWf('rlsOp', d.optionValue || '=')}>
                        {['=', '!=', 'IN', 'LIKE'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Value" style={{ flex: 1 }}><Input value={w.rlsValue} placeholder="@currentUser.region" onChange={(_, d) => setWf('rlsValue', d.value)} /></Field>
                  </div>
                )}
                {draftKind === 'Retention' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Field label="Keep for" style={{ width: 120 }}><Input type="number" value={w.retPeriod} onChange={(_, d) => setWf('retPeriod', d.value)} /></Field>
                    <Field label="Unit" style={{ width: 120 }}>
                      <Dropdown value={w.retUnit} selectedOptions={[w.retUnit]} onOptionSelect={(_, d) => setWf('retUnit', d.optionValue || 'Days')}>
                        {['Days', 'Months', 'Years'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Then" style={{ flex: 1 }}>
                      <Dropdown value={w.retAction} selectedOptions={[w.retAction]} onOptionSelect={(_, d) => setWf('retAction', d.optionValue || 'Delete')}>
                        {['Delete', 'Archive', 'Review'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                )}
                {draftKind === 'Access' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Field label="Principal — search Entra users / groups">
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Dropdown value={accKind === 'user' ? 'User' : 'Group'} selectedOptions={[accKind]} style={{ minWidth: 100 }}
                          onOptionSelect={(_, d) => { setAccKind((d.optionValue as 'user' | 'group') || 'user'); setAccResults([]); }}>
                          <Option value="user">User</Option>
                          <Option value="group">Group</Option>
                        </Dropdown>
                        <Input value={accQuery} placeholder="name or UPN…" style={{ flex: 1 }}
                          onChange={(_, d) => setAccQuery(d.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') searchPrincipals(); }} />
                        <Button onClick={searchPrincipals} disabled={accSearching || accQuery.trim().length < 2}>
                          {accSearching ? 'Searching…' : 'Search'}
                        </Button>
                      </div>
                    </Field>
                    {accResults.length > 0 && !accPicked && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
                        {accResults.map((r) => (
                          <Button key={r.id} appearance="subtle" style={{ justifyContent: 'flex-start' }}
                            onClick={() => { setAccPicked({ id: r.id, name: r.displayName, type: r.type === 'group' ? 'Group' : 'User', upn: r.upn }); setAccResults([]); }}>
                            {r.displayName}{r.upn ? ` · ${r.upn}` : ''}
                          </Button>
                        ))}
                      </div>
                    )}
                    {accPicked && (
                      <Caption1>
                        Principal: <strong>{accPicked.name}</strong> ({accPicked.type}){' '}
                        <Button size="small" appearance="subtle" onClick={() => setAccPicked(null)}>change</Button>
                      </Caption1>
                    )}
                    <div style={{ display: 'flex', gap: 12 }}>
                      <Field label="Scope (data plane)" style={{ flex: 1 }}
                        hint="Where the grant is enforced — each is a real Azure-native grant.">
                        <Dropdown
                          value={accScope === 'adls-container' ? 'ADLS container' : accScope === 'warehouse' ? 'Warehouse (Synapse SQL)' : 'KQL database (ADX)'}
                          selectedOptions={[accScope]}
                          onOptionSelect={(_, d) => setAccScope((d.optionValue as typeof accScope) || 'adls-container')}>
                          <Option value="adls-container">ADLS container</Option>
                          <Option value="warehouse">Warehouse (Synapse SQL)</Option>
                          <Option value="kql-database">KQL database (ADX)</Option>
                        </Dropdown>
                      </Field>
                      <Field label="Permission" style={{ flex: 1 }}>
                        <Dropdown value={w.accPermission} selectedOptions={[w.accPermission]} onOptionSelect={(_, d) => setWf('accPermission', d.optionValue || 'Read')}>
                          {['Read', 'Write', 'Admin'].map((o) => <Option key={o} value={o}>{o}</Option>)}
                        </Dropdown>
                      </Field>
                    </div>
                    {accScope === 'adls-container' && (
                      <Field label="ADLS container"
                        hint="The data-lake container the grant applies to — Loom enforces it as real Storage RBAC.">
                        <Input value={accContainer} placeholder="bronze" onChange={(_, d) => setAccContainer(d.value)} />
                      </Field>
                    )}
                    {accScope === 'kql-database' && (
                      <Field label="KQL database"
                        hint="The ADX database — Loom enforces the grant as a real ADX database role.">
                        <Dropdown placeholder={kqlItems.length ? 'Select…' : 'No KQL databases found'} disabled={!kqlItems.length}
                          value={accKqlDb} selectedOptions={accKqlDb ? [accKqlDb] : []}
                          onOptionSelect={(_, d) => setAccKqlDb(d.optionValue || '')}>
                          {kqlItems.map((k) => <Option key={k.id} value={k.name}>{k.name}</Option>)}
                        </Dropdown>
                      </Field>
                    )}
                    {accScope === 'warehouse' && (
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        The grant applies to the configured Synapse dedicated SQL pool. Loom creates the Entra
                        database user (if needed) and adds it to db_datareader / db_datawriter / db_owner.
                      </Caption1>
                    )}
                  </div>
                )}
                <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{buildScope()} · {buildRule()}</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={create} disabled={busy || !draftName.trim()}>
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* ── Restrict-access dialog (real RBAC/data-plane revoke) ── */}
      <Dialog open={rstOpen} onOpenChange={(_, d) => setRstOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Restrict access (DLP)</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Revokes a principal&apos;s <strong>real</strong> data-plane access on a scope.
                  ADLS containers revoke a Storage RBAC role assignment (ARM read-back); ADLS paths
                  remove the principal from the directory POSIX ACL (ACL read-back); warehouse schemas
                  apply <code>DENY SELECT ON SCHEMA</code> on the Synapse pool; warehouse/KQL replay the
                  inverse grant. Exempt principals are never touched.
                </Caption1>

                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="Scope (data plane)" style={{ flex: 1 }}>
                    <Dropdown
                      value={
                        rstScope === 'adls-container' ? 'ADLS container'
                          : rstScope === 'adls-path' ? 'ADLS path (directory/file)'
                          : rstScope === 'warehouse' ? 'Warehouse (Synapse SQL)'
                          : rstScope === 'warehouse-schema' ? 'Warehouse schema (Synapse SQL)'
                          : 'KQL database (ADX)'}
                      selectedOptions={[rstScope]}
                      onOptionSelect={(_, d) => {
                        const v = (d.optionValue as typeof rstScope) || 'adls-container';
                        setRstScope(v); setRstRef(''); setRstSubPath(''); setRstPathItems([]); setRstSchema('');
                        if (v === 'warehouse-schema') loadRstSchemas();
                      }}>
                      <Option value="adls-container">ADLS container</Option>
                      <Option value="adls-path">ADLS path (directory/file)</Option>
                      <Option value="warehouse">Warehouse (Synapse SQL)</Option>
                      <Option value="warehouse-schema">Warehouse schema (Synapse SQL)</Option>
                      <Option value="kql-database">KQL database (ADX)</Option>
                    </Dropdown>
                  </Field>
                  {rstScope === 'adls-container' && (
                    <Field label="ADLS container" style={{ flex: 1 }}>
                      <Dropdown placeholder={containers.length ? 'Select…' : 'No containers found'} disabled={!containers.length}
                        value={rstRef} selectedOptions={rstRef ? [rstRef] : []}
                        onOptionSelect={(_, d) => setRstRef(d.optionValue || '')}>
                        {containers.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {rstScope === 'adls-path' && (
                    <Field label="ADLS container" style={{ flex: 1 }}>
                      <Dropdown placeholder={containers.length ? 'Select…' : 'No containers found'} disabled={!containers.length}
                        value={rstRef} selectedOptions={rstRef ? [rstRef] : []}
                        onOptionSelect={(_, d) => { const c = d.optionValue || ''; setRstRef(c); setRstSubPath(''); loadRstPaths(c, ''); }}>
                        {containers.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {rstScope === 'kql-database' && (
                    <Field label="KQL database" style={{ flex: 1 }}>
                      <Dropdown placeholder={kqlItems.length ? 'Select…' : 'No KQL databases found'} disabled={!kqlItems.length}
                        value={rstRef} selectedOptions={rstRef ? [rstRef] : []}
                        onOptionSelect={(_, d) => setRstRef(d.optionValue || '')}>
                        {kqlItems.map((k) => <Option key={k.id} value={k.name}>{k.name}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {rstScope === 'warehouse-schema' && (
                    <Field label="SQL schema" style={{ flex: 1 }}>
                      <Dropdown placeholder={rstSchemas.length ? 'Select…' : (rstSchemaGate ? 'Warehouse not configured' : 'No schemas found')}
                        disabled={!rstSchemas.length}
                        value={rstSchema} selectedOptions={rstSchema ? [rstSchema] : []}
                        onOptionSelect={(_, d) => setRstSchema(d.optionValue || '')}>
                        {rstSchemas.map((sc) => <Option key={sc} value={sc}>{sc}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                </div>

                {/* ADLS path drill-down picker — click a directory to descend. */}
                {rstScope === 'adls-path' && rstRef && (
                  <Field label="Path under the container"
                    hint="ACLs restrict a principal granted via ACL. A principal holding container-level Storage RBAC is unaffected — restrict at the container scope to cover that.">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Caption1 style={{ fontFamily: 'Consolas, monospace', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{rstRef}/{rstSubPath || ''}</Caption1>
                        {rstSubPath && (
                          <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />}
                            onClick={() => { const parent = rstSubPath.split('/').slice(0, -1).join('/'); setRstSubPath(parent); loadRstPaths(rstRef, parent); }}>
                            Up
                          </Button>
                        )}
                        {rstPathLoading && <Spinner size="tiny" />}
                      </div>
                      <div className={s.pickList}>
                        {rstPathItems.length === 0 && !rstPathLoading && (
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No sub-paths here.</Caption1>
                        )}
                        {rstPathItems.map((p) => {
                          const leaf = p.name.split('/').pop() || p.name;
                          const selected = rstSubPath === p.name;
                          return (
                            <Button key={p.name} appearance={selected ? 'primary' : 'subtle'} style={{ justifyContent: 'flex-start' }}
                              icon={p.isDirectory ? <Folder20Regular /> : <Document20Regular />}
                              onClick={() => { setRstSubPath(p.name); if (p.isDirectory) loadRstPaths(rstRef, p.name); }}>
                              {leaf}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  </Field>
                )}
                {rstScope === 'warehouse-schema' && rstSchemaGate && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Warehouse not configured</MessageBarTitle>
                      {rstSchemaGate} Set <code>LOOM_SYNAPSE_WORKSPACE</code> and <code>LOOM_SYNAPSE_DEDICATED_POOL</code> on the Console Container App.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {rstScope === 'warehouse-schema' && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Applies <code>DENY SELECT ON SCHEMA</code> to the principal on the configured Synapse dedicated pool.
                    DENY does not terminate in-flight sessions — kill active requests to cut access immediately.
                  </Caption1>
                )}

                <Field label="Principal to restrict — search Entra users / groups">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Dropdown value={rstKind === 'user' ? 'User' : 'Group'} selectedOptions={[rstKind]} style={{ minWidth: 100 }}
                      onOptionSelect={(_, d) => { setRstKind((d.optionValue as 'user' | 'group') || 'user'); setRstResults([]); }}>
                      <Option value="user">User</Option>
                      <Option value="group">Group</Option>
                    </Dropdown>
                    <Input value={rstQuery} placeholder="name or UPN…" style={{ flex: 1 }}
                      onChange={(_, d) => setRstQuery(d.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') searchRst(); }} />
                    <Button onClick={searchRst} disabled={rstSearching || rstQuery.trim().length < 2}>
                      {rstSearching ? 'Searching…' : 'Search'}
                    </Button>
                  </div>
                </Field>
                {rstResults.length > 0 && (
                  <div className={s.pickList}>
                    {rstResults.map((r) => (
                      <div key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <Button appearance={rstPicked?.id === r.id ? 'primary' : 'subtle'} style={{ justifyContent: 'flex-start', flex: 1 }}
                          onClick={() => setRstPicked({ id: r.id, name: r.displayName, type: r.type === 'group' ? 'Group' : 'User', upn: r.upn })}>
                          {r.displayName}{r.upn ? ` · ${r.upn}` : ''}
                        </Button>
                        <Button size="small" appearance="subtle"
                          onClick={() => setRstExempt((p) => p.some((x) => x.id === r.id) ? p : [...p, { id: r.id, name: r.displayName }])}>
                          + exempt
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {rstPicked && (
                  <Caption1>Restricting: <strong>{rstPicked.name}</strong> ({rstPicked.type})</Caption1>
                )}
                {rstExempt.length > 0 && (
                  <div>
                    <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 4 }}>Exempt (never restricted):</Caption1>
                    <div className={s.chips}>
                      {rstExempt.map((x) => (
                        <Badge key={x.id} appearance="tint" color="informative"
                          style={{ cursor: 'pointer' }}
                          onClick={() => setRstExempt((p) => p.filter((y) => y.id !== x.id))}
                          title="Click to remove from exempt list">
                          {x.name} ✕
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {rstMsg && (
                  <MessageBar intent={rstMsg.intent}>
                    <MessageBarBody><MessageBarTitle>{rstMsg.title}</MessageBarTitle>{rstMsg.body}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRstOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={doRestrict} disabled={rstBusy || !rstPicked}>
                {rstBusy ? 'Revoking…' : 'Revoke access'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </GovernanceShell>
  );
}

'use client';

/**
 * Power BI governance panels — the parity surfaces that close the auditor's top
 * gaps (docs/fiab/parity/powerbi-workspace.md §A5, §B12-15, §H5):
 *
 *   - ManageAccessPanel    : the REAL Power BI workspace ACL (GroupUsers) —
 *                            Admin/Member/Contributor/Viewer add/update/remove.
 *   - EndorsementControl   : read live endorsement (Fabric Get Item) + set
 *                            Promote/Certify (Power BI Admin REST; honest gate).
 *   - GatewayDatasourcesPanel : gateway binding + data sources for a model
 *                            (Discover/Bind gateway, Get/Update datasources).
 *
 * Every control calls the real Power BI / Fabric REST through the BFF routes
 * (/api/powerbi/access, /api/powerbi/endorsement, /api/powerbi/datasources).
 * No mocks. A 401/403 from the SP-tenant gate is rendered as a Fluent
 * MessageBar intent="warning" with the exact remediation — the full UI still
 * renders (no-vaporware.md / ui-parity.md).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Input, Field, Select, Badge, Spinner, Caption1, Subtitle2,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, ArrowSync20Regular,
  Ribbon20Regular, Link20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' },
  inline: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  wrap: { overflowX: 'auto' },
});

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

// ============================================================
// Manage access — Power BI workspace GroupUsers
// ============================================================

const ROLES = ['Admin', 'Member', 'Contributor', 'Viewer'] as const;
const PRINCIPALS = ['User', 'Group', 'App'] as const;

interface GroupUser {
  identifier?: string;
  emailAddress?: string;
  displayName?: string;
  groupUserAccessRight?: string;
  principalType?: string;
}

export function ManageAccessPanel({ workspaceId }: { workspaceId: string }) {
  const s = useStyles();
  const [users, setUsers] = useState<GroupUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<{ missing: string; detail: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // add form
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<string>('Viewer');
  const [principalType, setPrincipalType] = useState<string>('User');

  const applyGate = useCallback((body: any): boolean => {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing, detail: body.error || '' }); return true; }
    return false;
  }, []);

  const load = useCallback(async () => {
    if (!workspaceId) { setUsers([]); return; }
    setLoading(true); setErr(null); setHint(null);
    try {
      const body = await fetch(`/api/powerbi/access?workspaceId=${encodeURIComponent(workspaceId)}`).then(readJson);
      if (applyGate(body)) { setLoading(false); return; }
      setGate(null);
      if (!body.ok) { setErr(body.error || 'failed to load access'); setHint(body.hint || null); setUsers([]); return; }
      setUsers(body.users || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [workspaceId, applyGate]);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(async () => {
    if (!workspaceId || !identifier.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const body = await fetch('/api/powerbi/access', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, identifier: identifier.trim(), role, principalType }),
      }).then(readJson);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setMsg({ ok: false, text: body.hint ? `${body.error} — ${body.hint}` : (body.error || 'add failed') }); return; }
      setMsg({ ok: true, text: `Granted ${role} to ${identifier.trim()}.` });
      setIdentifier('');
      setUsers(body.users || []);
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId, identifier, role, principalType, applyGate]);

  const updateRole = useCallback(async (u: GroupUser, newRole: string) => {
    const id = u.identifier || u.emailAddress;
    if (!workspaceId || !id) return;
    setBusy(true); setMsg(null);
    try {
      const body = await fetch('/api/powerbi/access', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, identifier: id, role: newRole, principalType: u.principalType || 'User' }),
      }).then(readJson);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setMsg({ ok: false, text: body.error || 'update failed' }); return; }
      setMsg({ ok: true, text: `Changed ${id} to ${newRole}.` });
      setUsers(body.users || []);
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId, applyGate]);

  const remove = useCallback(async (u: GroupUser) => {
    const id = u.identifier || u.emailAddress;
    if (!workspaceId || !id) return;
    setBusy(true); setMsg(null);
    try {
      const body = await fetch(`/api/powerbi/access?workspaceId=${encodeURIComponent(workspaceId)}&identifier=${encodeURIComponent(id)}`, { method: 'DELETE' }).then(readJson);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setMsg({ ok: false, text: body.error || 'remove failed' }); return; }
      setMsg({ ok: true, text: `Removed ${id}.` });
      setUsers(body.users || []);
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId, applyGate]);

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Power BI not configured</MessageBarTitle>
          {gate.detail || <>Set <code>{gate.missing}</code> so the Console can authenticate to Power BI.</>}
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.root}>
      <Subtitle2>Manage access (Power BI workspace)</Subtitle2>
      <Caption1 className={s.hint}>
        The real Power BI workspace ACL via <code>Groups - GroupUser</code> REST (Admin / Member / Contributor / Viewer).
        Distinct from Loom-native roles. Adding requires the Console identity to be a workspace <strong>Admin</strong>.
      </Caption1>

      <div className={s.row}>
        <Field label="User email / object id" style={{ minWidth: 280 }}>
          <Input value={identifier} onChange={(_, d) => setIdentifier(d.value)} placeholder="user@contoso.com or app object id" />
        </Field>
        <Field label="Principal" style={{ minWidth: 130 }}>
          <Select value={principalType} onChange={(_, d) => setPrincipalType(d.value)}>
            {PRINCIPALS.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="Role" style={{ minWidth: 150 }}>
          <Select value={role} onChange={(_, d) => setRole(d.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <Button appearance="primary" icon={<Add20Regular />} disabled={busy || !identifier.trim()} onClick={add}>Add</Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={loading} onClick={load} aria-label="Refresh access list" />
      </div>

      {msg && <MessageBar intent={msg.ok ? 'success' : 'error'}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      {err && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Power BI access not reachable</MessageBarTitle>
            {err}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {loading && <Spinner size="tiny" label="Loading workspace access…" />}

      <div className={s.wrap}>
        <Table aria-label="Workspace access" size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>Principal</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Role</TableHeaderCell>
            <TableHeaderCell>Actions</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {users.length === 0 && !loading && <TableRow><TableCell colSpan={4}>No members returned.</TableCell></TableRow>}
            {users.map((u, i) => {
              const id = u.identifier || u.emailAddress || `row-${i}`;
              return (
                <TableRow key={id}>
                  <TableCell>{u.displayName || u.emailAddress || u.identifier || '—'}</TableCell>
                  <TableCell>{u.principalType || 'User'}</TableCell>
                  <TableCell>
                    <Select
                      value={u.groupUserAccessRight || 'Viewer'}
                      disabled={busy}
                      onChange={(_, d) => updateRole(u, d.value)}
                      aria-label={`Role for ${id}`}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => remove(u)} aria-label={`Remove ${id}`} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ============================================================
// Endorsement control (Promote / Certify)
// ============================================================

export function EndorsementControl({
  workspaceId, itemId, itemType,
}: {
  workspaceId: string;
  itemId: string;
  itemType: 'datasets' | 'reports' | 'dataflows';
}) {
  const s = useStyles();
  const [status, setStatus] = useState<string>('None');
  const [certifiedBy, setCertifiedBy] = useState<string>('');
  const [certifierInput, setCertifierInput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId || !itemId) return;
    setLoading(true); setMsg(null);
    try {
      const body = await fetch(`/api/powerbi/endorsement?workspaceId=${encodeURIComponent(workspaceId)}&itemId=${encodeURIComponent(itemId)}`).then(readJson);
      if (body.ok) { setStatus(body.endorsement?.endorsementStatus || 'None'); setCertifiedBy(body.endorsement?.certifiedBy || ''); }
      else setMsg({ ok: false, text: body.error || 'failed to read endorsement', hint: body.hint });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [workspaceId, itemId]);

  useEffect(() => { load(); }, [load]);

  const apply = useCallback(async (next: string) => {
    if (!workspaceId || !itemId) return;
    setBusy(true); setMsg(null);
    try {
      const body = await fetch('/api/powerbi/endorsement', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, itemId, itemType, endorsement: next, certifiedBy: certifierInput.trim() || undefined }),
      }).then(readJson);
      if (!body.ok) { setMsg({ ok: false, text: body.error || 'set endorsement failed', hint: body.hint }); return; }
      setStatus(body.endorsement?.endorsementStatus || next);
      setCertifiedBy(body.endorsement?.certifiedBy || '');
      setMsg({ ok: true, text: `Endorsement set to ${next}.` });
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId, itemId, itemType, certifierInput]);

  const badgeColor = status === 'Certified' ? 'success' : status === 'Promoted' ? 'brand' : 'informative';

  return (
    <div className={s.root}>
      <Subtitle2>Endorsement</Subtitle2>
      <Caption1 className={s.hint}>
        Read via Fabric <code>Get Item</code>; set via Power BI <code>Admin</code> REST
        (<code>PUT /admin/groups/{'{'}ws{'}'}/{itemType}/{'{'}id{'}'}</code>). Promote needs write on the item;
        Certify needs a Fabric-admin-authorized certifier. Dashboards can't be endorsed.
      </Caption1>

      <div className={s.inline}>
        <Caption1>Current:</Caption1>
        {loading ? <Spinner size="tiny" /> : (
          <Badge appearance="filled" color={badgeColor as any} icon={status === 'Certified' ? <Ribbon20Regular /> : undefined}>
            {status}{status === 'Certified' && certifiedBy ? ` · by ${certifiedBy}` : ''}
          </Badge>
        )}
      </div>

      <Field label="Certified by (UPN — required to Certify)" style={{ maxWidth: 360 }}>
        <Input value={certifierInput} onChange={(_, d) => setCertifierInput(d.value)} placeholder={certifiedBy || 'reviewer@contoso.com'} />
      </Field>

      <div className={s.inline}>
        <Button appearance={status === 'None' ? 'primary' : 'outline'} disabled={busy} onClick={() => apply('None')}>None</Button>
        <Button appearance={status === 'Promoted' ? 'primary' : 'outline'} disabled={busy} onClick={() => apply('Promoted')}>Promote</Button>
        <Button appearance={status === 'Certified' ? 'primary' : 'outline'} disabled={busy || !certifierInput.trim()} onClick={() => apply('Certified')} title={!certifierInput.trim() ? 'enter the certifier UPN first' : undefined}>Certify</Button>
      </div>

      {msg && (
        <MessageBar intent={msg.ok ? 'success' : (msg.hint ? 'warning' : 'error')}>
          <MessageBarBody>
            {msg.hint ? <MessageBarTitle>Admin action required</MessageBarTitle> : null}
            {msg.text}{msg.hint ? <><br /><Caption1>{msg.hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

// ============================================================
// Gateway + data sources panel (semantic model)
// ============================================================

interface Datasource {
  datasourceType?: string;
  datasourceId?: string;
  gatewayId?: string;
  connectionDetails?: { server?: string; database?: string; url?: string; path?: string };
  name?: string;
}
interface Gateway { id: string; name?: string; type?: string; gatewayStatus?: string }

export function GatewayDatasourcesPanel({ workspaceId, datasetId }: { workspaceId: string; datasetId: string }) {
  const s = useStyles();
  const [datasources, setDatasources] = useState<Datasource[]>([]);
  const [bound, setBound] = useState<Datasource[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<{ missing: string; detail: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [gatewayId, setGatewayId] = useState('');

  const applyGate = useCallback((body: any): boolean => {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing, detail: body.error || '' }); return true; }
    return false;
  }, []);

  const load = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setLoading(true); setErr(null); setHint(null);
    try {
      const body = await fetch(`/api/powerbi/datasources?workspaceId=${encodeURIComponent(workspaceId)}&datasetId=${encodeURIComponent(datasetId)}`).then(readJson);
      if (applyGate(body)) { setLoading(false); return; }
      setGate(null);
      if (!body.ok) { setErr(body.error || 'failed to load data sources'); setHint(body.hint || null); return; }
      setDatasources(body.datasources || []);
      setBound(body.boundGatewayDatasources || []);
      setGateways(body.gateways || []);
      if (!gatewayId && body.gateways?.[0]?.id) setGatewayId(body.gateways[0].id);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [workspaceId, datasetId, applyGate, gatewayId]);

  useEffect(() => { load(); }, [workspaceId, datasetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const bind = useCallback(async () => {
    if (!workspaceId || !datasetId || !gatewayId) return;
    setBusy(true); setMsg(null);
    try {
      const body = await fetch('/api/powerbi/datasources', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, datasetId, action: 'bind', gatewayObjectId: gatewayId }),
      }).then(readJson);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setMsg({ ok: false, text: body.hint ? `${body.error} — ${body.hint}` : (body.error || 'bind failed') }); return; }
      setMsg({ ok: true, text: 'Model bound to gateway.' });
      setBound(body.boundGatewayDatasources || []);
    } catch (e: any) { setMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [workspaceId, datasetId, gatewayId, applyGate]);

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Power BI not configured</MessageBarTitle>
          {gate.detail || <>Set <code>{gate.missing}</code> so the Console can authenticate to Power BI.</>}
        </MessageBarBody>
      </MessageBar>
    );
  }

  const renderDs = (rows: Datasource[], label: string) => (
    <div className={s.wrap}>
      <Caption1 style={{ fontWeight: 600 }}>{label} ({rows.length})</Caption1>
      <Table aria-label={label} size="small">
        <TableHeader><TableRow>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Connection</TableHeaderCell>
          <TableHeaderCell>Gateway</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {rows.length === 0 && <TableRow><TableCell colSpan={3}>None.</TableCell></TableRow>}
          {rows.map((d, i) => (
            <TableRow key={d.datasourceId || i}>
              <TableCell>{d.datasourceType || d.name || '—'}</TableCell>
              <TableCell>{d.connectionDetails?.server || d.connectionDetails?.url || d.connectionDetails?.path || '—'}{d.connectionDetails?.database ? ` / ${d.connectionDetails.database}` : ''}</TableCell>
              <TableCell>{d.gatewayId || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <div className={s.root}>
      <Subtitle2>Gateway &amp; data sources</Subtitle2>
      <Caption1 className={s.hint}>
        Real Power BI REST: <code>GetDatasources</code>, <code>GetBoundGatewayDatasources</code>,
        <code> DiscoverGateways</code>, <code>BindToGateway</code>. Setting encrypted credentials (sign-in)
        is a gateway-credential operation done in the Power BI service; this panel binds the model and
        repoints connections.
      </Caption1>

      <div className={s.inline}>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={loading} onClick={load}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
      </div>

      {err && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Data sources not reachable</MessageBarTitle>
            {err}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}

      {renderDs(datasources, 'Cloud data sources')}
      {renderDs(bound, 'Bound gateway data sources')}

      <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Bind to gateway</Subtitle2>
      <div className={s.row}>
        <Field label="Gateway (DiscoverGateways)" style={{ minWidth: 300 }}>
          <Select value={gatewayId} onChange={(_, d) => setGatewayId(d.value)}>
            {gateways.length === 0 && <option value="">(no bindable gateways discovered)</option>}
            {gateways.map((g) => <option key={g.id} value={g.id}>{g.name || g.id}{g.gatewayStatus ? ` · ${g.gatewayStatus}` : ''}</option>)}
          </Select>
        </Field>
        <Button appearance="primary" icon={<Link20Regular />} disabled={busy || !gatewayId} onClick={bind}>Bind to gateway</Button>
      </div>
      {msg && <MessageBar intent={msg.ok ? 'success' : 'error'}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}

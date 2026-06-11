'use client';

/**
 * MipPanel — Information Protection tab for /admin/security.
 *
 * Sub-tabs:
 *   - Sensitivity labels : list (Graph beta) + create / edit / delete labels
 *                          (New-Label / Set-Label / Remove-Label via the SCC
 *                          PowerShell sidecar).
 *   - Label policies     : list + create / edit / delete policies
 *                          (New-/Set-/Remove-LabelPolicy via the SCC sidecar).
 *   - Apply label        : guided wizard — pick a Loom item, pick a label,
 *                          apply it (PUT /api/items/[type]/[id]/sensitivity-label),
 *                          plus an optional MIP recommendation (evaluate).
 *
 * Reads (label definitions) are Graph-backed and work whenever LOOM_MIP_ENABLED
 * is set. Writes (CRUD) + policy reads go through the SCC sidecar; when it is
 * not wired the routes return 503 code 'mip_admin_not_configured' and we render
 * a NotConfiguredBar naming the exact env var / role / bootstrap step. All
 * config is via guided forms — never raw JSON.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TabList, Tab, type SelectTabData, type SelectTabEvent,
  Spinner, Button, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Caption1, Subtitle2,
  Textarea, Field, Input, Switch, Checkbox,
  Dropdown, Option, Radio, RadioGroup,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, Add24Regular, Edit20Regular, Delete20Regular, Tag24Regular,
} from '@fluentui/react-icons';
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
  rowActions: { display: 'flex', gap: 4 },
  labelChecklist: {
    display: 'flex', flexDirection: 'column', gap: 4,
    maxHeight: 200, overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8,
  },
  swatch: {
    display: 'inline-block', width: '12px', height: '12px', borderRadius: '2px',
    marginRight: '6px', verticalAlign: 'middle', backgroundColor: '#888',
  },
  scopeBlock: {
    display: 'flex', flexDirection: 'column', gap: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
    padding: 10, backgroundColor: tokens.colorNeutralBackground2,
  },
  scopeGrid: { display: 'flex', flexDirection: 'column', gap: 8 },
  scopeTags: { display: 'flex', flexWrap: 'wrap', gap: 4 },
});

const LABEL_COLORS = [
  { key: '', label: '(default)' },
  { key: '#107c10', label: 'Green' },
  { key: '#0078d4', label: 'Blue' },
  { key: '#ca5010', label: 'Orange' },
  { key: '#a4262c', label: 'Red' },
  { key: '#5c2e91', label: 'Purple' },
  { key: '#605e5c', label: 'Grey' },
];

interface ApiState<T> {
  loading: boolean;
  data: T | null;
  notConfigured?: NotConfiguredHint;
  error?: string;
  errorStatus?: number;
}

function emptyState<T>(): ApiState<T> { return { loading: false, data: null }; }

interface FetchResult<T> {
  ok: boolean;
  data: T | null;
  notConfigured?: NotConfiguredHint;
  error?: string;
  status?: number;
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<FetchResult<T>> {
  try {
    const r = await fetch(url, init);
    const j = await r.json();
    if (r.status === 503 && typeof j?.code === 'string' && j.code.endsWith('_not_configured')) {
      return { ok: false, data: null, notConfigured: j.hint, error: j.error, status: 503 };
    }
    if (!r.ok) return { ok: false, data: null, error: j?.error || `HTTP ${r.status}`, status: r.status };
    return { ok: true, data: j as T, status: r.status };
  } catch (e: any) { return { ok: false, data: null, error: e?.message || String(e) }; }
}

type SubTab = 'labels' | 'policies' | 'apply';

interface LabelRow {
  id: string; name: string; displayName?: string; description?: string;
  tooltip?: string; color?: string; sensitivity?: number;
  isActive?: boolean; isAppliable?: boolean; parentId?: string | null;
  applicableTo?: string; hasProtection?: boolean;
}
interface LabelsPayload { ok: boolean; labels?: LabelRow[]; }

interface PolicyRow {
  id: string; name?: string; displayName?: string; description?: string;
  isMandatory?: boolean; defaultLabelId?: string; scopes?: string[];
  exchangeLocation?: string[]; sharePointLocation?: string[];
  oneDriveLocation?: string[]; modernGroupLocation?: string[];
  labels?: string[]; enabled?: boolean;
}
interface PoliciesPayload { ok: boolean; policies?: PolicyRow[]; }

const ADMIN_PORTAL = 'https://compliance.microsoft.com/informationprotection';

export function MipPanel() {
  const s = useStyles();
  const [tab, setTab] = useState<SubTab>('labels');
  const [labels, setLabels] = useState<ApiState<LabelsPayload>>(emptyState());

  const loadLabels = useCallback(async () => {
    setLabels((p) => ({ ...p, loading: true }));
    const r = await fetchJson<LabelsPayload>('/api/admin/security/mip/labels');
    setLabels({ loading: false, data: r.data, notConfigured: r.notConfigured, error: r.error, errorStatus: r.status });
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

// ============================================================
// Labels
// ============================================================

type LabelDialogMode = { kind: 'create' } | { kind: 'edit'; label: LabelRow } | null;

function LabelsSection({ state, onRefresh }: { state: ApiState<LabelsPayload>; onRefresh: () => void }) {
  const s = useStyles();
  const [dialog, setDialog] = useState<LabelDialogMode>(null);
  const [confirmDelete, setConfirmDelete] = useState<LabelRow | null>(null);
  const [adminGate, setAdminGate] = useState<NotConfiguredHint | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);

  const doDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true); setOpError(null); setOpOk(null);
    const r = await fetchJson(`/api/admin/security/mip/labels/${encodeURIComponent(confirmDelete.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (r.notConfigured) { setAdminGate(r.notConfigured); setConfirmDelete(null); return; }
    if (!r.ok) { setOpError(r.error || 'Delete failed'); return; }
    setOpOk(`Deleted label "${confirmDelete.displayName || confirmDelete.name}".`);
    setConfirmDelete(null);
    onRefresh();
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>Tenant sensitivity labels</Subtitle2>
        <Button icon={<Add24Regular />} appearance="primary" onClick={() => { setOpError(null); setOpOk(null); setDialog({ kind: 'create' }); }}>
          New label
        </Button>
        <Button icon={<ArrowSync24Regular />} onClick={onRefresh} disabled={state.loading}>Refresh</Button>
      </div>

      {adminGate && (
        <div style={{ marginBottom: 8 }}>
          <NotConfiguredBar surface="Sensitivity-label management (create / edit / delete)" hint={adminGate}
            portalLink={ADMIN_PORTAL} portalLabel="Open Information Protection (Microsoft Purview)" />
        </div>
      )}
      {opOk && <MessageBar intent="success" style={{ marginBottom: 8 }}><MessageBarBody>{opOk}</MessageBarBody></MessageBar>}
      {opError && <MessageBar intent="error" style={{ marginBottom: 8 }}><MessageBarBody>{opError}</MessageBarBody></MessageBar>}

      {state.loading && <Spinner label="Loading labels from Microsoft Graph…" />}
      {state.notConfigured && (
        <NotConfiguredBar surface="Sensitivity labels" hint={state.notConfigured}
          portalLink={ADMIN_PORTAL} portalLabel="Open Information Protection (Microsoft Purview)" />
      )}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load labels (HTTP {state.errorStatus})</MessageBarTitle>
            {state.error}
            {state.errorStatus === 403 && (
              <Caption1 block style={{ marginTop: 6 }}>
                403 from Microsoft Graph typically means the <code>InformationProtectionPolicy.Read.All</code> AppRole has not been admin-consented for the Console UAMI. Run the post-deploy bootstrap job <code>Grant MIP+DLP Graph AppRoles</code> then have a Tenant Administrator click <em>Grant admin consent</em>.
              </Caption1>
            )}
          </MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.labels || []).length === 0 && !state.notConfigured && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>
          No sensitivity labels found in this tenant. Use <strong>New label</strong> to create one.
        </Caption1>
      )}
      {state.data?.ok && (state.data.labels || []).length > 0 && (
        <Table size="small" aria-label="Sensitivity labels">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Label</TableHeaderCell>
              <TableHeaderCell>Sensitivity</TableHeaderCell>
              <TableHeaderCell>Parent</TableHeaderCell>
              <TableHeaderCell>Protection</TableHeaderCell>
              <TableHeaderCell>Active</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.labels!.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  <span className={s.swatch} style={{ backgroundColor: l.color || '#888' }} />
                  <strong>{l.displayName || l.name}</strong>
                  {(l.tooltip || l.description) && (
                    <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>{(l.tooltip || l.description || '').slice(0, 90)}</Caption1>
                  )}
                </TableCell>
                <TableCell>{l.sensitivity ?? '—'}</TableCell>
                <TableCell><Caption1>{l.parentId || '—'}</Caption1></TableCell>
                <TableCell>{l.hasProtection ? <Badge color="brand">encrypted</Badge> : <Badge color="subtle">none</Badge>}</TableCell>
                <TableCell>{l.isActive ? <Badge color="success">yes</Badge> : <Badge color="subtle">no</Badge>}</TableCell>
                <TableCell>
                  <div className={s.rowActions}>
                    <Button size="small" icon={<Edit20Regular />} appearance="subtle"
                      aria-label="Edit label"
                      onClick={() => { setOpError(null); setOpOk(null); setDialog({ kind: 'edit', label: l }); }} />
                    <Button size="small" icon={<Delete20Regular />} appearance="subtle"
                      aria-label="Delete label"
                      onClick={() => { setOpError(null); setOpOk(null); setConfirmDelete(l); }} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dialog && (
        <LabelDialog
          mode={dialog}
          labels={state.data?.labels || []}
          onClose={() => setDialog(null)}
          onGate={(h) => { setAdminGate(h); setDialog(null); }}
          onSaved={(msg) => { setDialog(null); setOpOk(msg); onRefresh(); }}
        />
      )}

      <Dialog open={!!confirmDelete} onOpenChange={(_e, d) => { if (!d.open) setConfirmDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete sensitivity label</DialogTitle>
            <DialogContent>
              <Caption1>
                Permanently remove <strong>{confirmDelete?.displayName || confirmDelete?.name}</strong> via
                <code> Remove-Label</code>. Items already labeled keep their stamp until re-labeled. This cannot be undone.
              </Caption1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={doDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete label'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function LabelDialog({ mode, labels, onClose, onGate, onSaved }: {
  mode: NonNullable<LabelDialogMode>;
  labels: LabelRow[];
  onClose: () => void;
  onGate: (h: NotConfiguredHint) => void;
  onSaved: (msg: string) => void;
}) {
  const s = useStyles();
  const editing = mode.kind === 'edit' ? mode.label : null;
  const [displayName, setDisplayName] = useState(editing?.displayName || editing?.name || '');
  const [tooltip, setTooltip] = useState(editing?.tooltip || '');
  const [comment, setComment] = useState(editing?.description || '');
  const [color, setColor] = useState(editing?.color || '');
  const [parentId, setParentId] = useState(editing?.parentId || '');
  const [encryption, setEncryption] = useState(!!editing?.hasProtection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentOptions = useMemo(
    () => labels.filter((l) => !editing || l.id !== editing.id),
    [labels, editing],
  );

  const save = async () => {
    setBusy(true); setError(null);
    const payload = {
      displayName: displayName.trim(),
      tooltip: tooltip.trim() || undefined,
      comment: comment.trim() || undefined,
      color: color || undefined,
      parentId: mode.kind === 'create' ? (parentId || undefined) : undefined,
      encryptionEnabled: encryption,
    };
    const url = mode.kind === 'create'
      ? '/api/admin/security/mip/labels'
      : `/api/admin/security/mip/labels/${encodeURIComponent(editing!.id)}`;
    const r = await fetchJson(url, {
      method: mode.kind === 'create' ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (r.notConfigured) { onGate(r.notConfigured); return; }
    if (!r.ok) { setError(r.error || 'Save failed'); return; }
    onSaved(mode.kind === 'create' ? `Created label "${payload.displayName}".` : `Updated label "${payload.displayName}".`);
  };

  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{mode.kind === 'create' ? 'New sensitivity label' : 'Edit sensitivity label'}</DialogTitle>
          <DialogContent>
            <div className={s.fieldStack}>
              <Field label="Display name" required>
                <Input value={displayName} onChange={(_: unknown, d: any) => setDisplayName(d.value)} placeholder="Confidential" />
              </Field>
              <Field label="Tooltip" hint="Shown to users when they choose this label in apps.">
                <Input value={tooltip} onChange={(_: unknown, d: any) => setTooltip(d.value)} placeholder="Sensitive business data" />
              </Field>
              <Field label="Admin description (comment)">
                <Textarea rows={2} value={comment} onChange={(_: unknown, d: any) => setComment(d.value)} />
              </Field>
              <Field label="Color">
                <Dropdown
                  value={LABEL_COLORS.find((c) => c.key === color)?.label || '(default)'}
                  selectedOptions={[color]}
                  onOptionSelect={(_: unknown, d: any) => setColor(d.optionValue ?? '')}
                >
                  {LABEL_COLORS.map((c) => <Option key={c.key || 'default'} value={c.key}>{c.label}</Option>)}
                </Dropdown>
              </Field>
              {mode.kind === 'create' && (
                <Field label="Parent label" hint="Optional — makes this a sub-label.">
                  <Dropdown
                    value={parentId ? (parentOptions.find((p) => p.id === parentId)?.displayName || parentId) : '(none — top-level)'}
                    selectedOptions={parentId ? [parentId] : ['']}
                    onOptionSelect={(_: unknown, d: any) => setParentId(d.optionValue ?? '')}
                  >
                    <Option value="">(none — top-level)</Option>
                    {parentOptions.map((p) => <Option key={p.id} value={p.id}>{p.displayName || p.name}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Switch
                label="Apply encryption / content marking (protection)"
                checked={encryption}
                onChange={(_: unknown, d: any) => setEncryption(!!d.checked)}
              />
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" onClick={save} disabled={busy || !displayName.trim()}>
              {busy ? 'Saving…' : (mode.kind === 'create' ? 'Create label' : 'Save changes')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Policies
// ============================================================

type PolicyDialogMode = { kind: 'create' } | { kind: 'edit'; policy: PolicyRow } | null;

/** Workloads a label policy can be published to (1:1 with the New-/Set-LabelPolicy *Location params). */
const POLICY_WORKLOADS = [
  { key: 'exchangeLocation', label: 'Exchange mailboxes', short: 'Exchange', placeholder: 'user@contoso.com — one per line' },
  { key: 'sharePointLocation', label: 'SharePoint sites', short: 'SharePoint', placeholder: 'https://contoso.sharepoint.com/sites/Team — one per line' },
  { key: 'oneDriveLocation', label: 'OneDrive accounts', short: 'OneDrive', placeholder: 'https://contoso-my.sharepoint.com/personal/user_contoso_com — one per line' },
  { key: 'modernGroupLocation', label: 'Microsoft 365 Groups', short: 'M365 Groups', placeholder: 'group@contoso.com — one per line' },
] as const;
type WorkloadKey = (typeof POLICY_WORKLOADS)[number]['key'];

function parseIdentities(text: string): string[] {
  return text.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
}
function isAllScope(arr?: string[]): boolean {
  return !!arr && arr.length > 0 && arr.every((x) => x.trim().toLowerCase() === 'all');
}
function hasSpecific(arr?: string[]): boolean {
  return !!arr && arr.some((x) => x.trim() && x.trim().toLowerCase() !== 'all');
}

/** Compact, human-readable summary of a policy's publish scope for the table. */
function policyScopeChips(p: PolicyRow): string[] {
  const locs: [string, string[] | undefined][] = [
    ['Exchange', p.exchangeLocation], ['SharePoint', p.sharePointLocation],
    ['OneDrive', p.oneDriveLocation], ['M365 Groups', p.modernGroupLocation],
  ];
  if (locs.every(([, a]) => isAllScope(a)) && locs.some(([, a]) => isAllScope(a))) return ['All locations'];
  const chips: string[] = [];
  for (const [name, arr] of locs) {
    if (isAllScope(arr)) chips.push(`${name}: All`);
    else if (hasSpecific(arr)) chips.push(`${name}: ${arr!.filter((x) => x.trim().toLowerCase() !== 'all').length}`);
  }
  return chips;
}

function PoliciesSection({ labelsState }: { labelsState: ApiState<LabelsPayload> }) {
  const s = useStyles();
  const [state, setState] = useState<ApiState<PoliciesPayload>>(emptyState());
  const [dialog, setDialog] = useState<PolicyDialogMode>(null);
  const [confirmDelete, setConfirmDelete] = useState<PolicyRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [opOk, setOpOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ loading: true, data: null });
    const r = await fetchJson<PoliciesPayload>('/api/admin/security/mip/policies');
    setState({ loading: false, data: r.data, notConfigured: r.notConfigured, error: r.error, errorStatus: r.status });
  }, []);
  useEffect(() => { load(); }, [load]);

  const lookupLabel = (id?: string): string | undefined => {
    if (!id) return undefined;
    return labelsState.data?.labels?.find((l) => l.id === id)?.displayName;
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true); setOpError(null); setOpOk(null);
    const r = await fetchJson(`/api/admin/security/mip/policies/${encodeURIComponent(confirmDelete.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!r.ok && !r.notConfigured) { setOpError(r.error || 'Delete failed'); return; }
    setOpOk(`Deleted policy "${confirmDelete.displayName || confirmDelete.name}".`);
    setConfirmDelete(null);
    load();
  };

  return (
    <div className={s.section}>
      <div className={s.toolbar}>
        <Subtitle2 style={{ marginRight: 'auto' }}>Label policies</Subtitle2>
        <Button icon={<Add24Regular />} appearance="primary"
          disabled={!!state.notConfigured}
          onClick={() => { setOpError(null); setOpOk(null); setDialog({ kind: 'create' }); }}>New policy</Button>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={state.loading}>Refresh</Button>
      </div>

      {opOk && <MessageBar intent="success" style={{ marginBottom: 8 }}><MessageBarBody>{opOk}</MessageBarBody></MessageBar>}
      {opError && <MessageBar intent="error" style={{ marginBottom: 8 }}><MessageBarBody>{opError}</MessageBarBody></MessageBar>}

      {state.loading && <Spinner label="Loading label policies…" />}
      {state.notConfigured && (
        <NotConfiguredBar surface="Label policies" hint={state.notConfigured}
          portalLink={ADMIN_PORTAL} portalLabel="Open Information Protection (Microsoft Purview)" />
      )}
      {state.error && !state.notConfigured && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Failed (HTTP {state.errorStatus})</MessageBarTitle>{state.error}</MessageBarBody>
        </MessageBar>
      )}
      {state.data?.ok && (state.data.policies || []).length === 0 && !state.notConfigured && (
        <Caption1 block style={{ color: tokens.colorNeutralForeground3 }}>No label policies configured. Use <strong>New policy</strong> to publish labels to users.</Caption1>
      )}
      {state.data?.ok && (state.data.policies || []).length > 0 && (
        <Table size="small" aria-label="Label policies">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Published labels</TableHeaderCell>
              <TableHeaderCell>Scope</TableHeaderCell>
              <TableHeaderCell>Mandatory</TableHeaderCell>
              <TableHeaderCell>Default label</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.policies!.map((p) => {
              const chips = policyScopeChips(p);
              return (
              <TableRow key={p.id}>
                <TableCell><strong>{p.displayName || p.name}</strong></TableCell>
                <TableCell>{(p.labels || []).map((id) => <Badge key={id} appearance="outline" style={{ marginRight: 4 }}>{lookupLabel(id) || id}</Badge>)}</TableCell>
                <TableCell>
                  {chips.length === 0
                    ? <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>Not published</Caption1>
                    : <div className={s.scopeTags}>{chips.map((c) => <Badge key={c} appearance="tint" color={c === 'All locations' ? 'brand' : 'informative'}>{c}</Badge>)}</div>}
                </TableCell>
                <TableCell>{p.isMandatory ? <Badge color="warning">yes</Badge> : <Badge color="subtle">no</Badge>}</TableCell>
                <TableCell>{lookupLabel(p.defaultLabelId) || p.defaultLabelId || '—'}</TableCell>
                <TableCell>
                  <div className={s.rowActions}>
                    <Button size="small" icon={<Edit20Regular />} appearance="subtle" aria-label="Edit policy"
                      onClick={() => { setOpError(null); setOpOk(null); setDialog({ kind: 'edit', policy: p }); }} />
                    <Button size="small" icon={<Delete20Regular />} appearance="subtle" aria-label="Delete policy"
                      onClick={() => { setOpError(null); setOpOk(null); setConfirmDelete(p); }} />
                  </div>
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {dialog && (
        <PolicyDialog
          mode={dialog}
          labels={labelsState.data?.labels || []}
          onClose={() => setDialog(null)}
          onSaved={(msg) => { setDialog(null); setOpOk(msg); load(); }}
          onError={(msg) => { setOpError(msg); }}
        />
      )}

      <Dialog open={!!confirmDelete} onOpenChange={(_e, d) => { if (!d.open) setConfirmDelete(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete label policy</DialogTitle>
            <DialogContent>
              <Caption1>Remove policy <strong>{confirmDelete?.displayName || confirmDelete?.name}</strong> via <code>Remove-LabelPolicy</code>. Labels stay defined; they just stop being published by this policy.</Caption1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDelete(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={doDelete} disabled={busy}>{busy ? 'Deleting…' : 'Delete policy'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}

function PolicyDialog({ mode, labels, onClose, onSaved, onError }: {
  mode: NonNullable<PolicyDialogMode>;
  labels: LabelRow[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const s = useStyles();
  const editing = mode.kind === 'edit' ? mode.policy : null;
  const [name, setName] = useState(editing?.displayName || editing?.name || '');
  const [comment, setComment] = useState(editing?.description || '');
  const [selected, setSelected] = useState<string[]>(editing?.labels || []);
  const [mandatory, setMandatory] = useState(!!editing?.isMandatory);
  const [defaultLabelId, setDefaultLabelId] = useState(editing?.defaultLabelId || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Publish scope (who the policy targets) -------------------------------
  const initialScopeText = (): Record<WorkloadKey, string> => ({
    exchangeLocation: (editing?.exchangeLocation || []).join('\n'),
    sharePointLocation: (editing?.sharePointLocation || []).join('\n'),
    oneDriveLocation: (editing?.oneDriveLocation || []).join('\n'),
    modernGroupLocation: (editing?.modernGroupLocation || []).join('\n'),
  });
  const allWorkloadsAll = editing
    ? POLICY_WORKLOADS.every((w) => isAllScope(editing[w.key as WorkloadKey] as string[] | undefined))
    : false;
  // New policies default to "All locations" so they publish to everyone immediately
  // (a policy with no scope is inert). Existing all-All policies keep that mode.
  const [scopeMode, setScopeMode] = useState<'all' | 'specific'>(
    mode.kind === 'create' ? 'all' : (allWorkloadsAll ? 'all' : 'specific'),
  );
  const [scopeText, setScopeText] = useState<Record<WorkloadKey, string>>(initialScopeText);

  const specificAny = useMemo(
    () => POLICY_WORKLOADS.some((w) => parseIdentities(scopeText[w.key as WorkloadKey]).length > 0),
    [scopeText],
  );
  const scopeValid = scopeMode === 'all' || mode.kind === 'edit' || specificAny;

  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id));

  const buildLocations = (): Record<WorkloadKey, string[]> => {
    if (scopeMode === 'all') {
      return {
        exchangeLocation: ['All'], sharePointLocation: ['All'],
        oneDriveLocation: ['All'], modernGroupLocation: ['All'],
      };
    }
    return {
      exchangeLocation: parseIdentities(scopeText.exchangeLocation),
      sharePointLocation: parseIdentities(scopeText.sharePointLocation),
      oneDriveLocation: parseIdentities(scopeText.oneDriveLocation),
      modernGroupLocation: parseIdentities(scopeText.modernGroupLocation),
    };
  };

  const save = async () => {
    setBusy(true); setError(null);
    const url = mode.kind === 'create'
      ? '/api/admin/security/mip/policies'
      : `/api/admin/security/mip/policies/${encodeURIComponent(editing!.id)}`;
    const locations = buildLocations();
    const payload: Record<string, unknown> = {
      comment: comment.trim() || undefined,
      labels: selected,
      mandatory,
      defaultLabelId: defaultLabelId || undefined,
      // On create we omit empty workloads; on edit we send all four so the
      // sidecar can clear a workload by diffing against the live policy.
      exchangeLocation: mode.kind === 'edit' || locations.exchangeLocation.length ? locations.exchangeLocation : undefined,
      sharePointLocation: mode.kind === 'edit' || locations.sharePointLocation.length ? locations.sharePointLocation : undefined,
      oneDriveLocation: mode.kind === 'edit' || locations.oneDriveLocation.length ? locations.oneDriveLocation : undefined,
      modernGroupLocation: mode.kind === 'edit' || locations.modernGroupLocation.length ? locations.modernGroupLocation : undefined,
    };
    if (mode.kind === 'create') payload.name = name.trim();
    const r = await fetchJson(url, {
      method: mode.kind === 'create' ? 'POST' : 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (r.notConfigured) { onError('Label-policy management requires the SCC sidecar (see the Label policies tab gate).'); onClose(); return; }
    if (!r.ok) { setError(r.error || 'Save failed'); return; }
    onSaved(mode.kind === 'create' ? `Created policy "${name}".` : `Updated policy "${editing!.displayName || editing!.name}".`);
  };

  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{mode.kind === 'create' ? 'New label policy' : 'Edit label policy'}</DialogTitle>
          <DialogContent>
            <div className={s.fieldStack}>
              <Field label="Policy name" required>
                <Input value={name} onChange={(_: unknown, d: any) => setName(d.value)} disabled={mode.kind === 'edit'} placeholder="All staff – default labeling" />
              </Field>
              <Field label="Comment">
                <Input value={comment} onChange={(_: unknown, d: any) => setComment(d.value)} />
              </Field>
              <Field label="Published labels" required hint="Labels this policy makes available to users.">
                <div className={s.labelChecklist}>
                  {labels.length === 0 && <Caption1>No labels defined yet. Create labels first.</Caption1>}
                  {labels.map((l) => (
                    <Checkbox key={l.id} label={l.displayName || l.name}
                      checked={selected.includes(l.id)}
                      onChange={(_: unknown, d: any) => toggle(l.id, !!d.checked)} />
                  ))}
                </div>
              </Field>
              <Field label="Default label" hint="Applied automatically to new content.">
                <Dropdown
                  value={defaultLabelId ? (labels.find((l) => l.id === defaultLabelId)?.displayName || defaultLabelId) : '(none)'}
                  selectedOptions={defaultLabelId ? [defaultLabelId] : ['']}
                  onOptionSelect={(_: unknown, d: any) => setDefaultLabelId(d.optionValue ?? '')}
                >
                  <Option value="">(none)</Option>
                  {labels.filter((l) => selected.includes(l.id)).map((l) => <Option key={l.id} value={l.id}>{l.displayName || l.name}</Option>)}
                </Dropdown>
              </Field>
              <Switch label="Require users to apply a label (mandatory labeling)" checked={mandatory}
                onChange={(_: unknown, d: any) => setMandatory(!!d.checked)} />

              <Field
                label="Publish to (scope)"
                required
                hint="Who receives this policy. A policy with no scope publishes to no one.">
                <div className={s.scopeBlock}>
                  <RadioGroup
                    value={scopeMode}
                    onChange={(_: unknown, d: any) => setScopeMode(d.value as 'all' | 'specific')}
                  >
                    <Radio value="all" label="All locations (every user, group & site)" />
                    <Radio value="specific" label="Specific locations" />
                  </RadioGroup>
                  {scopeMode === 'specific' && (
                    <div className={s.scopeGrid}>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Enter identities for the workloads you want to target — one per line (or comma-separated). Type <code>All</code> on its own line to scope an entire workload. Leave a box empty to exclude that workload.
                      </Caption1>
                      {POLICY_WORKLOADS.map((w) => (
                        <Field key={w.key} label={w.label} size="small">
                          <Textarea
                            rows={2}
                            value={scopeText[w.key as WorkloadKey]}
                            placeholder={w.placeholder}
                            onChange={(_: unknown, d: any) => setScopeText((prev) => ({ ...prev, [w.key]: d.value }))}
                          />
                        </Field>
                      ))}
                      {!specificAny && mode.kind === 'create' && (
                        <MessageBar intent="warning"><MessageBarBody>Add at least one location, or choose <strong>All locations</strong> — otherwise the policy publishes to no one.</MessageBarBody></MessageBar>
                      )}
                    </div>
                  )}
                </div>
              </Field>

              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" onClick={save} disabled={busy || (mode.kind === 'create' && !name.trim()) || selected.length === 0 || !scopeValid}>
              {busy ? 'Saving…' : (mode.kind === 'create' ? 'Create policy' : 'Save changes')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Apply label (guided wizard)
// ============================================================

interface ItemRow {
  id: string; itemType: string; displayName: string; workspaceName: string;
  currentLabelId?: string | null; currentLabelName?: string | null;
}

function ApplyLabelSection({ labelsState }: { labelsState: ApiState<LabelsPayload> }) {
  const s = useStyles();
  const [items, setItems] = useState<ApiState<{ ok: boolean; items?: ItemRow[] }>>(emptyState());
  const [selItem, setSelItem] = useState<ItemRow | null>(null);
  const [selLabel, setSelLabel] = useState<string>('');
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const [applyErr, setApplyErr] = useState<string | null>(null);

  // Recommendation (evaluate) helper
  const [content, setContent] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evalResult, setEvalResult] = useState<unknown>(null);
  const [evalErr, setEvalErr] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setItems({ loading: true, data: null });
    const r = await fetchJson<{ ok: boolean; items?: ItemRow[] }>('/api/admin/security/mip/applicable-items');
    setItems({ loading: false, data: r.data, error: r.error, errorStatus: r.status });
  }, []);
  useEffect(() => { loadItems(); }, [loadItems]);

  const appliableLabels = useMemo(
    () => (labelsState.data?.labels || []).filter((l) => l.isActive !== false && l.isAppliable !== false),
    [labelsState.data],
  );

  const apply = async () => {
    if (!selItem || !selLabel) return;
    setApplying(true); setApplyErr(null); setApplyMsg(null);
    const r = await fetchJson<{ ok: boolean; labelName?: string; purviewStatus?: string }>(
      `/api/items/${encodeURIComponent(selItem.itemType)}/${encodeURIComponent(selItem.id)}/sensitivity-label`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ labelId: selLabel }) },
    );
    setApplying(false);
    if (!r.ok) { setApplyErr(r.error || 'Apply failed'); return; }
    const lblName = labelsState.data?.labels?.find((l) => l.id === selLabel)?.displayName || selLabel;
    setApplyMsg(`Applied "${lblName}" to ${selItem.displayName}` + (r.data?.purviewStatus ? ` (Purview: ${r.data.purviewStatus})` : '') + '.');
    loadItems();
  };

  const evaluate = async () => {
    setEvaluating(true); setEvalErr(null); setEvalResult(null);
    const r = await fetchJson<{ ok: boolean; evaluation?: unknown }>('/api/admin/security/mip/evaluate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: selItem?.id, contentSample: content }),
    });
    setEvaluating(false);
    if (!r.ok) { setEvalErr(r.error || 'Evaluation failed'); return; }
    setEvalResult(r.data?.evaluation ?? null);
  };

  const itemList = items.data?.items || [];

  return (
    <div className={s.section}>
      <Subtitle2 block style={{ marginBottom: 4 }}><Tag24Regular style={{ verticalAlign: 'middle', marginRight: 6 }} />Apply a sensitivity label to a Loom item</Subtitle2>
      <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Pick an item, choose a label from the live taxonomy, and apply it. The label is validated against the tenant taxonomy + label policy, written to the item, and (when the item has a Purview asset) stamped on the catalog entry.
      </Caption1>

      <div className={s.fieldStack}>
        <Field label="Step 1 — Loom item" required>
          {items.loading ? <Spinner size="tiny" label="Loading items…" /> : (
            <Dropdown
              placeholder="Select an item to label"
              value={selItem ? `${selItem.displayName} (${selItem.itemType})` : ''}
              selectedOptions={selItem ? [selItem.id] : []}
              onOptionSelect={(_: unknown, d: any) => {
                const it = itemList.find((x) => x.id === d.optionValue) || null;
                setSelItem(it); setApplyMsg(null); setApplyErr(null);
                if (it?.currentLabelId) setSelLabel(it.currentLabelId);
              }}
            >
              {itemList.length === 0 && <Option value="" disabled>No items in your workspaces yet</Option>}
              {itemList.map((it) => (
                <Option key={it.id} value={it.id} text={`${it.displayName} (${it.itemType})`}>
                  {it.displayName} <Caption1>· {it.itemType} · {it.workspaceName}{it.currentLabelName ? ` · labeled: ${it.currentLabelName}` : ''}</Caption1>
                </Option>
              ))}
            </Dropdown>
          )}
        </Field>
        {items.error && <MessageBar intent="error"><MessageBarBody>{items.error}</MessageBarBody></MessageBar>}

        <Field label="Step 2 — Sensitivity label" required>
          {labelsState.notConfigured ? (
            <NotConfiguredBar surface="Sensitivity labels" hint={labelsState.notConfigured} portalLink={ADMIN_PORTAL} />
          ) : (
            <Dropdown
              placeholder="Select a label to apply"
              value={selLabel ? (appliableLabels.find((l) => l.id === selLabel)?.displayName || selLabel) : ''}
              selectedOptions={selLabel ? [selLabel] : []}
              onOptionSelect={(_: unknown, d: any) => setSelLabel(d.optionValue ?? '')}
            >
              {appliableLabels.length === 0 && <Option value="" disabled>No appliable labels available</Option>}
              {appliableLabels.map((l) => (
                <Option key={l.id} value={l.id} text={l.displayName || l.name}>
                  {l.displayName || l.name}{l.hasProtection ? ' (encrypted)' : ''}
                </Option>
              ))}
            </Dropdown>
          )}
        </Field>

        <div>
          <Button appearance="primary" disabled={!selItem || !selLabel || applying} onClick={apply}>
            {applying ? 'Applying…' : 'Apply label'}
          </Button>
          {selItem?.currentLabelName && (
            <Caption1 style={{ marginLeft: 10, color: tokens.colorNeutralForeground3 }}>
              Current: {selItem.currentLabelName}
            </Caption1>
          )}
        </div>
        {applyMsg && <MessageBar intent="success"><MessageBarBody>{applyMsg}</MessageBarBody></MessageBar>}
        {applyErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Could not apply label</MessageBarTitle>{applyErr}</MessageBarBody></MessageBar>}
      </div>

      <div style={{ marginTop: 18, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12 }}>
        <Subtitle2 block style={{ marginBottom: 4 }}>Optional — get a label recommendation</Subtitle2>
        <Caption1 block style={{ color: tokens.colorNeutralForeground3, marginBottom: 8 }}>
          Sends sample content to Microsoft Graph (<code>sensitivityLabels/evaluateApplication</code>) and returns MIP&apos;s recommended label. Loom only relays — the MIP rule engine decides.
        </Caption1>
        <div className={s.fieldStack}>
          <Field label="Content sample (up to 64 KB)">
            <Textarea rows={5} value={content} onChange={(_: unknown, d: any) => setContent(d.value)}
              placeholder="Paste a few lines of content from the item here…" />
          </Field>
          <div>
            <Button appearance="secondary" disabled={!content.trim() || evaluating} onClick={evaluate}>
              {evaluating ? 'Evaluating…' : 'Get recommendation'}
            </Button>
          </div>
        </div>
        {evalErr && <MessageBar intent="error" style={{ marginTop: 10 }}><MessageBarBody>{evalErr}</MessageBarBody></MessageBar>}
        {evalResult !== null && (
          <pre style={{ marginTop: 10, fontSize: 11, backgroundColor: tokens.colorNeutralBackground2, padding: 8, borderRadius: 4, overflow: 'auto', maxHeight: 240 }}>
            {JSON.stringify(evalResult, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

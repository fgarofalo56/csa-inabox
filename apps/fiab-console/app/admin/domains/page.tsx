'use client';

/**
 * /admin/domains — REAL domain CRUD + settings side-pane + assign-workspaces.
 * Backed by /api/admin/domains (Cosmos tenant-settings, id="domains:<tenant>").
 *
 * One-for-one with Fabric's Admin > Domains surface:
 *   • Domains list (name, image/color, workspace count, contributor scope, parent)
 *   • Create new domain (name + admins + description + color/image)
 *   • New subdomain (parentId pre-filled; general settings only)
 *   • Per-row Settings → DomainSettingsPane (6 tabs, all PATCH-backed)
 *   • Per-row Assign workspaces → bulk assign with Fabric's override warning
 *   • Delete domain
 *
 * A domain carries owners/admins, a description, a color/image, and delegated
 * settings (default sensitivity label + certification). Workspaces tag
 * themselves to a domain via their `domain` field. When Microsoft Purview is
 * provisioned the domain mirrors to a Purview collection (honest-gated).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Textarea, Button,
  MessageBar, MessageBarBody, MessageBarTitle, Checkbox,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add24Regular, Delete20Regular, ArrowSync24Regular, Info20Regular,
  MoreHorizontal20Regular, Settings20Regular, BranchFork20Regular, Folder20Regular,
} from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { DomainSettingsPane, type DomainRecord } from '@/lib/panes/domain-settings-pane';
import { DomainImageChip } from '@/lib/components/domain-image-presets';
import { DomainImageGallery } from '@/lib/components/domain-image-gallery';

interface Domain extends DomainRecord {
  createdAt: string; createdBy: string; purviewDomainId?: string;
  workspaceCount?: number;
}

interface Workspace { id: string; name: string; domain?: string; itemCount?: number; }

type PurviewStatus =
  | { configured: true; domains: Array<{ id?: string; name: string }> }
  | { configured: false; gated: boolean; hint: string };

const useStyles = makeStyles({
  explainer: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  nameCell: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  createGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  dialogIntro: { marginBottom: tokens.spacingVerticalM },
  wsName: { flex: 1 },
  wsRow: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
});

const SCOPE_LABEL: Record<string, string> = {
  AllTenant: 'Everyone', AdminsOnly: 'Admins only', SpecificUsersAndGroups: 'Specific users',
};

export default function DomainsPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [purview, setPurview] = useState<PurviewStatus | null>(null);
  const [isTenantAdmin, setIsTenantAdmin] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Create dialog state (also used for subdomains via createParentId).
  const [createOpen, setCreateOpen] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newAdmins, setNewAdmins] = useState('');
  const [newImageKey, setNewImageKey] = useState('');
  const [creating, setCreating] = useState(false);

  // Settings pane.
  const [selected, setSelected] = useState<Domain | null>(null);

  // Assign-workspaces dialog.
  const [assignFor, setAssignFor] = useState<Domain | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/domains');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setDomains(j.domains || []);
      setPurview(j.purview || null);
      setIsTenantAdmin(j.isTenantAdmin !== false);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate(parentId: string | null) {
    setCreateParentId(parentId);
    setNewId(''); setNewName(''); setNewDesc(''); setNewAdmins(''); setNewImageKey('');
    setActionErr(null);
    setCreateOpen(true);
  }

  async function create() {
    if (!newId.trim() || !newName.trim()) { setActionErr('id and name required'); return; }
    setCreating(true); setActionErr(null);
    try {
      const r = await fetch('/api/admin/domains', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: newId.trim(), name: newName.trim(),
          description: newDesc.trim() || undefined,
          admins: newAdmins.trim() || undefined,
          parentId: createParentId || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      // Persist image selection if one was chosen (POST doesn't take imageKey).
      if (newImageKey && j.domain?.id) {
        await fetch(`/api/admin/domains?id=${encodeURIComponent(j.domain.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ imageKey: newImageKey }),
        }).catch(() => {});
      }
      setCreateOpen(false);
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm(`Delete domain "${id}"? Workspaces tagged with this domain will lose the tag.`)) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/admin/domains?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const onSaved = useCallback((updated: DomainRecord) => {
    setDomains((prev) => prev ? prev.map((d) => d.id === updated.id ? { ...d, ...updated } : d) : prev);
    setSelected((prev) => prev && prev.id === updated.id ? { ...prev, ...updated } : prev);
  }, []);

  const purviewNames = useMemo(() => new Set(
    purview && purview.configured ? purview.domains.map((d) => (d.name || '').toLowerCase()) : [],
  ), [purview]);

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of domains || []) m[d.id] = d.name;
    return m;
  }, [domains]);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = domains || [];
    if (!f) return all;
    return all.filter((d) =>
      d.name.toLowerCase().includes(f) ||
      d.id.toLowerCase().includes(f) ||
      (d.description || '').toLowerCase().includes(f) ||
      (d.admins || []).some((o) => o.toLowerCase().includes(f)) ||
      (d.createdBy || '').toLowerCase().includes(f)
    );
  }, [domains, q]);

  const columns: LoomColumn<Domain>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 220, getValue: (d) => d.name,
      render: (d) => (
        <span className={s.nameCell}>
          <DomainImageChip imageKey={d.imageKey} fallbackColor={d.color} size={28} />
          <strong>{d.name}</strong>
          {d.parentId && <Badge appearance="outline" size="small">subdomain</Badge>}
        </span>
      ),
    },
    { key: 'id', label: 'ID', width: 130, render: (d) => <code className={a.codeCell}>{d.id}</code> },
    {
      key: 'parent', label: 'Parent', width: 130,
      getValue: (d) => d.parentId ? (nameById[d.parentId] || d.parentId) : 'Root',
      render: (d) => d.parentId
        ? <Caption1>{nameById[d.parentId] || d.parentId}</Caption1>
        : <Caption1 className={a.muted}>Root</Caption1>,
    },
    {
      key: 'workspaceCount', label: 'Workspaces', width: 110,
      getValue: (d) => d.workspaceCount || 0,
      render: (d) => <Badge appearance="tint" color={d.workspaceCount ? 'brand' : 'subtle'} size="small">{d.workspaceCount || 0}</Badge>,
    },
    {
      key: 'contributors', label: 'Contributors', width: 140,
      getValue: (d) => SCOPE_LABEL[d.contributors?.scope || 'AllTenant'],
      render: (d) => <Caption1>{SCOPE_LABEL[d.contributors?.scope || 'AllTenant']}</Caption1>,
    },
    {
      key: 'admins', label: 'Admins', width: 200, sortable: false,
      getValue: (d) => (d.admins || []).join(' '),
      render: (d) => d.admins && d.admins.length
        ? d.admins.map((o) => <Badge key={o} appearance="outline" size="small" className={a.badgeGapEnd}>{o}</Badge>)
        : <Caption1 className={a.muted}>—</Caption1>,
    },
    {
      key: 'governance', label: 'Governance', width: 120,
      getValue: (d) => (purviewNames.has((d.name || '').toLowerCase()) ? 'Governed' : 'Loom only'),
      render: (d) => purviewNames.has((d.name || '').toLowerCase())
        ? <Badge appearance="tint" color="brand" size="small">Governed</Badge>
        : <Caption1 className={a.muted}>Loom only</Caption1>,
    },
    {
      key: 'actions', label: '', width: 60, sortable: false, filterable: false,
      render: (d) => (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button
              size="small" appearance="subtle" icon={<MoreHorizontal20Regular />}
              onClick={(e) => e.stopPropagation()} aria-label={`Actions for ${d.name}`}
            />
          </MenuTrigger>
          <MenuPopover onClick={(e) => e.stopPropagation()}>
            <MenuList>
              <MenuItem icon={<Settings20Regular />} onClick={() => setSelected(d)}>
                {d.parentId ? 'Subdomain settings' : 'Settings'}
              </MenuItem>
              <MenuItem icon={<Folder20Regular />} onClick={() => setAssignFor(d)}>Assign workspaces</MenuItem>
              {!d.parentId && (
                <MenuItem icon={<BranchFork20Regular />} onClick={() => openCreate(d.id)}>New subdomain</MenuItem>
              )}
              <MenuItem icon={<Delete20Regular />} onClick={() => remove(d.id)}>Delete</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      ),
    },
  ], [s, purviewNames, nameById]); // eslint-disable-line react-hooks/exhaustive-deps

  const parentName = createParentId ? (nameById[createParentId] || createParentId) : null;

  return (
    <AdminShell sectionTitle="Domains">
      <Section title="What is a domain?">
        <div className={s.explainer}>
          <Info20Regular className={a.infoIcon} />
          <Body1 className={a.explainerText}>
            A domain is a governance-scoped, labeled grouping of data products and workspaces —
            Finance, Operations, Mission-Ops. It carries <strong>admins</strong>, contributors, a description,
            an image, and delegated settings, and is the unit Loom uses to organize the tenant&apos;s data estate
            (the same concept Microsoft Purview calls a <em>business domain</em> and Fabric calls a <em>domain</em>).
            Workspaces tag themselves to it via their <code> domain</code> field. Open a domain&apos;s actions to
            configure its settings, assign workspaces, or create a subdomain.
          </Body1>
        </div>
      </Section>

      {purview && !purview.configured && (
        <MessageBar intent="warning" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Purview business-domain mirror not active</MessageBarTitle>
            {purview.hint}
          </MessageBarBody>
        </MessageBar>
      )}
      {purview && purview.configured && (
        <MessageBar intent="success" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Purview mirror active</MessageBarTitle>
            {purview.domains.length} mirrored domain{purview.domains.length === 1 ? '' : 's'} in Purview.
            New domains created here are mirrored automatically.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Could not load domains</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {actionErr && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody>{actionErr}</MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Domains"
        actions={
          <>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button appearance="primary" icon={<Add24Regular />} onClick={() => openCreate(null)}>Create new domain</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by name, id, admin…" />
        {loading && !error ? (
          <Spinner label="Loading domains…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(d) => d.id}
            onRowClick={(d) => setSelected(d)}
            empty={q ? `No domains match "${q}".` : 'No domains defined yet. Click “Create new domain” to create your first one.'}
            ariaLabel="Domains"
          />
        )}
      </Section>

      {/* Create / New subdomain dialog */}
      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{createParentId ? `New subdomain of ${parentName}` : 'Create new domain'}</DialogTitle>
            <DialogContent>
              <div className={s.createGrid}>
                <div>
                  <Caption1 className={a.fieldLabel}>ID (lowercase, hyphens)</Caption1>
                  <Input value={newId} onChange={(_, d) => setNewId(d.value)} placeholder="e.g. finance" className={a.fullWidth} />
                </div>
                <div>
                  <Caption1 className={a.fieldLabel}>Name (required)</Caption1>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder={createParentId ? 'Subdomain name' : 'Finance'} className={a.fullWidth} />
                </div>
                {!createParentId && (
                  <div>
                    <Caption1 className={a.fieldLabel}>Domain admins (optional, comma-separated)</Caption1>
                    <Input
                      value={newAdmins}
                      onChange={(_, d) => setNewAdmins(d.value)}
                      placeholder="alice@contoso.com, fin-admins@contoso.com"
                      className={a.fullWidth}
                    />
                  </div>
                )}
                <div>
                  <Caption1 className={a.fieldLabel}>Description</Caption1>
                  <Textarea value={newDesc} onChange={(_, d) => setNewDesc(d.value)} resize="vertical" className={a.fullWidth} />
                </div>
                {!createParentId && (
                  <div>
                    <Caption1 className={a.fieldLabel}>Image</Caption1>
                    <DomainImageGallery value={newImageKey} onChange={setNewImageKey} />
                  </div>
                )}
                {createParentId && (
                  <Caption1 className={a.muted}>
                    Subdomains have general settings only and inherit their parent domain&apos;s admins.
                  </Caption1>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={create} disabled={creating || !newId.trim() || !newName.trim()}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Settings side pane */}
      <DomainSettingsPane
        domain={selected}
        isTenantAdmin={isTenantAdmin}
        onClose={() => setSelected(null)}
        onSaved={onSaved}
      />

      {/* Assign workspaces dialog */}
      {assignFor && (
        <AssignWorkspacesDialog
          domain={assignFor}
          onClose={() => setAssignFor(null)}
          onDone={() => { setAssignFor(null); load(); }}
        />
      )}
    </AdminShell>
  );
}

// ============================================================
// Assign-workspaces dialog (with Fabric's override warning)
// ============================================================

function AssignWorkspacesDialog({ domain, onClose, onDone }: {
  domain: Domain; onClose: () => void; onDone: () => void;
}) {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [override, setOverride] = useState<Array<{ id: string; name?: string; domain: string }> | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/workspaces')
      .then((r) => r.json())
      .then((j) => setWorkspaces(j.ok ? (j.workspaces || []) : []))
      .catch(() => setWorkspaces([]));
  }, []);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function assign(allowOverride: boolean) {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch('/api/admin/domains/assign-workspaces', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domainId: domain.id, workspaceIds: Array.from(selected), allowOverride }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      if (j.overrideRequired) { setOverride(j.affected || []); return; }
      setResult(`Assigned ${j.updated} workspace${j.updated === 1 ? '' : 's'}${j.skipped ? `, ${j.skipped} not found` : ''}.`);
      setOverride(null);
      setTimeout(onDone, 900);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Assign workspaces to {domain.name}</DialogTitle>
          <DialogContent>
            <Body1 className={s.dialogIntro}>
              Select workspaces to associate with this domain. All items in an assigned workspace are
              associated with the domain.
            </Body1>

            {err && <MessageBar intent="error" className={a.messageBar}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {result && <MessageBar intent="success" className={a.messageBar}><MessageBarBody>{result}</MessageBarBody></MessageBar>}

            {override && (
              <MessageBar intent="warning" className={a.messageBar}>
                <MessageBarBody>
                  <MessageBarTitle>Some workspaces are already assigned to another domain</MessageBarTitle>
                  {override.map((w) => (
                    <div key={w.id}>• <strong>{w.name || w.id}</strong> is currently in “{w.domain}”.</div>
                  ))}
                  Reassigning will override the previous association. Continue?
                </MessageBarBody>
              </MessageBar>
            )}

            {workspaces === null ? (
              <Spinner size="tiny" label="Loading workspaces…" />
            ) : workspaces.length === 0 ? (
              <Caption1 className={a.muted}>No workspaces found.</Caption1>
            ) : (
              <div className={a.scrollList}>
                {workspaces.map((w) => (
                  <label key={w.id} className={s.wsRow}>
                    <Checkbox checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                    <span className={s.wsName}>{w.name || w.id}</span>
                    {w.domain && (
                      <Badge appearance="outline" size="small" color={w.domain === domain.id ? 'brand' : 'warning'}>
                        {w.domain === domain.id ? 'this domain' : w.domain}
                      </Badge>
                    )}
                  </label>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            {override ? (
              <Button appearance="primary" onClick={() => assign(true)} disabled={busy}>
                {busy ? 'Reassigning…' : 'Override & assign'}
              </Button>
            ) : (
              <Button appearance="primary" onClick={() => assign(false)} disabled={busy || selected.size === 0}>
                {busy ? 'Assigning…' : `Assign ${selected.size || ''}`.trim()}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

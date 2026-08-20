'use client';

/**
 * /admin/workspaces — REAL tenant-wide workspace inventory. Backed by
 * /api/admin/workspaces which enumerates every workspace in the tenant
 * with item counts + last activity + capacity assignment.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button, Text, Checkbox,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, DialogTrigger,
  RadioGroup, Radio,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Add24Regular, Settings20Regular, Delete20Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { useAdminTabStyles } from '@/lib/components/ui/admin-tab-styles';
import { WorkspaceCreateWizard } from '@/lib/wizards/workspace-create';
import { WorkspaceSettingsPane } from '@/lib/panes/workspace-settings';
import { AzureConnectionsPane } from '@/lib/panes/azure-connections';
import { WorkspaceAvatar } from '@/lib/components/workspace-avatar';
import {
  bulkDeleteWorkspaces, getWorkspaceAdminStatus, type BulkDeleteResult,
} from '@/lib/api/workspaces';

interface Workspace {
  id: string; name: string; description?: string;
  createdBy?: string; createdAt?: string; updatedAt?: string;
  capacity?: string; domain?: string;
  itemCount: number; lastActivity?: string;
  state?: string;
  /** Power BI-style workspace image pointer (drives the row avatar). */
  image?: { updatedAt?: string } | null;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  nameText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  openLink: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 },
  errorText: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  // Bulk action bar — sits directly above the grid, mirroring /workspaces.
  bulkBar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    marginBottom: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: 0,
  },
  bulkBarSpacer: { flex: 1, minWidth: 0 },
  formCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  // Bounded, scrollable preview of the names about to be deleted.
  confirmScroll: { maxHeight: '180px', overflowY: 'auto', minWidth: 0 },
  confirmList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXXL,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
});

export default function AdminWorkspacesPage() {
  const s = useStyles();
  const a = useAdminTabStyles();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // rel-T108: best-effort enrichment (item counts / owner roles) fell back to
  // defaults on this load — item counts shown may be understated, not truth.
  const [degradedReasons, setDegradedReasons] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<Workspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ----- multi-select + bulk delete -----
  // Probe drives the affordances: GET /api/workspaces/bulk-delete returns the
  // same server truth every admin route uses, and fails CLOSED to false on any
  // error, so a probe failure hides the destructive controls rather than
  // exposing them.
  const [canBulkDelete, setCanBulkDelete] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkDeleteResult | null>(null);
  // "keep" = de-catalog only (default, safe); "delete" = also destroy the
  // underlying Azure resources (irreversible).
  const [bulkDataChoice, setBulkDataChoice] = useState<'keep' | 'delete'>('keep');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setWorkspaces(j.workspaces || []);
      setDegradedReasons(j.degraded && Array.isArray(j.degradedReasons) ? j.degradedReasons : null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Probe the bulk-delete affordance once. Fails closed (the client helper
  // returns canBulkDelete:false on any non-ok / thrown response).
  useEffect(() => {
    let cancelled = false;
    getWorkspaceAdminStatus()
      .then((s) => { if (!cancelled) setCanBulkDelete(s.canBulkDelete === true || s.isAdmin === true); })
      .catch(() => { if (!cancelled) setCanBulkDelete(false); });
    return () => { cancelled = true; };
  }, []);

  // If the probe ever revokes the capability, drop any accumulated selection so
  // a stale confirm dialog can't be submitted.
  useEffect(() => {
    if (!canBulkDelete) {
      setSelected(new Set());
      setConfirmOpen(false);
    }
  }, [canBulkDelete]);

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select-all operates on the ids the table reports as currently visible
  // (post-search / post-filter) — never on rows hidden behind a filter.
  const toggleAll = useCallback((visibleIds: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (visibleIds.length > 0 && visibleIds.every((id) => next.has(id))) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // F7 → open the create wizard; F8 → open settings for the selected (or first) row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if (e.key === 'F7') { e.preventDefault(); setWizardOpen(true); }
      else if (e.key === 'F8') {
        e.preventDefault();
        const list = workspaces || [];
        const target = list.find((w) => w.id === selectedId) || list[0];
        if (target) setSettingsTarget(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaces, selectedId]);

  const onCreated = useCallback((ws: { id: string; name: string; description?: string; capacity?: string; domain?: string; createdBy?: string; createdAt?: string; updatedAt?: string }) => {
    setWorkspaces((prev) => [
      {
        id: ws.id, name: ws.name, description: ws.description,
        capacity: ws.capacity, domain: ws.domain, createdBy: ws.createdBy,
        createdAt: ws.createdAt, updatedAt: ws.updatedAt,
        itemCount: 0, lastActivity: ws.updatedAt, state: 'Active',
      },
      ...(prev || []),
    ]);
    setWizardOpen(false);
  }, []);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    if (!f) return workspaces || [];
    return (workspaces || []).filter((w) =>
      w.name.toLowerCase().includes(f) ||
      (w.description || '').toLowerCase().includes(f) ||
      (w.createdBy || '').toLowerCase().includes(f) ||
      (w.domain || '').toLowerCase().includes(f) ||
      (w.capacity || '').toLowerCase().includes(f)
    );
  }, [workspaces, q]);

  const totalItems = useMemo(() => (workspaces || []).reduce((sum, w) => sum + (w.itemCount || 0), 0), [workspaces]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workspaces || []) m.set(w.id, w.name);
    return m;
  }, [workspaces]);

  const runBulkDelete = useCallback(async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setDeleting(true);
    setDeleteError(null);
    setBulkResult(null);
    try {
      const result = await bulkDeleteWorkspaces(ids, { cascade: bulkDataChoice === 'delete' });
      setBulkResult(result);
      setConfirmOpen(false);
      // Drop only what the server actually confirmed deleted. Ids that came
      // back as `failed` stay selected so the admin can see and retry them.
      const gone = new Set(result.deleted);
      if (gone.size > 0) {
        setWorkspaces((prev) => (prev || []).filter((w) => !gone.has(w.id)));
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of gone) next.delete(id);
          return next;
        });
      }
    } catch (e: any) {
      // Keep the dialog open on a transport/500 failure — nothing was
      // confirmed, so the selection must survive for a retry.
      setDeleteError(e?.message || String(e));
    } finally {
      setDeleting(false);
    }
  }, [selected, bulkDataChoice]);

  const columns: LoomColumn<Workspace>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 280, getValue: (w) => w.name,
      render: (w) => (
        <span className={s.nameCell}>
          <WorkspaceAvatar workspaceId={w.id} name={w.name} image={w.image} size={32} />
          <span className={s.nameText}>
            <strong title={w.name} className={a.ellipsis}>{w.name}</strong>
            {w.description && (
              <Caption1 className={mergeClasses(a.muted, a.ellipsis)}>
                {w.description}
              </Caption1>
            )}
          </span>
        </span>
      ),
    },
    { key: 'createdBy', label: 'Owner', width: 180, getValue: (w) => w.createdBy || '', render: (w) => w.createdBy || '—' },
    {
      key: 'capacity', label: 'Capacity', width: 150, getValue: (w) => w.capacity || '',
      render: (w) => w.capacity ? <Badge appearance="tint" size="small">{w.capacity}</Badge> : '—',
    },
    { key: 'domain', label: 'Domain', width: 140, getValue: (w) => w.domain || '', render: (w) => w.domain || '—' },
    { key: 'itemCount', label: 'Items', width: 100, getValue: (w) => w.itemCount, render: (w) => <strong>{w.itemCount}</strong> },
    {
      key: 'lastActivity', label: 'Last activity', width: 170,
      getValue: (w) => (w.lastActivity ? new Date(w.lastActivity).getTime() : 0),
      render: (w) => <Caption1>{w.lastActivity ? new Date(w.lastActivity).toLocaleString() : '—'}</Caption1>,
    },
    {
      key: 'state', label: 'State', width: 110, getValue: (w) => w.state || 'Active',
      render: (w) => (
        <Badge appearance={w.state === 'Active' || !w.state ? 'filled' : 'outline'} color="success" size="small">
          {w.state || 'Active'}
        </Badge>
      ),
    },
    {
      key: 'connections', label: 'Connections', width: 150, sortable: false, filterable: false,
      render: (w) => (
        <span onClick={(e) => e.stopPropagation()}>
          <AzureConnectionsPane workspaceId={w.id} />
        </span>
      ),
    },
    {
      key: 'open', label: 'Open', width: 100, sortable: false, filterable: false,
      render: (w) => (
        <a href={`/workspaces/${w.id}`} className={s.openLink} onClick={(e) => e.stopPropagation()}>
          Open <Open16Regular />
        </a>
      ),
    },
    {
      key: 'settings', label: 'Settings', width: 110, sortable: false, filterable: false,
      render: (w) => (
        <Button
          appearance="subtle" size="small" icon={<Settings20Regular />}
          aria-label={`Settings for ${w.name}`}
          onClick={(e) => { e.stopPropagation(); setSettingsTarget(w); }}
        >
          Settings
        </Button>
      ),
    },
  ], [s]);

  return (
    <AdminShell
      sectionTitle="Workspaces (tenant-wide)"
      learn={{
        title: 'Workspaces (tenant-wide)',
        content: 'A tenant-wide inventory of every workspace regardless of owner, with item counts and last-activity computed live from Cosmos. Review who owns what, which domain and capacity a workspace maps to, and its current state; open a row to manage its settings, create a new workspace, or select several and delete them in one action.',
        tips: [
          'Item counts and last activity are computed live from Cosmos, so the list reflects real current state.',
          'Search by name, owner, domain, or capacity to find a workspace across the whole tenant.',
          'Create a new workspace with New workspace (or F7); click a row to open its settings.',
          'Tick the checkboxes (or the header box to select everything currently listed) to delete several workspaces at once. Select-all covers only the rows your search leaves visible.',
          'Bulk delete defaults to de-cataloguing only — the underlying Azure resources are kept unless you explicitly choose to destroy them.',
        ],
      }}
    >
      <Body1 className={s.intro}>
        Every workspace in your tenant, regardless of owner. Item counts and last activity computed live from Cosmos.
      </Body1>

      {error && (
        <MessageBar intent="error" className={a.messageBar}>
          <MessageBarBody className={s.errorText}>
            <MessageBarTitle>Could not load workspaces</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {!error && degradedReasons && (
        <MessageBar intent="warning" className={a.messageBar}>
          <MessageBarBody>
            <MessageBarTitle>Some columns may be stale</MessageBarTitle>
            {degradedReasons.includes('item-counts')
              ? 'Live item counts / last-activity could not be read this load (the store was briefly unreachable), so counts may show 0 where items actually exist. '
              : ''}
            {degradedReasons.includes('owner-roles')
              ? 'The owner-role lookup fell back to the workspace creator only. '
              : ''}
            Refresh to retry.
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Workspaces"
        actions={
          <>
            <Caption1 className={a.muted}>
              {filtered.length} workspaces · {totalItems} items total
            </Caption1>
            <Button appearance="primary" icon={<Add24Regular />} onClick={() => setWizardOpen(true)}>New workspace</Button>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by name, owner, domain, capacity…" />

        {canBulkDelete && (
          <div className={s.bulkBar} role="region" aria-label="Bulk actions">
            <Caption1>{`${selected.size} selected`}</Caption1>
            {selected.size > 0 && (
              <Button appearance="subtle" size="small" onClick={clearSelection}>Clear</Button>
            )}
            <div className={s.bulkBarSpacer} />
            <Button
              appearance="primary"
              icon={<Delete20Regular />}
              disabled={selected.size === 0 || deleting}
              onClick={() => { setDeleteError(null); setConfirmOpen(true); }}
            >
              {`Delete selected (${selected.size})`}
            </Button>
          </div>
        )}

        {bulkResult && (
          <MessageBar
            intent={bulkResult.failed.length > 0 ? 'warning' : 'success'}
            className={a.messageBar}
          >
            <MessageBarBody className={s.errorText}>
              Deleted {bulkResult.deleted.length} workspace{bulkResult.deleted.length === 1 ? '' : 's'}.
              {bulkResult.failed.length > 0 && (
                <> {bulkResult.failed.length} failed: {bulkResult.failed
                  .map((f) => `${nameById.get(f.id) ?? f.id} (${f.error})`)
                  .join(', ')}.</>
              )}
              {bulkResult.teardown && (() => {
                const acc = { deleted: 0, not_found: 0, skipped: 0, error: 0 };
                for (const list of Object.values(bulkResult.teardown)) {
                  for (const o of list) for (const r of o.resources) acc[r.result] += 1;
                }
                return (
                  <> Azure teardown: {acc.deleted} deleted
                    {acc.not_found > 0 ? `, ${acc.not_found} already gone` : ''}
                    {acc.skipped > 0 ? `, ${acc.skipped} retained` : ''}
                    {acc.error > 0 ? `, ${acc.error} failed` : ''}.</>
                );
              })()}
            </MessageBarBody>
          </MessageBar>
        )}

        {loading && !error ? (
          <Spinner label="Loading workspaces…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(w) => w.id}
            selection={canBulkDelete ? {
              selectedIds: selected,
              onToggleRow: toggleRow,
              onToggleAll: toggleAll,
              ariaLabel: (w: Workspace) => `Select ${w.name}`,
            } : undefined}
            onRowClick={(w) => { setSelectedId(w.id); setSettingsTarget(w); }}
            empty={q ? `No workspaces match "${q}".` : 'No workspaces in this tenant yet. Create one with “New workspace” (or press F7).'}
            ariaLabel="Workspaces"
          />
        )}
      </Section>

      <Dialog open={confirmOpen} onOpenChange={(_, d) => setConfirmOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{`Delete ${selected.size} workspace${selected.size === 1 ? '' : 's'}?`}</DialogTitle>
            <DialogContent>
              <div className={s.formCol}>
                <Body1>
                  This permanently removes the selected workspaces and every item inside them
                  (lakehouses, notebooks, reports, etc.) from the Loom catalog. This cannot be undone.
                </Body1>
                <Text weight="semibold">Underlying Azure data &amp; services</Text>
                <RadioGroup
                  value={bulkDataChoice}
                  onChange={(_, d) => setBulkDataChoice(d.value as 'keep' | 'delete')}
                >
                  <Radio value="keep" label="Keep underlying data & services (de-catalog only)" />
                  <Radio value="delete" label="Delete everything — also destroy the Azure resources (irreversible)" />
                </RadioGroup>
                {bulkDataChoice === 'keep' ? (
                  <MessageBar intent="info">
                    <MessageBarBody className={s.errorText}>
                      <strong>Provisioned Azure resources are not deleted.</strong> Storage containers,
                      Synapse SQL pools, ADX databases, Event Hubs, and other Azure resources these
                      items created remain in your subscription and keep incurring cost — remove them
                      separately in the Azure portal to avoid orphaned resources.
                    </MessageBarBody>
                  </MessageBar>
                ) : (
                  <MessageBar intent="error">
                    <MessageBarBody className={s.errorText}>
                      <strong>This permanently DELETES the underlying Azure resources</strong> — ADLS
                      lakehouse trees, Synapse pipelines / dedicated pools, ADX databases, Event Hubs +
                      Stream Analytics jobs, Azure Monitor alert rules, Databricks
                      jobs/clusters/notebooks/models, and more — for every selected workspace. Data is
                      unrecoverable. Teardown is best-effort, per resource.
                    </MessageBarBody>
                  </MessageBar>
                )}
                <div className={s.confirmScroll}>
                  <ul className={s.confirmList}>
                    {Array.from(selected).slice(0, 50).map((id) => (
                      <li key={id}>{nameById.get(id) ?? id}</li>
                    ))}
                  </ul>
                  {selected.size > 50 && (
                    <Caption1>…and {selected.size - 50} more.</Caption1>
                  )}
                </div>
                {deleteError && (
                  <MessageBar intent="error">
                    <MessageBarBody className={s.errorText}>{deleteError}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" disabled={deleting}>Cancel</Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                icon={<Delete20Regular />}
                disabled={selected.size === 0 || deleting}
                onClick={runBulkDelete}
              >
                {deleting ? 'Deleting…' : `Delete ${selected.size}`}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <WorkspaceCreateWizard
        open={wizardOpen}
        isAdmin
        onClose={() => setWizardOpen(false)}
        onCreated={onCreated}
      />

      <WorkspaceSettingsPane
        workspace={settingsTarget ? { id: settingsTarget.id, name: settingsTarget.name } : null}
        isAdmin
        onClose={() => setSettingsTarget(null)}
        onSaved={(updated) => {
          setWorkspaces((prev) => (prev || []).map((w) => w.id === updated.id ? {
            ...w,
            name: updated.name, description: updated.description,
            capacity: updated.capacity, domain: updated.domain,
            image: updated.image, updatedAt: updated.updatedAt,
          } : w));
        }}
      />
    </AdminShell>
  );
}

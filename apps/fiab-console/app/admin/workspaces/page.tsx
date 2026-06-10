'use client';

/**
 * /admin/workspaces — REAL tenant-wide workspace inventory. Backed by
 * /api/admin/workspaces which enumerates every workspace in the tenant
 * with item counts + last activity + capacity assignment.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Folder24Regular, Add24Regular, Settings20Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { WorkspaceCreateWizard } from '@/lib/wizards/workspace-create';
import { WorkspaceSettingsPane } from '@/lib/panes/workspace-settings';
import { AzureConnectionsPane } from '@/lib/panes/azure-connections';

interface Workspace {
  id: string; name: string; description?: string;
  createdBy?: string; createdAt?: string; updatedAt?: string;
  capacity?: string; domain?: string;
  itemCount: number; lastActivity?: string;
  state?: string;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalL },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  icon: {
    flexShrink: 0, width: '32px', height: '32px', borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: tokens.colorPaletteBlueBackground2, color: tokens.colorPaletteBlueForeground2,
  },
  nameText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  openLink: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px' },
});

export default function AdminWorkspacesPage() {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<Workspace | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setWorkspaces(j.workspaces || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const columns: LoomColumn<Workspace>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 280, getValue: (w) => w.name,
      render: (w) => (
        <span className={s.nameCell}>
          <span className={s.icon} aria-hidden><Folder24Regular style={{ width: 18, height: 18 }} /></span>
          <span className={s.nameText}>
            <strong title={w.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</strong>
            {w.description && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
    <AdminShell sectionTitle="Workspaces (tenant-wide)">
      <Body1 className={s.intro}>
        Every workspace in your tenant, regardless of owner. Item counts and last activity computed live from Cosmos.
      </Body1>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load workspaces</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Workspaces"
        actions={
          <>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              {filtered.length} workspaces · {totalItems} items total
            </Caption1>
            <Button appearance="primary" icon={<Add24Regular />} onClick={() => setWizardOpen(true)}>New workspace</Button>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by name, owner, domain, capacity…" />
        {loading && !error ? (
          <Spinner label="Loading workspaces…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(w) => w.id}
            onRowClick={(w) => { setSelectedId(w.id); setSettingsTarget(w); }}
            empty={q ? `No workspaces match "${q}".` : 'No workspaces in this tenant yet. Create one with “New workspace” (or press F7).'}
            ariaLabel="Workspaces"
          />
        )}
      </Section>

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
            updatedAt: updated.updatedAt,
          } : w));
        }}
      />
    </AdminShell>
  );
}

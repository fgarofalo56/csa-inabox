'use client';

/**
 * /admin/workspaces — REAL tenant-wide workspace inventory. Backed by
 * /api/admin/workspaces which enumerates every workspace in the tenant
 * with item counts + last activity + capacity assignment.
 */

import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Folder24Regular, Settings16Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { WorkspaceSettingsDrawer } from '@/lib/components/workspace-settings-drawer';
import type { Workspace as ApiWorkspace } from '@/lib/api/workspaces';

type WorkspaceState = 'Active' | 'Provisioning' | 'Suspended' | 'Deleted';

interface Workspace {
  id: string; name: string; description?: string;
  createdBy?: string; createdAt?: string; updatedAt?: string;
  capacity?: string; domain?: string;
  storageAccountId?: string;
  itemCount: number; lastActivity?: string;
  state?: WorkspaceState;
  owners?: string[];
}

/** State → Fluent Badge color. Filled for known states, outline+neutral for unknown. */
const STATE_COLOR: Record<WorkspaceState, React.ComponentProps<typeof Badge>['color']> = {
  Active: 'success',
  Provisioning: 'informative',
  Suspended: 'warning',
  Deleted: 'danger',
};

function StateBadge({ state }: { state?: WorkspaceState }) {
  const known = state && STATE_COLOR[state];
  return (
    <Badge appearance={known ? 'filled' : 'outline'} color={known ? STATE_COLOR[state!] : 'subtle'} size="small">
      {state || 'Active'}
    </Badge>
  );
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
  const [selected, setSelected] = useState<Workspace | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openSettings = useCallback((w: Workspace) => { setSelected(w); setDrawerOpen(true); }, []);

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

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    if (!f) return workspaces || [];
    return (workspaces || []).filter((w) =>
      w.name.toLowerCase().includes(f) ||
      (w.description || '').toLowerCase().includes(f) ||
      (w.createdBy || '').toLowerCase().includes(f) ||
      (w.owners || []).some((o) => o.toLowerCase().includes(f)) ||
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
    {
      key: 'owners', label: 'Owners', width: 220,
      getValue: (w) => (w.owners && w.owners.length ? w.owners.join(', ') : (w.createdBy || '')),
      render: (w) => {
        const list = w.owners && w.owners.length ? w.owners : (w.createdBy ? [w.createdBy] : []);
        if (!list.length) return '—';
        return <span title={list.join(', ')} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{list.join(', ')}</span>;
      },
    },
    {
      key: 'capacity', label: 'Capacity', width: 150, getValue: (w) => w.capacity || '',
      render: (w) => w.capacity ? <Badge appearance="tint" size="small">{w.capacity}</Badge> : '—',
    },
    { key: 'domain', label: 'Domain', width: 140, getValue: (w) => w.domain || '', render: (w) => w.domain || '—' },
    { key: 'itemCount', label: 'Items', width: 100, getValue: (w) => w.itemCount, render: (w) => <strong>{w.itemCount}</strong> },
    {
      key: 'lastActivity', label: 'Last modified', width: 170,
      getValue: (w) => (w.lastActivity ? new Date(w.lastActivity).getTime() : 0),
      render: (w) => <Caption1>{w.lastActivity ? new Date(w.lastActivity).toLocaleString() : '—'}</Caption1>,
    },
    {
      key: 'state', label: 'State', width: 130, getValue: (w) => w.state || 'Active',
      render: (w) => <StateBadge state={w.state} />,
    },
    {
      key: 'open', label: 'Open', width: 90, sortable: false, filterable: false,
      render: (w) => (
        <a href={`/workspaces/${w.id}`} className={s.openLink} onClick={(e) => e.stopPropagation()}>
          Open <Open16Regular />
        </a>
      ),
    },
    {
      key: 'settings', label: 'Govern', width: 110, sortable: false, filterable: false,
      render: (w) => (
        <Button size="small" appearance="subtle" icon={<Settings16Regular />}
          onClick={(e) => { e.stopPropagation(); openSettings(w); }}>
          Settings
        </Button>
      ),
    },
  ], [s, openSettings]);

  // Build the synthetic Workspace the settings drawer expects (lib/api/workspaces).
  const selectedForDrawer: ApiWorkspace | null = useMemo(() => {
    if (!selected) return null;
    return {
      id: selected.id,
      tenantId: (selected as { tenantId?: string }).tenantId || selected.createdBy || selected.id,
      name: selected.name,
      description: selected.description,
      capacity: selected.capacity,
      domain: selected.domain,
      storageAccountId: selected.storageAccountId,
      createdBy: selected.createdBy || '',
      createdAt: selected.createdAt || '',
      updatedAt: selected.updatedAt || '',
      itemCount: selected.itemCount,
    };
  }, [selected]);

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
            onRowClick={openSettings}
            empty={q ? `No workspaces match "${q}".` : 'No workspaces in this tenant yet. Create one from /workspaces.'}
            ariaLabel="Workspaces"
          />
        )}
      </Section>

      {selectedForDrawer && (
        <WorkspaceSettingsDrawer
          workspace={selectedForDrawer}
          open={drawerOpen}
          onOpenChange={(o) => { setDrawerOpen(o); if (!o) setSelected(null); }}
          hideTrigger
        />
      )}
    </AdminShell>
  );
}

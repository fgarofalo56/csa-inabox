'use client';

/**
 * /admin/domains — REAL domain CRUD. Backed by /api/admin/domains
 * persisted in the tenant-settings Cosmos container as a `domains:<tenant>` doc.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Button, Subtitle2,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete20Regular, ArrowSync24Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';

interface Domain {
  id: string; name: string; description?: string; color?: string;
  createdAt: string; createdBy: string;
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12,
    paddingBottom: 12, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  spacer: { flex: 1 },
  swatch: { width: 14, height: 14, borderRadius: 3, display: 'inline-block', verticalAlign: 'middle', marginRight: 6 },
  empty: { padding: 32, color: tokens.colorNeutralForeground3, fontSize: 13, textAlign: 'center' },
});

const PRESET_COLORS = ['#0078d4', '#7719aa', '#107c10', '#dca900', '#d13438', '#3aaaaa', '#bd7800', '#5c2d91'];

export default function DomainsPage() {
  const s = useStyles();
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/admin/domains');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setDomains(j.domains || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!newId.trim() || !newName.trim()) { setActionErr('id and name required'); return; }
    setCreating(true); setActionErr(null);
    try {
      const r = await fetch('/api/admin/domains', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: newId.trim(), name: newName.trim(), description: newDesc.trim(), color: newColor }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setDomains(j.domains || []);
      setCreateOpen(false);
      setNewId(''); setNewName(''); setNewDesc('');
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
      setDomains(j.domains || []);
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  return (
    <AdminShell sectionTitle="Domains">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Domains group workspaces into business areas (Finance, Operations, Marketing). Backed by Cosmos.
      </Body1>

      <div className={s.toolbar}>
        <div className={s.spacer} />
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => setCreateOpen(true)}>Add domain</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load domains</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {actionErr && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>{actionErr}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Loading domains…" />}

      {!loading && !error && (domains?.length ?? 0) === 0 && (
        <div className={s.empty}>
          No domains defined yet. Click <strong>Add domain</strong> to create your first one.
        </div>
      )}

      {!loading && !error && (domains?.length ?? 0) > 0 && (
        <Table aria-label="Domains">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>ID</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Created by</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(domains || []).map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  {d.color && <span className={s.swatch} style={{ backgroundColor: d.color }} />}
                  <strong>{d.name}</strong>
                </TableCell>
                <TableCell><code style={{ fontSize: 11 }}>{d.id}</code></TableCell>
                <TableCell>{d.description || '—'}</TableCell>
                <TableCell><Caption1>{d.createdBy}</Caption1></TableCell>
                <TableCell>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Delete20Regular />}
                    onClick={() => remove(d.id)}
                    aria-label={`Delete domain ${d.id}`}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add domain</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>ID (lowercase, hyphens)</Caption1>
                  <Input value={newId} onChange={(_, d) => setNewId(d.value)} placeholder="e.g. finance" />
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>Display name</Caption1>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="Finance" />
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>Description</Caption1>
                  <Input value={newDesc} onChange={(_, d) => setNewDesc(d.value)} />
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>Color</Caption1>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewColor(c)}
                        aria-label={`Pick color ${c}`}
                        style={{
                          width: 28, height: 28, borderRadius: 4,
                          backgroundColor: c, cursor: 'pointer',
                          border: newColor === c ? `2px solid ${tokens.colorBrandStroke1}` : `1px solid ${tokens.colorNeutralStroke2}`,
                        }}
                      />
                    ))}
                  </div>
                </div>
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
    </AdminShell>
  );
}

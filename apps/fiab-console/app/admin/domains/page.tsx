'use client';

/**
 * /admin/domains — REAL domain CRUD. Backed by /api/admin/domains
 * persisted in the tenant-settings Cosmos container as a `domains:<tenant>` doc.
 *
 * A domain is a governance-scoped, labeled grouping of data products and
 * workspaces (Finance, Operations, Mission-Ops…). It carries owners, a
 * description, and a color. Workspaces tag themselves to a domain via their
 * `domain` field; the Security & governance > Purview surface can mirror the
 * domain as a Purview "business domain" when Purview is provisioned. The
 * Purview mirror is honest-gated here — the Cosmos-backed grouping works
 * regardless of whether Purview is deployed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Textarea, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete20Regular, ArrowSync24Regular, Info20Regular } from '@fluentui/react-icons';
import { AdminShell } from '@/lib/components/admin-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';

interface Domain {
  id: string; name: string; description?: string; color?: string;
  owners?: string[]; purviewDomainId?: string;
  createdAt: string; createdBy: string;
}

type PurviewStatus =
  | { configured: true; domains: Array<{ id?: string; name: string }> }
  | { configured: false; gated: true; hint: string };

const useStyles = makeStyles({
  explainer: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-start',
  },
  swatch: {
    width: '14px', height: '14px', borderRadius: '3px', display: 'inline-block',
    verticalAlign: 'middle', marginRight: '8px', flexShrink: 0,
  },
  nameCell: { display: 'flex', alignItems: 'center', minWidth: 0 },
});

const PRESET_COLORS = ['#0078d4', '#7719aa', '#107c10', '#dca900', '#d13438', '#3aaaaa', '#bd7800', '#5c2d91'];

export default function DomainsPage() {
  const s = useStyles();
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [purview, setPurview] = useState<PurviewStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newOwners, setNewOwners] = useState('');
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
      setPurview(j.purview || null);
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
        body: JSON.stringify({
          id: newId.trim(), name: newName.trim(),
          description: newDesc.trim(), color: newColor,
          owners: newOwners.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setDomains(j.domains || []);
      setCreateOpen(false);
      setNewId(''); setNewName(''); setNewDesc(''); setNewOwners('');
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

  const purviewNames = useMemo(() => new Set(
    purview && purview.configured ? purview.domains.map((d) => (d.name || '').toLowerCase()) : [],
  ), [purview]);

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = domains || [];
    if (!f) return all;
    return all.filter((d) =>
      d.name.toLowerCase().includes(f) ||
      d.id.toLowerCase().includes(f) ||
      (d.description || '').toLowerCase().includes(f) ||
      (d.owners || []).some((o) => o.toLowerCase().includes(f)) ||
      (d.createdBy || '').toLowerCase().includes(f)
    );
  }, [domains, q]);

  const columns: LoomColumn<Domain>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 200, getValue: (d) => d.name,
      render: (d) => (
        <span className={s.nameCell}>
          {d.color && <span className={s.swatch} style={{ backgroundColor: d.color }} />}
          <strong>{d.name}</strong>
        </span>
      ),
    },
    { key: 'id', label: 'ID', width: 140, render: (d) => <code style={{ fontSize: 11 }}>{d.id}</code> },
    {
      key: 'owners', label: 'Owners', width: 220, sortable: false,
      getValue: (d) => (d.owners || []).join(' '),
      render: (d) => d.owners && d.owners.length
        ? d.owners.map((o) => <Badge key={o} appearance="outline" size="small" style={{ marginRight: 4 }}>{o}</Badge>)
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
    { key: 'description', label: 'Description', width: 240, render: (d) => d.description || '—' },
    {
      key: 'governance', label: 'Governance', width: 130,
      getValue: (d) => (purviewNames.has((d.name || '').toLowerCase()) ? 'Governed' : 'Loom only'),
      render: (d) => purviewNames.has((d.name || '').toLowerCase())
        ? <Badge appearance="tint" color="brand" size="small">Governed</Badge>
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loom only</Caption1>,
    },
    { key: 'createdBy', label: 'Created by', width: 160, render: (d) => <Caption1>{d.createdBy}</Caption1> },
    {
      key: 'actions', label: '', width: 110, sortable: false, filterable: false,
      render: (d) => (
        <Button
          size="small" appearance="subtle" icon={<Delete20Regular />}
          onClick={(e) => { e.stopPropagation(); remove(d.id); }}
          aria-label={`Delete domain ${d.id}`}
        >
          Delete
        </Button>
      ),
    },
  ], [s, purviewNames]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AdminShell sectionTitle="Domains">
      <Section title="What is a domain?">
        <div className={s.explainer}>
          <Info20Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0, marginTop: 2 }} />
          <Body1 style={{ color: tokens.colorNeutralForeground2, lineHeight: 1.5 }}>
            A domain is a governance-scoped, labeled grouping of data products and workspaces —
            Finance, Operations, Mission-Ops. It carries <strong>owners</strong>, a description, and a color,
            and is the unit Loom uses to organize the tenant&apos;s data estate (the same concept Microsoft
            Purview calls a <em>business domain</em> and Fabric calls a <em>domain</em>). Adding one here creates
            the grouping in Loom&apos;s Cosmos store immediately; workspaces tag themselves to it via their
            <code> domain</code> field. When Microsoft Purview is provisioned, the same domain can be mirrored
            as a Purview business domain so policies and glossary terms flow with it.
          </Body1>
        </div>
      </Section>

      {/* Honest Purview gate — full surface still renders either way. */}
      {purview && !purview.configured && (
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Purview business-domain mirror not active</MessageBarTitle>
            {purview.hint}
          </MessageBarBody>
        </MessageBar>
      )}
      {purview && purview.configured && (
        <MessageBar intent="success" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Purview mirror active</MessageBarTitle>
            {purview.domains.length} mirrored domain{purview.domains.length === 1 ? '' : 's'} in Purview.
            On the classic Data Map account each Loom domain mirrors to a Purview
            <strong> collection</strong> (classic Data Map has no &quot;business domain&quot; concept). Domains
            whose name matches a Purview collection are marked
            <Badge appearance="tint" color="brand" size="small" style={{ margin: '0 4px' }}>Governed</Badge>
            below. New domains created here are mirrored automatically.
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Could not load domains</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}
      {actionErr && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>{actionErr}</MessageBarBody>
        </MessageBar>
      )}

      <Section
        title="Domains"
        actions={
          <>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button appearance="primary" icon={<Add24Regular />} onClick={() => setCreateOpen(true)}>Add domain</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder="Search by name, id, owner…" />
        {loading && !error ? (
          <Spinner label="Loading domains…" />
        ) : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(d) => d.id}
            empty={q ? `No domains match "${q}".` : 'No domains defined yet. Click “Add domain” to create your first one.'}
            ariaLabel="Domains"
          />
        )}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add domain</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>ID (lowercase, hyphens)</Caption1>
                  <Input value={newId} onChange={(_, d) => setNewId(d.value)} placeholder="e.g. finance" style={{ width: '100%' }} />
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>Display name</Caption1>
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="Finance" style={{ width: '100%' }} />
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>
                    Owners (comma-separated UPNs / group names)
                  </Caption1>
                  <Input
                    value={newOwners}
                    onChange={(_, d) => setNewOwners(d.value)}
                    placeholder="alice@contoso.com, fin-stewards@contoso.com"
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <Caption1 style={{ display: 'block', marginBottom: 4 }}>Description</Caption1>
                  <Textarea value={newDesc} onChange={(_, d) => setNewDesc(d.value)} resize="vertical" style={{ width: '100%' }} />
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

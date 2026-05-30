'use client';

import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';
import {
  Spinner, Button, Input, Field, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Caption1, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete16Regular, ArrowSync24Regular } from '@fluentui/react-icons';

interface Domain { id: string; name: string; description?: string; type?: string; }

export default function CatalogDomainsPage() {
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const live = purview.configured && purview.reason === 'live';
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!live) { setDomains(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/catalog/domains');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setDomains(j.domains);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [live]);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name) return;
    setCreating(true); setError(null);
    try {
      const r = await fetch('/api/catalog/domains', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description: desc }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setName(''); setDesc('');
      load();
    } finally { setCreating(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete domain? This cannot be undone.')) return;
    await fetch(`/api/catalog/domains?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    load();
  }

  return (
    <CatalogShell sectionTitle="Governance domains" sectionBadge="Purview">
      <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Governance domains are the boundary for data products, glossary terms, OKRs, and access policies —
        one-for-one with the Microsoft Purview Unified Catalog. Each domain anchors ownership and discovery.
      </Caption1>

      <PurviewGate status={purview} surface="Governance domains" reload={reloadStatus} />

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Domains unavailable</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 2fr auto auto', gap: 8, alignItems: 'flex-end',
        marginBottom: 16, padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
      }}>
        <Field label="New domain name">
          <Input value={name} onChange={(_, d) => setName(d.value)} disabled={!live} />
        </Field>
        <Field label="Description">
          <Input value={desc} onChange={(_, d) => setDesc(d.value)} disabled={!live} />
        </Field>
        <Button icon={<Add24Regular />} appearance="primary" disabled={!live || !name || creating} onClick={create}>Create</Button>
        <Button icon={<ArrowSync24Regular />} onClick={() => { reloadStatus(); load(); }} disabled={loading}>Refresh</Button>
      </div>

      {live && loading && !error && <Spinner label="Loading domains…" />}

      {live && !loading && !error && domains && domains.length === 0 && (
        <Caption1>No domains defined yet. Create one to anchor data products and access policies.</Caption1>
      )}

      {live && !loading && !error && domains && domains.length > 0 && (
        <Table aria-label="Governance domains">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell></TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.map((d) => (
              <TableRow key={d.id}>
                <TableCell><strong>{d.name}</strong></TableCell>
                <TableCell>{d.description || '—'}</TableCell>
                <TableCell>{d.type || '—'}</TableCell>
                <TableCell>
                  <Button size="small" icon={<Delete16Regular />} onClick={() => remove(d.id)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CatalogShell>
  );
}

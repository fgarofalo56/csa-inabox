'use client';

import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import {
  Spinner, Button, Input, Field, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Caption1, tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete16Regular, ArrowSync24Regular } from '@fluentui/react-icons';

interface Domain { id: string; name: string; description?: string; type?: string; }

export default function CatalogDomainsPage() {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/catalog/domains');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setHint(j.hint); return; }
      setDomains(j.domains);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name) return;
    setCreating(true);
    try {
      const r = await fetch('/api/catalog/domains', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description: desc }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error); setHint(j.hint); return; }
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
    <CatalogShell sectionTitle="Business domains" sectionBadge="Purview">
      {error && (
        <MessageBar intent="warning" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Domains unavailable</MessageBarTitle>
            {error}
            {hint && <pre style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(hint, null, 2)}</pre>}
          </MessageBarBody>
        </MessageBar>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 2fr auto auto', gap: 8, alignItems: 'flex-end',
        marginBottom: 16, padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8,
      }}>
        <Field label="New domain name">
          <Input value={name} onChange={(_, d) => setName(d.value)} />
        </Field>
        <Field label="Description">
          <Input value={desc} onChange={(_, d) => setDesc(d.value)} />
        </Field>
        <Button icon={<Add24Regular />} appearance="primary" disabled={!name || creating} onClick={create}>Create</Button>
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
      </div>

      {loading && !error && <Spinner label="Loading domains…" />}

      {!loading && !error && domains && domains.length === 0 && (
        <Caption1>No domains defined yet. Create one to anchor data products and access policies.</Caption1>
      )}

      {!loading && !error && domains && domains.length > 0 && (
        <Table aria-label="Business domains">
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

'use client';

/**
 * /governance/glossary — business-glossary term management on Microsoft Purview
 * (classic Data Map / Apache Atlas 2.2). Lists and creates standardized business
 * terms; terms are attached to data assets from each item's Classifications
 * panel (lib/components/classification-flyout.tsx → /api/catalog/glossary apply).
 *
 * Backed by the EXISTING BFF route app/api/catalog/glossary/route.ts:
 *   GET  → listGlossaryTerms()      (real Atlas GET, first glossary by default)
 *   POST → createAtlasGlossaryTerm()(real Atlas POST; idempotent on name)
 *
 * Honest gate (no-vaporware): when Microsoft Purview is not provisioned the
 * route answers 501 and this page shows a Fluent MessageBar naming the
 * LOOM_PURVIEW_ACCOUNT env var + the Data Curator role — never a mock list.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Input, Textarea, Button, Field,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Add24Regular, ArrowSync24Regular, BookOpen24Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { EmptyState } from '@/lib/components/empty-state';

interface GlossaryTerm {
  guid: string;
  name: string;
  qualifiedName?: string;
  longDescription?: string;
  status?: string;
  glossaryGuid?: string;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalM },
  banner: { marginBottom: tokens.spacingVerticalL },
  bannerBody: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

export default function GlossaryPage() {
  const s = useStyles();
  const [terms, setTerms] = useState<GlossaryTerm[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ message: string } | null>(null);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch('/api/catalog/glossary');
      const j = await r.json();
      if (!j.ok) {
        if (r.status === 501 || r.status === 503) { setGate({ message: j.error || 'Microsoft Purview is not provisioned.' }); setTerms([]); return; }
        setError(j.error || `HTTP ${r.status}`); return;
      }
      setTerms(j.terms || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name.trim()) { setActionErr('Term name is required'); return; }
    setCreating(true); setActionErr(null); setOk(null);
    try {
      const r = await clientFetch('/api/catalog/glossary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ term: { name: name.trim(), longDescription: desc.trim() || undefined } }),
      });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setOk(`Term "${j.term?.name || name.trim()}" saved to Microsoft Purview.`);
      setCreateOpen(false); setName(''); setDesc('');
      load();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setCreating(false); }
  }

  const filtered = useMemo(() => {
    const f = q.toLowerCase().trim();
    const all = terms || [];
    if (!f) return all;
    return all.filter((t) =>
      (t.name || '').toLowerCase().includes(f) ||
      (t.longDescription || '').toLowerCase().includes(f) ||
      (t.qualifiedName || '').toLowerCase().includes(f),
    );
  }, [terms, q]);

  const columns: LoomColumn<GlossaryTerm>[] = useMemo(() => [
    { key: 'name', label: 'Term', width: 240, getValue: (t) => t.name, render: (t) => <strong>{t.name}</strong> },
    { key: 'status', label: 'Status', width: 130, getValue: (t) => t.status || '', render: (t) => t.status ? <Badge appearance='tint' color={t.status === 'Approved' ? 'success' : 'brand'} size='small'>{t.status}</Badge> : <Caption1>—</Caption1> },
    { key: 'longDescription', label: 'Definition', getValue: (t) => t.longDescription || '', render: (t) => <Caption1>{t.longDescription || '—'}</Caption1> },
  ], []);

  return (
    <GovernanceShell sectionTitle='Glossary'>
      <Body1 className={s.intro}>
        Business-glossary terms in Microsoft Purview (Apache Atlas). Define standardized terms here, then
        attach them to data assets from each item's Classifications panel.
      </Body1>

      {gate && (
        <MessageBar intent='warning' className={s.banner}>
          <MessageBarBody className={s.bannerBody}>
            <MessageBarTitle>Microsoft Purview not provisioned</MessageBarTitle>
            {gate.message} Set <code>LOOM_PURVIEW_ACCOUNT</code> (deployed by <code>platform/fiab/bicep/modules/admin-plane/catalog.bicep</code>) and grant the Console UAMI <strong>Data Curator</strong> on the root collection to manage glossary terms.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && <MessageBar intent='error' className={s.banner}><MessageBarBody className={s.bannerBody}><MessageBarTitle>Could not load glossary</MessageBarTitle>{error}</MessageBarBody></MessageBar>}
      {actionErr && <MessageBar intent='error' className={s.banner}><MessageBarBody className={s.bannerBody}>{actionErr}</MessageBarBody></MessageBar>}
      {ok && <MessageBar intent='success' className={s.banner}><MessageBarBody className={s.bannerBody}>{ok}</MessageBarBody></MessageBar>}

      <Section
        title='Glossary terms'
        actions={
          <>
            <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
            <Button appearance='primary' icon={<Add24Regular />} onClick={() => { setActionErr(null); setOk(null); setCreateOpen(true); }} disabled={!!gate}>Add term</Button>
          </>
        }
      >
        <Toolbar search={q} onSearch={setQ} searchPlaceholder='Search terms…' />
        {loading ? <Spinner label='Loading glossary terms…' /> : (
          <LoomDataTable
            columns={columns}
            rows={filtered}
            getRowId={(t) => t.guid || t.name}
            ariaLabel='Glossary terms'
            empty={gate
              ? 'Connect Microsoft Purview to manage glossary terms.'
              : (q
                ? `No terms match "${q}".`
                : <EmptyState icon={<BookOpen24Regular />} title='No glossary terms yet' body='Create your first business term to start standardizing vocabulary across the catalog.' />)}
          />
        )}
      </Section>

      <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Add glossary term</DialogTitle>
            <DialogContent>
              <div className={s.field}>
                <Field label='Term name'><Input value={name} onChange={(_, d) => setName(d.value)} placeholder='e.g. Customer Lifetime Value' /></Field>
                <Field label='Definition'><Textarea value={desc} onChange={(_, d) => setDesc(d.value)} placeholder='What this term means and when to use it.' resize='vertical' /></Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance='secondary' onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance='primary' onClick={create} disabled={creating || !name.trim()}>{creating ? 'Creating…' : 'Create term'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </GovernanceShell>
  );
}

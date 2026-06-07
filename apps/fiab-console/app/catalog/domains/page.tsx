'use client';

/**
 * Catalog → Domains.
 *
 * The Purview account wired into this deployment is a CLASSIC Data Map account
 * (Microsoft.Purview/accounts), which does NOT expose the new unified-catalog
 * "business / governance domains" surface (/datagovernance @ purview.microsoft.com).
 * Rather than dead-ending on an error, this page renders the governance surface
 * the classic Data Map actually exposes — and that works on this account:
 *
 *   • Collections  — the classic Data Map organizational + security boundary
 *                    (the closest classic equivalent of a domain).
 *                    GET /api/catalog/domains → listCollections()
 *   • Glossary     — the business glossary (Apache Atlas 2.2).
 *                    GET /api/catalog/domains → listGlossaryTerms()
 *
 * A single INFO MessageBar explains that unified-catalog business domains need
 * the new Purview experience, while the classic catalog below stays fully usable.
 */

import { useCallback, useEffect, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';
import {
  Spinner, Button, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Caption1, Body1, Subtitle2, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import {
  ArrowSync20Regular, Open16Regular, FolderOpen24Regular, BookOpen24Regular,
} from '@fluentui/react-icons';

interface Collection {
  name: string;
  friendlyName?: string;
  description?: string;
  parentCollection?: string;
}
interface GlossaryTerm {
  guid: string;
  name?: string;
  longDescription?: string;
  status?: string;
}
interface UnifiedNote {
  available: boolean;
  title: string;
  detail: string;
  portal: string;
  doc: string;
}
interface DomainsResponse {
  ok: boolean;
  collections?: Collection[];
  glossaryTerms?: GlossaryTerm[];
  unifiedCatalog?: UnifiedNote;
  error?: string;
}

const useStyles = makeStyles({
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: '16px', maxWidth: '760px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' },
  grow: { flex: 1 },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '20px',
    marginBottom: '20px',
    boxShadow: tokens.shadow2,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' },
  cardIcon: { color: tokens.colorBrandForeground1 },
  cardDesc: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: '16px', maxWidth: '720px' },
  empty: {
    display: 'block', color: tokens.colorNeutralForeground3,
    padding: '14px 0',
  },
  termDesc: {
    color: tokens.colorNeutralForeground3,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  count: { color: tokens.colorNeutralForeground3, fontWeight: 400 },
});

export default function CatalogDomainsPage() {
  const s = useStyles();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const live = purview.configured && purview.reason === 'live';

  const [data, setData] = useState<DomainsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!live) { setData(null); return; }
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/catalog/domains');
      const j: DomainsResponse = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setData(j);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [live]);

  useEffect(() => { load(); }, [load]);

  const collections = data?.collections ?? [];
  const terms = data?.glossaryTerms ?? [];
  const unified = data?.unifiedCatalog;

  const collectionColumns: LoomColumn<Collection>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (c) => c.name, render: (c) => <Body1><strong>{c.name}</strong></Body1> },
    { key: 'friendlyName', label: 'Friendly name', sortable: true, filterable: true, getValue: (c) => c.friendlyName || '—', render: (c) => c.friendlyName || '—' },
    { key: 'parentCollection', label: 'Parent', sortable: true, filterable: true, getValue: (c) => c.parentCollection || 'root', render: (c) => c.parentCollection || <Badge appearance="tint" size="small">root</Badge> },
    { key: 'description', label: 'Description', sortable: false, filterable: true, getValue: (c) => c.description || '—', render: (c) => c.description || '—' },
  ];
  const termColumns: LoomColumn<GlossaryTerm>[] = [
    { key: 'name', label: 'Term', sortable: true, filterable: true, getValue: (t) => t.name || t.guid, render: (t) => <Body1><strong>{t.name || t.guid}</strong></Body1> },
    { key: 'status', label: 'Status', sortable: true, filterable: true, width: 130, getValue: (t) => t.status || '—', render: (t) => t.status ? <Badge appearance="tint" size="small" color={t.status === 'Approved' ? 'success' : 'brand'}>{t.status}</Badge> : '—' },
    { key: 'longDescription', label: 'Description', sortable: false, filterable: true, getValue: (t) => t.longDescription || '—', render: (t) => <span className={s.termDesc}>{t.longDescription || '—'}</span> },
  ];

  return (
    <CatalogShell sectionTitle="Domains" sectionBadge="Purview Data Map">
      <Caption1 className={s.intro}>
        Governance boundaries for this deployment&apos;s Microsoft Purview account. This account is a
        classic <strong>Data Map</strong>, so domains are expressed through <strong>collections</strong>{' '}
        (the organizational and access boundary for sources, scans, and assets) and the{' '}
        <strong>business glossary</strong>. Both are read live from Purview&apos;s data plane.
      </Caption1>

      <PurviewGate status={purview} surface="Domains" reload={reloadStatus} />

      {/* Honest INFO note (not an error) about unified-catalog business domains. */}
      {(unified || !live) && (
        <MessageBar intent="info" style={{ marginBottom: 20 }}>
          <MessageBarBody>
            <MessageBarTitle>
              {unified?.title || 'Business domains live in the new Purview experience'}
            </MessageBarTitle>
            {unified?.detail ||
              'Unified Catalog "business / governance domains" are only exposed by a Microsoft Purview ' +
              'account onboarded in the new experience (purview.microsoft.com). The account wired into ' +
              'this deployment is a classic Data Map account, which does not expose the /datagovernance ' +
              'business-domains surface. The classic Data Map catalog below is fully usable on this account.'}
          </MessageBarBody>
          <MessageBarActions>
            <Button
              as="a"
              size="small"
              icon={<Open16Regular />}
              href={unified?.portal || 'https://purview.microsoft.com/'}
              target="_blank"
              rel="noreferrer"
            >
              Open new Purview experience
            </Button>
            {unified?.doc && (
              <Button
                as="a"
                size="small"
                appearance="transparent"
                icon={<Open16Regular />}
                href={unified.doc}
                target="_blank"
                rel="noreferrer"
              >
                Setup guide
              </Button>
            )}
          </MessageBarActions>
        </MessageBar>
      )}

      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Classic Data Map catalog</Subtitle2>
        <Button
          icon={<ArrowSync20Regular />}
          onClick={() => { reloadStatus(); load(); }}
          disabled={loading || !live}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Couldn&apos;t load the Data Map catalog</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {live && loading && !error && <Spinner label="Loading collections and glossary…" />}

      {live && !loading && !error && (
        <>
          {/* Collections card */}
          <section className={s.card}>
            <div className={s.cardHead}>
              <FolderOpen24Regular className={s.cardIcon} />
              <Subtitle2>
                Collections <span className={s.count}>({collections.length})</span>
              </Subtitle2>
            </div>
            <Caption1 className={s.cardDesc}>
              Collections are the classic Data Map&apos;s organizational and security boundary — the closest
              equivalent of a domain. They group data sources, scans, and assets and govern who can see them.
            </Caption1>

            <LoomDataTable<Collection>
              columns={collectionColumns}
              rows={collections}
              getRowId={(c) => c.name}
              empty="No collections returned. Register a data source in the Scan plane to populate the root collection."
            />
          </section>

          {/* Glossary card */}
          <section className={s.card}>
            <div className={s.cardHead}>
              <BookOpen24Regular className={s.cardIcon} />
              <Subtitle2>
                Business glossary <span className={s.count}>({terms.length})</span>
              </Subtitle2>
            </div>
            <Caption1 className={s.cardDesc}>
              Glossary terms are the shared business vocabulary across the Data Map. Curate and apply them
              from the catalog&apos;s Glossary surface; they read live via the Apache Atlas 2.2 API.
            </Caption1>

            <LoomDataTable<GlossaryTerm>
              columns={termColumns}
              rows={terms}
              getRowId={(t) => t.guid}
              empty="No glossary terms yet. Create one from the catalog Glossary surface to anchor shared vocabulary."
            />
          </section>
        </>
      )}
    </CatalogShell>
  );
}

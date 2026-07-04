'use client';

/**
 * UnifiedDiscover — the hero "Discover" tab of the Loom Marketplace.
 *
 * Federates every publishable/subscribable product kind across their REAL
 * backends at query time and renders one result grid with an asset-kind + a
 * governance-domain filter:
 *
 *   Data product   POST /api/data-products/search                 (Azure AI Search)
 *   API            GET  /api/marketplace/catalog                   (Azure API Management)
 *   Data share     GET  /api/marketplace/sharing/providers?withShares=true (UC Delta Sharing)
 *   Model/Report   POST /api/data-products/search (productType filter)
 *
 * Each source is best-effort and independent — a source that is not configured
 * contributes nothing and surfaces a small honest note rather than blanking the
 * whole surface (no-vaporware). Selecting an item routes to its kind-specific
 * tab to subscribe / request access.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Body1, Caption1, Text, Badge, Button, Spinner, Card, CardHeader,
  Input, Tag, Tooltip, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, ArrowSync20Regular, Connector20Regular, Database20Regular,
  Share20Regular, DataPie20Regular, Open20Regular, StoreMicrosoft24Regular,
} from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  kinds: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  card: {
    padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    transition: 'box-shadow 0.15s, transform 0.15s',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  meta: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', marginTop: tokens.spacingVerticalXS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS },
  notes: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
});

type Kind = 'Data product' | 'API' | 'Data share' | 'Model & report';
const KINDS: Kind[] = ['Data product', 'API', 'Data share', 'Model & report'];
const KIND_ICON: Record<Kind, ReactElement> = {
  'Data product': <Database20Regular />,
  API: <Connector20Regular />,
  'Data share': <Share20Regular />,
  'Model & report': <DataPie20Regular />,
};

interface Listing {
  id: string;
  kind: Kind;
  title: string;
  subtitle?: string;
  domain?: string;
  owner?: string;
  badges?: string[];
  href?: string;
  /** Which marketplace tab subscribes/uses this listing. */
  goTab?: string;
}

export function UnifiedDiscover({ onGoTab }: { onGoTab?: (tab: string) => void }) {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [activeKinds, setActiveKinds] = useState<Set<Kind>>(new Set(KINDS));
  const [domain, setDomain] = useState<string | null>(null);
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    const out: Listing[] = [];
    const info: string[] = [];

    // Data products + models/reports (same index; split by productType).
    try {
      const r = await fetch('/api/data-products/search', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q: query, selectedFacets: {}, top: 50 }),
      });
      const j = await r.json();
      if (r.status === 501 || (r.status === 503 && j?.code === 'not_configured')) {
        info.push('Data products: Azure AI Search not configured (set LOOM_AI_SEARCH_SERVICE).');
      } else if (j.ok || j.results) {
        for (const h of (j.results || [])) {
          const isModel = /report|semantic|model/i.test(String(h.productType || ''));
          out.push({
            id: `dp:${h.id}`,
            kind: isModel ? 'Model & report' : 'Data product',
            title: h.displayName,
            subtitle: h.description,
            domain: h.domainName,
            owner: h.owner,
            badges: [h.productType, ...(h.glossaryTerms || [])].filter(Boolean),
            href: h.url,
            goTab: 'products',
          });
        }
      }
    } catch { info.push('Data products: search unavailable.'); }

    // APIs (APIM).
    try {
      const r = await fetch('/api/marketplace/catalog');
      const j = await r.json();
      if (r.status === 503 && j?.gated) {
        info.push('APIs: API Management not provisioned (set LOOM_APIM_NAME + LOOM_SUBSCRIPTION_ID).');
      } else if (j.ok || j.products || j.apis) {
        for (const p of (j.products || [])) {
          out.push({ id: `api-prod:${p.id || p.name}`, kind: 'API', title: p.displayName || p.name,
            subtitle: p.description, badges: ['Product', ...(p.state ? [String(p.state)] : [])].filter(Boolean), goTab: 'apis' });
        }
        for (const a of (j.apis || [])) {
          out.push({ id: `api:${a.id || a.name}`, kind: 'API', title: a.displayName || a.name,
            subtitle: a.description || a.path, badges: ['API', a.protocols?.join?.(', ')].filter(Boolean), goTab: 'apis' });
        }
      }
    } catch { info.push('APIs: catalog unavailable.'); }

    // Data shares (inbound Delta Sharing providers + their shares).
    try {
      const r = await fetch('/api/marketplace/sharing/providers?withShares=true');
      const j = await r.json();
      if (r.status === 501 && j?.gated) {
        info.push('Data shares: no Databricks workspace bound (Delta Sharing optional).');
      } else if (j.ok) {
        for (const p of (j.providers || [])) {
          for (const sh of (p.shares || [])) {
            out.push({ id: `share:${p.name}.${sh.name}`, kind: 'Data share', title: sh.name,
              subtitle: `From provider ${p.name}`, badges: ['Delta Sharing', 'No-copy'], goTab: 'shares' });
          }
          if ((p.shares || []).length === 0) {
            out.push({ id: `provider:${p.name}`, kind: 'Data share', title: p.name,
              subtitle: 'Provider (no shares exposed yet)', badges: ['Provider'], goTab: 'shares' });
          }
        }
      }
    } catch { /* shares optional */ }

    setListings(out);
    setNotes(info);
    setLoading(false);
  }, []);

  useEffect(() => { void load(submitted); }, [submitted, load]);

  const domains = useMemo(
    () => Array.from(new Set((listings || []).map((l) => l.domain).filter(Boolean))) as string[],
    [listings],
  );
  const filtered = useMemo(
    () => (listings || []).filter((l) => activeKinds.has(l.kind) && (!domain || l.domain === domain)),
    [listings, activeKinds, domain],
  );

  const toggleKind = (k: Kind) => setActiveKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next.size === 0 ? new Set(KINDS) : next;
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of (listings || [])) c[l.kind] = (c[l.kind] || 0) + 1;
    return c;
  }, [listings]);

  return (
    <div className={s.pad}>
      <div className={s.row}>
        <Input style={{ minWidth: 360, flex: 1 }} contentBefore={<Search20Regular />}
          placeholder="Search all products, APIs and data shares…"
          value={q} onChange={(_, d) => setQ(d.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSubmitted(q); }} />
        <Button appearance="primary" icon={<Search20Regular />} onClick={() => setSubmitted(q)}>Search</Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load(submitted)}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
        <Text size={200}>{filtered.length} listing{filtered.length === 1 ? '' : 's'}</Text>
      </div>

      <div className={s.kinds}>
        <Caption1 className={s.hint}>Show:</Caption1>
        {KINDS.map((k) => (
          <Tag key={k} appearance={activeKinds.has(k) ? 'filled' : 'outline'} icon={KIND_ICON[k]}
            onClick={() => toggleKind(k)} style={{ cursor: 'pointer' }}>
            {k} {counts[k] ? `(${counts[k]})` : ''}
          </Tag>
        ))}
        {domains.length > 0 && (
          <>
            <Caption1 className={s.hint} style={{ marginLeft: tokens.spacingHorizontalS }}>Domain:</Caption1>
            <Tag appearance={!domain ? 'filled' : 'outline'} onClick={() => setDomain(null)} style={{ cursor: 'pointer' }}>All</Tag>
            {domains.map((d) => (
              <Tag key={d} appearance={domain === d ? 'filled' : 'outline'} onClick={() => setDomain(d)} style={{ cursor: 'pointer' }}>{d}</Tag>
            ))}
          </>
        )}
      </div>

      {notes.length > 0 && (
        <div className={s.notes}>
          {notes.map((n) => <Caption1 key={n} className={s.hint}>• {n}</Caption1>)}
        </div>
      )}

      {filtered.length === 0 && !loading && (
        <EmptyState
          icon={<StoreMicrosoft24Regular />}
          title="No marketplace listings yet"
          body="Publish a data product, expose an API through API Management, or bind a Databricks workspace to subscribe to live Delta Sharing data shares — they'll all surface here."
        />
      )}

      <TileGrid minTileWidth={280}>
        {filtered.map((l) => (
          <Tooltip key={l.id} relationship="description" content={l.subtitle || l.title}>
            <Card className={s.card}>
              <CardHeader image={KIND_ICON[l.kind]}
                header={<Body1><b>{l.title}</b></Body1>}
                description={<Caption1 className={s.hint}>{l.subtitle || '—'}</Caption1>} />
              <div className={s.meta}>
                <Badge appearance="tint" color="brand">{l.kind}</Badge>
                {l.domain && <Badge appearance="outline">{l.domain}</Badge>}
                {l.owner && <Caption1 className={s.hint}>Owner: {l.owner}</Caption1>}
                {(l.badges || []).slice(0, 4).map((b) => <Tag key={b} size="extra-small">{b}</Tag>)}
              </div>
              <div className={s.actions}>
                {l.href && <Button as="a" size="small" icon={<Open20Regular />} href={l.href}>Open</Button>}
                {l.goTab && onGoTab && (
                  <Button size="small" appearance="primary" onClick={() => onGoTab(l.goTab!)}>
                    {l.kind === 'API' ? 'Subscribe' : l.kind === 'Data share' ? 'Subscribe' : 'Request access'}
                  </Button>
                )}
              </div>
            </Card>
          </Tooltip>
        ))}
      </TileGrid>
    </div>
  );
}

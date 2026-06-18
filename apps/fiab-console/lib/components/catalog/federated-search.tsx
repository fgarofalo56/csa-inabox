'use client';

/**
 * FederatedSearch — single search box across Purview + UC + OneLake.
 *
 * Hits /api/catalog/search and renders per-source success badges (so users
 * see at a glance which back-end is contributing) plus a unified result
 * table with filter chips for source and type.
 *
 * Web-3.0 layout (per docs/fiab/design/ui-web3-guide.md):
 *   • A left gutter so nothing butts the CatalogShell sidebar's vertical rule.
 *   • Search / Sources / Results each wrapped in a <Section> — real vertical
 *     rhythm, never smushed together.
 *   • The search box is capped (≤360px), never full-bleed.
 *   • Colored, keyboard-activatable source/type chips carry an itemVisual
 *     icon + brand color.
 *   • Results render in <LoomDataTable> (sort + resize + per-column filter),
 *     Name cells get an icon+color chip, classifications become spaced pills.
 *
 * When a source is not provisioned, the chip reads "(not configured)" and a
 * MessageBar surfaces the bicep + role remediation payload from the API —
 * per no-vaporware.md, no source is faked.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Badge,
  Caption1,
  Text,
  SearchBox,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Spinner,
  makeStyles,
  tokens,
  mergeClasses,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Open16Regular, Search16Regular } from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';

interface FederatedHit {
  source: 'purview' | 'unity-catalog' | 'onelake';
  id: string;
  display_name: string;
  type: string;
  description?: string;
  owner?: string;
  workspace_name?: string;
  domain?: string;
  classifications?: string[];
  qualified_name?: string;
  updated_at?: string;
  detail_path: string;
}

interface SourceResult { ok: boolean; count: number; error?: string; hint?: unknown; durationMs: number; }

const SOURCES = ['purview', 'unity-catalog', 'onelake'] as const;
type SourceKey = (typeof SOURCES)[number];

const SOURCE_LABEL: Record<SourceKey, string> = {
  purview: 'Purview',
  'unity-catalog': 'Unity Catalog',
  // Azure-native default = the tenant's own Loom workspaces/items; real Fabric
  // OneLake is opt-in (LOOM_LAKEHOUSE_BACKEND=fabric).
  onelake: 'Loom workspaces',
};

const SOURCE_COLORS: Record<string, 'brand' | 'severe' | 'informative' | 'success' | 'warning'> = {
  purview: 'severe', 'unity-catalog': 'brand', onelake: 'informative',
};

const useStyles = makeStyles({
  // left gutter so content never touches the sidebar's vertical rule.
  // minWidth:0 lets this wrapper shrink below its content's min-content so the
  // paddingLeft can never combine with a non-shrinking child to overflow the
  // body track and bleed across the CatalogShell sidebar rule.
  gutter: {
    paddingLeft: tokens.spacingHorizontalL,
    minWidth: 0,
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  search: {
    // flex (not a hard width) so the box shrinks with the body track instead of
    // imposing a min-content floor that pushes content across the sidebar rule.
    flex: '1 1 280px',
    maxWidth: '360px',
    minWidth: 0,
  },
  searchHint: {
    color: tokens.colorNeutralForeground3,
    // Shrink/ellipsize so the hint copy never imposes a word-level min-content
    // floor on the wrapping searchRow (which would push the card past the rule).
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chipRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  chipRowSpaced: {
    marginTop: tokens.spacingVerticalM,
  },
  chipLabel: {
    color: tokens.colorNeutralForeground3,
    marginRight: tokens.spacingHorizontalXS,
  },
  // keyboard-activatable filter chip: icon dot + colored tint when active
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: '5px',
    paddingBottom: '5px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusCircular,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color, border-color, box-shadow',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '2px',
    },
  },
  chipActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    border: `1px solid ${tokens.colorBrandStroke2}`,
    fontWeight: tokens.fontWeightSemibold,
  },
  chipDot: {
    width: '8px',
    height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    flexShrink: 0,
  },
  chipCount: {
    color: tokens.colorNeutralForeground3,
  },
  resultCount: {
    marginLeft: 'auto',
    color: tokens.colorNeutralForeground3,
    // never set a hard floor on the wrapping chipRow
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  hintBox: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    marginTop: tokens.spacingVerticalXS,
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: 'pre-wrap',
  },
  // spacing for per-source remediation MessageBars (griffel class, not inline)
  sourceBar: {
    marginTop: tokens.spacingVerticalM,
  },
  // Name cell: color icon chip + name + qualified-name caption
  nameCell: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalSNudge,
    minWidth: 0,
  },
  nameChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: tokens.borderRadiusMedium,
  },
  nameText: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  nameTitle: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  nameSub: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // classifications: spaced tag-pills, wrapping
  classRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
  },
  openLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

/** A keyboard-activatable filter chip with a colored dot. */
function FilterChip({
  active,
  color,
  onToggle,
  testId,
  children,
}: {
  active: boolean;
  color?: string;
  onToggle: () => void;
  testId?: string;
  children: React.ReactNode;
}) {
  const s = useStyles();
  return (
    <span
      className={mergeClasses(s.chip, active ? s.chipActive : undefined)}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      data-testid={testId}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {color && <span className={s.chipDot} style={{ backgroundColor: color }} aria-hidden />}
      {children}
    </span>
  );
}

export function FederatedSearch() {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState('');
  const [hits, setHits] = useState<FederatedHit[]>([]);
  const [sources, setSources] = useState<Record<string, SourceResult>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Click a result row/name → open a metadata tile with the full catalog record.
  const [detail, setDetail] = useState<FederatedHit | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (sourceFilter.size) params.set('source', Array.from(sourceFilter).join(','));
      const r = await fetch(`/api/catalog/search?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); return; }
      setHits(j.hits || []);
      setSources(j.sources || {});
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [q, sourceFilter]);

  useEffect(() => { load(); }, [load]);

  const filteredHits = useMemo(() => {
    return hits.filter((h) => !typeFilter || h.type === typeFilter);
  }, [hits, typeFilter]);

  const types = useMemo(() => {
    const t = new Set<string>();
    for (const h of hits) if (h.type) t.add(h.type);
    return Array.from(t).sort();
  }, [hits]);

  const failedSources = useMemo(
    () => Object.entries(sources).filter(([, v]) => !v.ok),
    [sources],
  );

  function toggleSource(src: string) {
    const next = new Set(sourceFilter);
    if (next.has(src)) next.delete(src); else next.add(src);
    setSourceFilter(next);
  }

  const columns: LoomColumn<FederatedHit>[] = useMemo(() => [
    {
      key: 'display_name',
      label: 'Name',
      width: 300,
      minWidth: 200,
      getValue: (h) => h.display_name,
      render: (h) => {
        const visual = itemVisual(h.type);
        const Icon = visual.icon;
        return (
          <span className={s.nameCell}>
            <span
              className={s.nameChip}
              style={{ backgroundColor: `${visual.color}1f`, color: visual.color }}
              aria-hidden
            >
              <Icon style={{ width: 18, height: 18, color: visual.color }} />
            </span>
            <span className={s.nameText}>
              <Text className={s.nameTitle} title={h.display_name}>{h.display_name}</Text>
              {h.qualified_name && h.qualified_name !== h.display_name && (
                <Caption1 className={s.nameSub} title={h.qualified_name}>{h.qualified_name}</Caption1>
              )}
            </span>
          </span>
        );
      },
    },
    {
      key: 'source',
      label: 'Source',
      width: 150,
      getValue: (h) => SOURCE_LABEL[h.source] ?? h.source,
      render: (h) => (
        <Badge appearance="filled" color={SOURCE_COLORS[h.source] || 'subtle'} size="small">
          {SOURCE_LABEL[h.source] ?? h.source}
        </Badge>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      width: 170,
      getValue: (h) => itemVisual(h.type).label,
      render: (h) => <Text>{itemVisual(h.type).label}</Text>,
    },
    {
      key: 'location',
      label: 'Workspace / Domain',
      width: 200,
      getValue: (h) => h.workspace_name || h.domain || '',
      render: (h) =>
        h.workspace_name || h.domain
          ? <Text>{h.workspace_name || h.domain}</Text>
          : <Text className={s.muted}>—</Text>,
    },
    {
      key: 'owner',
      label: 'Owner',
      width: 160,
      getValue: (h) => h.owner || '',
      render: (h) => (h.owner ? <Text>{h.owner}</Text> : <Text className={s.muted}>—</Text>),
    },
    {
      key: 'classifications',
      label: 'Classifications',
      width: 220,
      filterable: true,
      getValue: (h) => (h.classifications || []).join(' '),
      render: (h) =>
        h.classifications && h.classifications.length ? (
          <span className={s.classRow}>
            {h.classifications.map((c) => (
              <Badge key={c} appearance="tint" color="informative" size="small">{c}</Badge>
            ))}
          </span>
        ) : (
          <Text className={s.muted}>—</Text>
        ),
    },
    {
      key: 'open',
      label: '',
      width: 90,
      minWidth: 80,
      sortable: false,
      filterable: false,
      getValue: () => '',
      render: (h) => (
        <a
          className={s.openLink}
          href={h.detail_path}
          onClick={(e) => e.stopPropagation()}
        >
          Open <Open16Regular />
        </a>
      ),
    },
  ], [s]);

  return (
    <div className={s.gutter}>
      {/* ── Search ─────────────────────────────────────────────────── */}
      <Section title="Search">
        <div className={s.searchRow}>
          <SearchBox
            className={s.search}
            placeholder="Search Purview, Unity Catalog, OneLake…"
            value={q}
            onChange={(_, d) => setQ(d.value ?? '')}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
            data-testid="catalog-search-input"
          />
          <Button
            icon={loading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
            appearance="primary"
            onClick={load}
            disabled={loading}
          >
            {loading ? 'Searching…' : 'Search'}
          </Button>
          <Caption1 className={s.searchHint}>
            One query across all three governed catalogs.
          </Caption1>
        </div>
      </Section>

      {/* ── Sources + Type filters ─────────────────────────────────── */}
      <Section title="Sources">
        <div className={s.chipRow}>
          <Caption1 className={s.chipLabel}>Filter by source</Caption1>
          {SOURCES.map((src) => {
            const stat = sources[src];
            const active = sourceFilter.size === 0 || sourceFilter.has(src);
            const visual = itemVisual(src === 'onelake' ? 'lakehouse' : src === 'unity-catalog' ? 'warehouse' : 'data-product');
            return (
              <FilterChip
                key={src}
                active={active}
                color={visual.color}
                onToggle={() => toggleSource(src)}
                testId={`source-chip-${src}`}
              >
                {SOURCE_LABEL[src]}
                <span className={s.chipCount}>
                  {stat ? (stat.ok ? `· ${stat.count}` : '· not configured') : ''}
                </span>
              </FilterChip>
            );
          })}
          <Caption1 className={s.resultCount} data-testid="result-count">
            {filteredHits.length} result{filteredHits.length === 1 ? '' : 's'}
          </Caption1>
        </div>

        {types.length > 1 && (
          <div className={mergeClasses(s.chipRow, s.chipRowSpaced)}>
            <Caption1 className={s.chipLabel}>Filter by type</Caption1>
            <FilterChip active={!typeFilter} onToggle={() => setTypeFilter('')}>All</FilterChip>
            {types.map((t) => {
              const visual = itemVisual(t);
              return (
                <FilterChip
                  key={t}
                  active={typeFilter === t}
                  color={visual.color}
                  onToggle={() => setTypeFilter(t === typeFilter ? '' : t)}
                >
                  {visual.label}
                </FilterChip>
              );
            })}
          </div>
        )}

        {/* Per-source NotConfigured hints — real remediation payload */}
        {failedSources.map(([src, stat]) => (
          <MessageBar key={src} intent="warning" className={s.sourceBar}>
            <MessageBarBody>
              <MessageBarTitle>{SOURCE_LABEL[src as SourceKey] ?? src} not contributing</MessageBarTitle>
              <Text>{stat.error}</Text>
              {stat.hint != null && (
                <pre className={s.hintBox}>{JSON.stringify(stat.hint, null, 2)}</pre>
              )}
            </MessageBarBody>
          </MessageBar>
        ))}
      </Section>

      {/* ── Results ────────────────────────────────────────────────── */}
      <Section title="Results">
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Search failed</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        ) : (
          <LoomDataTable<FederatedHit>
            columns={columns}
            rows={filteredHits}
            getRowId={(h) => `${h.source}:${h.id}`}
            loading={loading}
            onRowClick={(h) => setDetail(h)}
            ariaLabel="Catalog search results"
            empty={
              <EmptyState
                icon={<Search16Regular />}
                title="No results"
                body="Try a broader keyword, clear the type filter, or check the source warnings above."
              />
            }
          />
        )}
      </Section>

      <CatalogDetailTile hit={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

/** Full-metadata tile shown when a result row/name is clicked. */
function CatalogDetailTile({ hit, onClose }: { hit: FederatedHit | null; onClose: () => void }) {
  const s = useStyles();
  if (!hit) return null;
  const visual = itemVisual(hit.type);
  const Icon = visual.icon;
  const meta: Array<{ label: string; value?: string }> = [
    { label: 'Source', value: SOURCE_LABEL[hit.source] ?? hit.source },
    { label: 'Type', value: visual.label },
    { label: 'Workspace / Domain', value: hit.workspace_name || hit.domain },
    { label: 'Owner', value: hit.owner },
    { label: 'Qualified name', value: hit.qualified_name },
    { label: 'Identifier', value: hit.id },
    { label: 'Last updated', value: hit.updated_at },
  ].filter((m) => m.value);

  return (
    <Dialog open onOpenChange={(_e, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 620 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 8, backgroundColor: `${visual.color}1f`, color: visual.color }}>
                <Icon style={{ width: 20, height: 20, color: visual.color }} />
              </span>
              {hit.display_name}
            </span>
          </DialogTitle>
          <DialogContent>
            {hit.description && (
              <Text style={{ display: 'block', marginBottom: 14, color: tokens.colorNeutralForeground2 }}>{hit.description}</Text>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 8, columnGap: 12 }}>
              {meta.map((m) => (
                <Fragment key={m.label}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{m.label}</Caption1>
                  <Text style={{ wordBreak: 'break-word' }}>{m.value}</Text>
                </Fragment>
              ))}
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Classifications</Caption1>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {hit.classifications && hit.classifications.length
                  ? hit.classifications.map((c) => <Badge key={c} appearance="tint" color="informative" size="small">{c}</Badge>)
                  : <Text className={s.muted}>None</Text>}
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Close</Button>
            <Button appearance="primary" as="a" href={hit.detail_path} icon={<Open16Regular />}>Open in catalog</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

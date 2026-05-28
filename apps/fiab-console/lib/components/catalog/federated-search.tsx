'use client';

/**
 * FederatedSearch — single search box across Purview + UC + OneLake.
 *
 * Hits /api/catalog/search and renders per-source success badges in the
 * toolbar (so users see at a glance which back-end is contributing) plus
 * a unified result table with filter chips for source, type, and owner.
 *
 * When a source is not provisioned, the chip displays "(not configured)"
 * and a click-through MessageBar surfaces the bicep + role remediation
 * payload from the API — per no-vaporware.md, no source is faked.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Input, Button, Spinner, Badge, Caption1, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens, Subtitle2, Body1,
} from '@fluentui/react-components';
import { Search24Regular, ArrowSync24Regular, Open16Regular } from '@fluentui/react-icons';

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

interface SourceResult { ok: boolean; count: number; error?: string; hint?: any; durationMs: number; }

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 },
  spacer: { flex: 1 },
  sourceRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' },
  chip: { padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2 },
  chipActive: { backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, borderColor: tokens.colorBrandStroke2 },
  tableWrap: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, overflow: 'auto' },
  hintBox: { fontSize: 12, color: tokens.colorNeutralForeground3, marginTop: 4, fontFamily: 'monospace', whiteSpace: 'pre-wrap' },
});

const SOURCE_COLORS: Record<string, 'brand' | 'severe' | 'informative' | 'success' | 'warning'> = {
  purview: 'severe', 'unity-catalog': 'brand', onelake: 'informative',
};

export function FederatedSearch() {
  const s = useStyles();
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState('');
  const [hits, setHits] = useState<FederatedHit[]>([]);
  const [sources, setSources] = useState<Record<string, SourceResult>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e: any) {
      setError(e?.message || String(e));
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

  function toggleSource(src: string) {
    const next = new Set(sourceFilter);
    if (next.has(src)) next.delete(src); else next.add(src);
    setSourceFilter(next);
  }

  return (
    <>
      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Search across Purview + Unity Catalog + OneLake…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
          style={{ flex: 1, maxWidth: 600 }}
          data-testid="catalog-search-input"
        />
        <Button icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </div>

      <div className={s.sourceRow}>
        <Subtitle2>Sources:</Subtitle2>
        {(['purview', 'unity-catalog', 'onelake'] as const).map((src) => {
          const stat = sources[src];
          const active = sourceFilter.size === 0 || sourceFilter.has(src);
          return (
            <span
              key={src}
              className={`${s.chip} ${active ? s.chipActive : ''}`}
              onClick={() => toggleSource(src)}
              role="button"
              tabIndex={0}
              data-testid={`source-chip-${src}`}
            >
              {src} {stat ? (stat.ok ? `(${stat.count})` : '(not configured)') : ''}
            </span>
          );
        })}
        <div className={s.spacer} />
        <Caption1>{filteredHits.length} result{filteredHits.length === 1 ? '' : 's'}</Caption1>
      </div>

      {/* Per-source NotConfigured hints */}
      {Object.entries(sources).filter(([, v]) => !v.ok).map(([src, stat]) => (
        <MessageBar key={src} intent="warning" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>{src} not contributing</MessageBarTitle>
            <Body1>{stat.error}</Body1>
            {stat.hint && (
              <pre className={s.hintBox}>{JSON.stringify(stat.hint, null, 2)}</pre>
            )}
          </MessageBarBody>
        </MessageBar>
      ))}

      {types.length > 1 && (
        <div className={s.sourceRow}>
          <Subtitle2>Type:</Subtitle2>
          <span className={`${s.chip} ${!typeFilter ? s.chipActive : ''}`} onClick={() => setTypeFilter('')} role="button" tabIndex={0}>All</span>
          {types.map((t) => (
            <span key={t} className={`${s.chip} ${typeFilter === t ? s.chipActive : ''}`} onClick={() => setTypeFilter(t === typeFilter ? '' : t)} role="button" tabIndex={0}>{t}</span>
          ))}
        </div>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Search failed</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading && !error && <Spinner label="Searching…" />}

      {!loading && filteredHits.length === 0 && !error && (
        <div style={{ padding: 32, textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
          No results. Try a broader keyword, clear filters, or check the source warnings above.
        </div>
      )}

      {filteredHits.length > 0 && (
        <div className={s.tableWrap}>
          <Table aria-label="Catalog search results">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Source</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Workspace / Domain</TableHeaderCell>
                <TableHeaderCell>Owner</TableHeaderCell>
                <TableHeaderCell>Classifications</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredHits.map((h) => (
                <TableRow key={`${h.source}:${h.id}`}>
                  <TableCell><strong>{h.display_name}</strong>{h.qualified_name && h.qualified_name !== h.display_name && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{h.qualified_name}</Caption1>}</TableCell>
                  <TableCell><Badge appearance="filled" color={SOURCE_COLORS[h.source] || 'subtle'} size="small">{h.source}</Badge></TableCell>
                  <TableCell>{h.type}</TableCell>
                  <TableCell>{h.workspace_name || h.domain || '—'}</TableCell>
                  <TableCell>{h.owner || '—'}</TableCell>
                  <TableCell>{(h.classifications && h.classifications.length) ? h.classifications.join(', ') : '—'}</TableCell>
                  <TableCell>
                    <a href={h.detail_path} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                      Open <Open16Regular />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

'use client';

/**
 * /learn — the CSA Loom Learning Hub.
 *
 * A Synapse-Knowledge-Center-style experience: a single hub that composes the
 * platform's real, installable assets into a guided, Loom-native learning
 * surface. Five sections behind a TabList, plus an always-available guided
 * Copilot:
 *
 *   • Gallery   — categorized cards of use-case WALKTHROUGHS. Each card with a
 *                 registered content bundle installs + provisions the example
 *                 app in one click (InstallAppDialog → POST /api/apps/{id}/install
 *                 → real Azure-native provisioning) and opens its walkthrough.
 *   • Notebooks — every prebuilt Spark/Databricks notebook across the app
 *                 bundles (GET /api/learn/notebook-import). Each card imports
 *                 the notebook into a workspace Loom-native (the Loom notebook
 *                 editor), optionally seeding ADLS Delta sample data.
 *   • Samples   — the import-with-sample-data wizard: pick a scenario, it
 *                 provisions the sample (notebook + seeded lakehouse) and opens
 *                 it so you can try the use case immediately.
 *   • Tours     — the end-to-end tutorials and core-surface guides, rendered as
 *                 cards (Loom doc first, MS Learn secondary).
 *   • Guides    — the per-editor guides + reference docs (search/filter/sort,
 *                 tile|list).
 *
 * Real content end-to-end (no-vaporware.md): every install / import drives the
 * existing provisioning engine against Azure-native backends — Fabric is never
 * required (no-fabric-dependency.md). The Copilot streams from the existing
 * help-copilot backend and gates honestly when AOAI isn't wired.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Text, Badge, Dropdown, Option, Button,
  TabList, Tab, type SelectTabData,
  MessageBar, MessageBarBody, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BookOpen24Regular, Open16Regular, DocumentBulletList16Regular, ArrowDownload16Regular,
  NotebookAdd24Regular, Apps16Regular, SearchInfo24Regular,
  Grid24Regular, Notebook24Regular, Database24Regular, CompassNorthwest24Regular,
  BookStar24Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { LearnTopicCard } from '@/lib/components/learn/learn-topic-card';
import { InstallAppDialog } from '@/lib/components/apps/install-app-dialog';
import { getCoreSurfaceTutorials } from '@/lib/components/learn/core-surface-tutorials';
import { NotebookImportWizard } from '@/lib/learn/notebook-import-wizard';
import { NotebookGalleryCard, type NotebookSample } from '@/lib/components/learn/notebook-gallery-card';
import { LearningHubCopilot, type StarterPrompt } from '@/lib/components/learn/learning-hub-copilot';
import {
  getLearnCatalog, loomDocUrl, type LearnTopic,
} from '@/lib/learn/content';

type HubTab = 'gallery' | 'notebooks' | 'samples' | 'tours' | 'guides';
type SortKey = 'relevance' | 'title-asc' | 'title-desc';

const useStyles = makeStyles({
  // ── Hero ──────────────────────────────────────────────────────────────
  hero: {
    display: 'flex',
    gap: tokens.spacingHorizontalXL,
    alignItems: 'center',
    padding: tokens.spacingVerticalXXL,
    borderRadius: tokens.borderRadiusXLarge,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 70%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: tokens.spacingVerticalL,
    flexWrap: 'wrap',
  },
  heroIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '64px', height: '64px', borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, flexShrink: 0,
  },
  heroText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, flex: 1, minWidth: '240px' },
  heroTitle: {
    fontFamily: 'var(--loom-font-display)', fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeHero700, lineHeight: 1.1, margin: 0, letterSpacing: '-0.02em',
  },
  heroSub: { color: tokens.colorNeutralForeground2, maxWidth: '64ch', lineHeight: 1.5 },
  heroStats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  stat: { display: 'flex', flexDirection: 'column' },
  statNum: { fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase600, lineHeight: 1, color: tokens.colorNeutralForeground1 },
  statLbl: { color: tokens.colorNeutralForeground3 },

  // ── Layout: tabs + content on the left, Copilot rail on the right ───────
  tabs: { marginBottom: tokens.spacingVerticalL },
  layout: { display: 'flex', gap: tokens.spacingHorizontalXL, alignItems: 'flex-start' },
  main: { flex: 1, minWidth: 0 },
  rail: { width: '380px', flexShrink: 0, position: 'sticky', top: tokens.spacingVerticalL, '@media (max-width: 1100px)': { display: 'none' } },

  filters: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  drop: { minWidth: '160px' },

  groupSection: { marginBottom: tokens.spacingVerticalXXL },
  sectionHead: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: tokens.spacingVerticalS },
  sectionBlurb: { color: tokens.colorNeutralForeground3, lineHeight: 1.5 },
  rowCenter: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },

  // ── Samples band ────────────────────────────────────────────────────────
  band: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: `linear-gradient(135deg, ${tokens.colorNeutralBackground2} 0%, ${tokens.colorNeutralBackground1} 80%)`,
    marginBottom: tokens.spacingVerticalXL,
  },
  bandHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  bandIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '44px', height: '44px', borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2, flexShrink: 0,
  },
  bandText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: '240px' },
  bandTitle: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  bandSub: { color: tokens.colorNeutralForeground3, lineHeight: 1.5, maxWidth: '72ch' },

  // ── Mobile Copilot (below content when rail is hidden) ──────────────────
  mobileCopilot: { marginTop: tokens.spacingVerticalXXL, '@media (min-width: 1101px)': { display: 'none' } },

  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center', color: tokens.colorNeutralForeground3,
  },
  emptyIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '56px', height: '56px', borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalXS,
  },

  // ── List view (guides) ──────────────────────────────────────────────────
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  listRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, border: `1px solid ${tokens.colorNeutralStroke1}` },
  },
  listChip: {
    flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusLarge,
  },
  listChipIcon: { width: '22px', height: '22px' },
  listMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  listTitle: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listTitleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  listSummary: { color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listLinks: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexShrink: 0 },
  listPrimary: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300, textDecorationLine: 'none', ':hover': { textDecorationLine: 'underline' },
  },
  listSecondary: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },

  footer: { paddingTop: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3 },
});

function matches(t: LearnTopic, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    t.title.toLowerCase().includes(needle) ||
    (t.summary?.toLowerCase().includes(needle) ?? false) ||
    t.category.toLowerCase().includes(needle)
  );
}

/** Group topics by category, preserving first-seen order. */
function groupByCategory(rows: LearnTopic[]): Array<{ cat: string; rows: LearnTopic[] }> {
  const map = new Map<string, LearnTopic[]>();
  for (const t of rows) {
    const arr = map.get(t.category) ?? [];
    arr.push(t);
    map.set(t.category, arr);
  }
  return [...map.entries()].map(([cat, r]) => ({ cat, rows: r }));
}

export default function LearnPage(): React.ReactElement {
  const s = useStyles();

  // Full catalog: core-surface tutorials lead so "Loom doc first" links resolve.
  const all = React.useMemo(() => [...getCoreSurfaceTutorials(), ...getLearnCatalog()], []);

  // Split the catalog into the hub's sections.
  const useCases = React.useMemo(() => all.filter((t) => t.section === 'Use cases'), [all]);
  const tours = React.useMemo(() => all.filter((t) => t.section === 'Tutorials'), [all]);
  const guides = React.useMemo(() => all.filter((t) => t.section === 'Editor guides' || t.section === 'Service guides' || t.section === 'Reference'), [all]);
  const installableUseCases = React.useMemo(() => useCases.filter((t) => !!t.appId), [useCases]);

  // Real notebook samples from the app content bundles.
  const [notebooks, setNotebooks] = React.useState<NotebookSample[] | null>(null);
  const [nbErr, setNbErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch('/api/learn/notebook-import')
      .then((r) => r.json())
      .then((d: any) => {
        if (d?.ok) setNotebooks(d.notebooks || []);
        else setNbErr(d?.error || 'Could not load notebook samples.');
      })
      .catch((e) => setNbErr(e?.message || String(e)));
  }, []);

  const [tab, setTab] = React.useState<HubTab>('gallery');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState<string>('all');
  const [sort, setSort] = React.useState<SortKey>('relevance');
  const [view, setView] = React.useState<LoomView>('tile');
  const [installTopic, setInstallTopic] = React.useState<{ appId: string; title: string } | null>(null);

  // The set of topics the active tab filters over (gallery/tours/guides).
  const tabPool = tab === 'gallery' ? useCases : tab === 'tours' ? tours : guides;

  const categories = React.useMemo(
    () => Array.from(new Set(tabPool.map((t) => t.category))).sort(),
    [tabPool],
  );
  React.useEffect(() => { setCategory('all'); setQuery(''); }, [tab]);

  const filtered = React.useMemo(() => {
    let rows = tabPool.filter((t) => matches(t, query));
    if (category !== 'all') rows = rows.filter((t) => t.category === category);
    const byTitle = (a: LearnTopic, b: LearnTopic) => a.title.localeCompare(b.title);
    if (sort === 'title-asc') rows = [...rows].sort(byTitle);
    else if (sort === 'title-desc') rows = [...rows].sort((a, b) => byTitle(b, a));
    return rows;
  }, [tabPool, query, category, sort]);

  const grouped = React.useMemo(() => groupByCategory(filtered), [filtered]);

  // Filtered notebooks (Notebooks tab uses its own search).
  const filteredNotebooks = React.useMemo(() => {
    if (!notebooks) return [];
    const q = query.toLowerCase();
    return notebooks.filter((n) =>
      !q ||
      n.notebookDisplayName.toLowerCase().includes(q) ||
      n.bundleLabel.toLowerCase().includes(q) ||
      n.description.toLowerCase().includes(q),
    );
  }, [notebooks, query]);

  // Copilot starter prompts tied to the gallery — first few installable use cases.
  const starters = React.useMemo<StarterPrompt[]>(() => {
    const fromCases = installableUseCases.slice(0, 3).map((u) => ({
      label: `How do I use the "${u.title}" example?`,
      prompt: `I want to try the "${u.title}" use case in CSA Loom. What does it provision, and how do I work through it step by step?`,
    }));
    return [
      ...fromCases,
      { label: 'Which use case fits my goal?', prompt: 'Help me pick a Learning Hub use case for my goal and explain what it installs.' },
    ];
  }, [installableUseCases]);

  const showToolbar = tab === 'gallery' || tab === 'tours' || tab === 'guides' || tab === 'notebooks';

  return (
    <PageShell
      title="Learn"
      subtitle="A Knowledge Center for CSA Loom — install use-case examples, open notebooks, seed sample data, and learn with a guided Copilot."
    >
      {/* Hero */}
      <div className={s.hero}>
        <span className={s.heroIcon} aria-hidden><BookStar24Regular /></span>
        <div className={s.heroText}>
          <h1 className={s.heroTitle}>CSA Loom Learning Hub</h1>
          <Text className={s.heroSub}>
            Everything you need to learn Loom by doing — a gallery of installable use-case
            examples, the prebuilt notebook library, one-click sample-data scenarios, guided
            tours, and a Copilot that walks you through any of it. All Azure-native, no Fabric required.
          </Text>
          <div className={s.heroStats}>
            <span className={s.stat}>
              <span className={s.statNum}>{installableUseCases.length}</span>
              <Text size={200} className={s.statLbl}>installable use cases</Text>
            </span>
            <span className={s.stat}>
              <span className={s.statNum}>{notebooks?.length ?? '…'}</span>
              <Text size={200} className={s.statLbl}>notebook samples</Text>
            </span>
            <span className={s.stat}>
              <span className={s.statNum}>{tours.length}</span>
              <Text size={200} className={s.statLbl}>guided tours</Text>
            </span>
            <span className={s.stat}>
              <span className={s.statNum}>{guides.length}</span>
              <Text size={200} className={s.statLbl}>editor + reference guides</Text>
            </span>
          </div>
        </div>
      </div>

      {/* Section tabs */}
      <div className={s.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_, d: SelectTabData) => setTab(d.value as HubTab)}
          size="large"
        >
          <Tab value="gallery" icon={<Grid24Regular />}>Gallery</Tab>
          <Tab value="notebooks" icon={<Notebook24Regular />}>Notebooks</Tab>
          <Tab value="samples" icon={<Database24Regular />}>Datasets &amp; samples</Tab>
          <Tab value="tours" icon={<CompassNorthwest24Regular />}>Tours</Tab>
          <Tab value="guides" icon={<BookOpen24Regular />}>Guides &amp; reference</Tab>
        </TabList>
      </div>

      <div className={s.layout}>
        <div className={s.main}>
          {/* Search / filter toolbar (shared) */}
          {showToolbar && (
            <Toolbar
              search={query}
              onSearch={setQuery}
              searchPlaceholder={
                tab === 'notebooks' ? 'Search notebooks…'
                  : tab === 'gallery' ? 'Search use cases…'
                  : tab === 'tours' ? 'Search tours…'
                  : 'Search guides…'
              }
              actions={
                <div className={s.filters}>
                  {tab !== 'notebooks' && (
                    <Dropdown
                      className={s.drop}
                      aria-label="Filter by category"
                      value={category === 'all' ? 'All categories' : category}
                      selectedOptions={[category]}
                      onOptionSelect={(_, d) => setCategory((d.optionValue as string) ?? 'all')}
                    >
                      <Option value="all">All categories</Option>
                      {categories.map((c) => <Option key={c} value={c}>{c}</Option>)}
                    </Dropdown>
                  )}
                  {tab === 'guides' && (
                    <>
                      <Dropdown
                        className={s.drop}
                        aria-label="Sort"
                        value={sort === 'relevance' ? 'Suggested' : sort === 'title-asc' ? 'Title (A–Z)' : 'Title (Z–A)'}
                        selectedOptions={[sort]}
                        onOptionSelect={(_, d) => setSort((d.optionValue as SortKey) ?? 'relevance')}
                      >
                        <Option value="relevance">Suggested</Option>
                        <Option value="title-asc">Title (A–Z)</Option>
                        <Option value="title-desc">Title (Z–A)</Option>
                      </Dropdown>
                      <ViewToggle value={view} onChange={setView} />
                    </>
                  )}
                </div>
              }
            />
          )}

          {/* ── GALLERY: installable use-case walkthroughs, grouped by category ── */}
          {tab === 'gallery' && (
            <>
              {grouped.length === 0 && <EmptyState onClear={() => { setQuery(''); setCategory('all'); }} />}
              {grouped.map(({ cat, rows }) => (
                <section key={cat} className={s.groupSection}>
                  <div className={s.sectionHead}>
                    <div className={s.rowCenter}>
                      <Text size={500} weight="semibold">{cat}</Text>
                      <Badge appearance="tint" color="brand">{rows.length}</Badge>
                    </div>
                  </div>
                  <TileGrid minTileWidth={300}>
                    {rows.map((t) => <LearnTopicCard key={t.id} topic={t} />)}
                  </TileGrid>
                </section>
              ))}
            </>
          )}

          {/* ── NOTEBOOKS: prebuilt Spark/Databricks samples, import Loom-native ── */}
          {tab === 'notebooks' && (
            <>
              <div className={s.band}>
                <div className={s.bandHead}>
                  <span className={s.bandIcon} aria-hidden><NotebookAdd24Regular /></span>
                  <div className={s.bandText}>
                    <Text className={s.bandTitle}>Open any notebook in a workspace</Text>
                    <Text size={200} className={s.bandSub}>
                      Every card below imports a real, prebuilt Spark / Databricks notebook into a
                      workspace as a Loom-native notebook — optionally seeding the matching ADLS
                      Delta sample tables so it runs against real data on first open.
                    </Text>
                  </div>
                  <NotebookImportWizard />
                </div>
              </div>
              {notebooks === null && !nbErr && <Spinner label="Loading notebook samples…" />}
              {nbErr && <MessageBar intent="warning"><MessageBarBody>{nbErr}</MessageBarBody></MessageBar>}
              {notebooks && filteredNotebooks.length === 0 && <EmptyState onClear={() => setQuery('')} />}
              {filteredNotebooks.length > 0 && (
                <TileGrid minTileWidth={300}>
                  {filteredNotebooks.map((n) => (
                    <NotebookGalleryCard key={`${n.bundleId}::${n.notebookDisplayName}`} nb={n} />
                  ))}
                </TileGrid>
              )}
            </>
          )}

          {/* ── SAMPLES: import-with-sample-data wizard + the seedable scenarios ── */}
          {tab === 'samples' && (
            <>
              <div className={s.band}>
                <div className={s.bandHead}>
                  <span className={s.bandIcon} aria-hidden><Database24Regular /></span>
                  <div className={s.bandText}>
                    <Text className={s.bandTitle}>Try a scenario with sample data</Text>
                    <Text size={200} className={s.bandSub}>
                      Pick a prebuilt notebook and choose <strong>with sample data</strong> — the
                      wizard provisions the example (Synapse Spark / Databricks notebook) and seeds
                      the matching lakehouse tables as real ADLS Gen2 Delta files, then opens it so
                      you can run the use case immediately. Honest infra gate if no Synapse /
                      Databricks engine is wired — never a Fabric dependency.
                    </Text>
                  </div>
                  <NotebookImportWizard />
                </div>
              </div>

              <Section title="Scenarios that ship seedable sample data">
                {notebooks === null && !nbErr && <Spinner label="Loading scenarios…" />}
                {nbErr && <MessageBar intent="warning"><MessageBarBody>{nbErr}</MessageBarBody></MessageBar>}
                {notebooks && (
                  <TileGrid minTileWidth={300}>
                    {notebooks.filter((n) => n.hasSampleData).map((n) => (
                      <NotebookGalleryCard key={`sample::${n.bundleId}::${n.notebookDisplayName}`} nb={n} />
                    ))}
                  </TileGrid>
                )}
                {notebooks && notebooks.filter((n) => n.hasSampleData).length === 0 && (
                  <MessageBar intent="info">
                    <MessageBarBody>No bundles currently ship seedable sample tables.</MessageBarBody>
                  </MessageBar>
                )}
              </Section>

              <Text size={200} className={s.sectionBlurb}>
                Want a full reference environment instead of a single notebook? The{' '}
                <a className={s.listPrimary} onClick={() => setTab('gallery')} style={{ cursor: 'pointer' }}>Gallery</a>{' '}
                installs complete use-case apps (lakehouse + warehouse + KQL DB + dashboards + alerts) in one click.
              </Text>
            </>
          )}

          {/* ── TOURS: end-to-end tutorials + core-surface guides as cards ── */}
          {tab === 'tours' && (
            <>
              {grouped.length === 0 && <EmptyState onClear={() => { setQuery(''); setCategory('all'); }} />}
              {grouped.map(({ cat, rows }) => (
                <section key={cat} className={s.groupSection}>
                  <div className={s.sectionHead}>
                    <div className={s.rowCenter}>
                      <Text size={500} weight="semibold">{cat}</Text>
                      <Badge appearance="tint" color="brand">{rows.length}</Badge>
                    </div>
                  </div>
                  <TileGrid minTileWidth={300}>
                    {rows.map((t) => <LearnTopicCard key={t.id} topic={t} />)}
                  </TileGrid>
                </section>
              ))}
            </>
          )}

          {/* ── GUIDES & REFERENCE: per-editor guides + reference (tile|list) ── */}
          {tab === 'guides' && (
            <>
              {filtered.length === 0 && <EmptyState onClear={() => { setQuery(''); setCategory('all'); }} />}
              {filtered.length > 0 && view === 'tile' && grouped.map(({ cat, rows }) => (
                <section key={cat} className={s.groupSection}>
                  <div className={s.sectionHead}>
                    <div className={s.rowCenter}>
                      <Text size={500} weight="semibold">{cat}</Text>
                      <Badge appearance="tint" color="brand">{rows.length}</Badge>
                    </div>
                  </div>
                  <TileGrid minTileWidth={300}>
                    {rows.map((t) => <LearnTopicCard key={t.id} topic={t} />)}
                  </TileGrid>
                </section>
              ))}
              {filtered.length > 0 && view === 'list' && (
                <Section title={`${filtered.length} guides`}>
                  <div className={s.list}>
                    {filtered.map((t) => {
                      const visual = itemVisual(t.visualType);
                      const Icon = visual.icon;
                      return (
                        <div key={t.id} className={s.listRow}>
                          <span className={s.listChip} style={{ backgroundColor: `${visual.color}1f`, color: visual.color }} aria-hidden>
                            <Icon className={s.listChipIcon} style={{ color: visual.color }} />
                          </span>
                          <div className={s.listMain}>
                            <div className={s.listTitleRow}>
                              <Text className={s.listTitle} title={t.title}>{t.title}</Text>
                              {t.preview && <Badge size="small" appearance="tint" color="warning">Preview</Badge>}
                              {!t.hasLoomDoc && <Badge size="small" appearance="outline" color="informative">Loom guide coming</Badge>}
                            </div>
                            <Text size={200} className={s.listSummary} title={t.summary}>
                              {t.category}{t.summary ? ` · ${t.summary}` : ''}
                            </Text>
                          </div>
                          <div className={s.listLinks}>
                            <a className={s.listPrimary} href={t.primaryUrl} target="_blank" rel="noreferrer">
                              <DocumentBulletList16Regular />{t.primaryLabel}<Open16Regular />
                            </a>
                            {t.hasLoomDoc && t.msLearnUrl && (
                              <a className={s.listSecondary} href={t.msLearnUrl} target="_blank" rel="noreferrer">
                                MS Learn <Open16Regular />
                              </a>
                            )}
                            {t.appId && (
                              <Button size="small" appearance="primary" icon={<ArrowDownload16Regular />}
                                onClick={() => setInstallTopic({ appId: t.appId!, title: t.title })}>
                                Install live example
                              </Button>
                            )}
                            {t.appHref && (
                              <Link className={s.listSecondary} href={t.appHref}>
                                <Apps16Regular />{t.appLabel ?? 'Install app'}
                              </Link>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}
            </>
          )}

          {/* Footer */}
          <div className={s.footer}>
            <Text size={200}>
              Looking for the complete documentation?{' '}
              <a className={s.listPrimary} href={loomDocUrl('fiab/index')} target="_blank" rel="noreferrer">
                Open the CSA Loom docs site <Open16Regular />
              </a>
            </Text>
          </div>

          {/* Mobile Copilot (when the rail is hidden) */}
          <div className={s.mobileCopilot}>
            <LearningHubCopilot starters={starters} />
          </div>
        </div>

        {/* Copilot rail */}
        <aside className={s.rail} aria-label="Learning Hub Copilot">
          <LearningHubCopilot starters={starters} />
        </aside>
      </div>

      {/* Shared install wizard for the guides list-view "Install live example". */}
      {installTopic && (
        <InstallAppDialog
          appId={installTopic.appId}
          appName={installTopic.title}
          open={!!installTopic}
          onOpenChange={(o) => { if (!o) setInstallTopic(null); }}
        />
      )}
    </PageShell>
  );
}

/** Shared empty-state for a filtered section. */
function EmptyState({ onClear }: { onClear: () => void }): React.ReactElement {
  const s = useStyles();
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon} aria-hidden><SearchInfo24Regular /></span>
      <Text size={400} weight="semibold">Nothing matches your search</Text>
      <Text size={300}>Try a different keyword or clear the filters.</Text>
      <Button appearance="secondary" onClick={onClear}>Clear filters</Button>
    </div>
  );
}

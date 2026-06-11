'use client';

/**
 * /learn — the CSA Loom Learn library.
 *
 * A modern, searchable, filterable portal over every Learn topic in
 * `lib/learn/content.ts`: the 8 end-to-end tutorials, ~90 per-editor guides,
 * the Loom engine service guides, and the reference/concept docs.
 *
 * Dual-link model (per the operator's link-strategy ask):
 *   • PRIMARY link  → the project's own CSA Loom doc (MkDocs pages site).
 *   • SECONDARY link → Microsoft Learn / service docs.
 * Where a Loom doc doesn't exist yet, the card shows the MS-Learn link plus a
 * "Loom guide coming" badge — never a fabricated dead link.
 *
 * Real search / filter / sort (all client-side over the real catalog), a
 * Tile|List ViewToggle, rich cards with icon + brand color + published
 * tutorial thumbnails, and grouped sections (Tutorials / Editor guides /
 * Service guides / Reference). No mock content.
 */

import * as React from 'react';
import {
  Text, Badge, Dropdown, Option, Button, makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  BookOpen24Regular, Open16Regular, DocumentBulletList16Regular, ArrowDownload16Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ViewToggle, type LoomView } from '@/lib/components/ui/view-toggle';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { LearnTopicCard } from '@/lib/components/learn/learn-topic-card';
import { InstallAppDialog } from '@/lib/components/apps/install-app-dialog';
import { getCoreSurfaceTutorials } from '@/lib/components/learn/core-surface-tutorials';
import {
  getLearnCatalog, loomDocUrl, type LearnTopic, type LearnSection,
} from '@/lib/learn/content';

const SECTION_ORDER: LearnSection[] = ['Tutorials', 'Use cases', 'Editor guides', 'Service guides', 'Reference'];
const SECTION_BLURB: Record<LearnSection, string> = {
  'Tutorials': 'End-to-end walkthroughs that take you from an empty workspace to a working scenario.',
  'Use cases': 'Real-world reference scenarios — government, healthcare, gaming, cyber, API-first — built on CSA Loom (Azure-native, never Fabric).',
  'Editor guides': 'One guide per item type — every Azure / Fabric editor Loom builds, with full feature parity.',
  'Service guides': 'How the Loom engines work under the hood (Activator, Mirroring, Direct-Lake).',
  'Reference': 'Architecture, parity, and orientation docs for the platform as a whole.',
};

type SortKey = 'relevance' | 'title-asc' | 'title-desc' | 'section';

const useStyles = makeStyles({
  hero: {
    display: 'flex',
    gap: tokens.spacingHorizontalXL,
    alignItems: 'center',
    padding: tokens.spacingVerticalXXL,
    borderRadius: tokens.borderRadiusXLarge,
    background: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 70%)`,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: tokens.spacingVerticalXXL,
    flexWrap: 'wrap',
  },
  heroIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '64px',
    height: '64px',
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    flexShrink: 0,
  },
  heroText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, flex: 1, minWidth: '240px' },
  heroTitle: {
    fontFamily: 'var(--loom-font-display)',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeHero700,
    lineHeight: 1.1,
    margin: 0,
    letterSpacing: '-0.02em',
  },
  heroSub: { color: tokens.colorNeutralForeground2, maxWidth: '60ch', lineHeight: 1.5 },
  heroStats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  stat: { display: 'flex', flexDirection: 'column' },
  statNum: { fontWeight: tokens.fontWeightBold, fontSize: tokens.fontSizeBase600, lineHeight: 1, color: tokens.colorNeutralForeground1 },
  statLbl: { color: tokens.colorNeutralForeground3 },

  filters: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  drop: { minWidth: '150px' },

  sectionHead: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: tokens.spacingVerticalS },
  sectionBlurb: { color: tokens.colorNeutralForeground3, lineHeight: 1.5 },

  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },

  // list view
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionDuration: tokens.durationFaster,
    transitionProperty: 'background-color, border-color',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, border: `1px solid ${tokens.colorNeutralStroke1}` },
  },
  listChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusLarge,
  },
  listMain: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  listTitle: { fontWeight: tokens.fontWeightSemibold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listSummary: { color: tokens.colorNeutralForeground3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  listLinks: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexShrink: 0 },
  listPrimary: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300, textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  listSecondary: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200,
    textDecorationLine: 'none', ':hover': { textDecorationLine: 'underline' },
  },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

function matches(t: LearnTopic, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    t.title.toLowerCase().includes(needle) ||
    (t.summary?.toLowerCase().includes(needle) ?? false) ||
    t.category.toLowerCase().includes(needle) ||
    t.section.toLowerCase().includes(needle)
  );
}

export default function LearnPage(): React.ReactElement {
  const s = useStyles();
  // The hand-authored core-surface tutorials (docs/fiab/learn/*) lead the
  // catalog so the portal's "Loom doc first" links resolve to them, not a 404.
  const all = React.useMemo(
    () => [...getCoreSurfaceTutorials(), ...getLearnCatalog()],
    [],
  );

  const [query, setQuery] = React.useState('');
  const [section, setSection] = React.useState<'all' | LearnSection>('all');
  const [category, setCategory] = React.useState<string>('all');
  const [sort, setSort] = React.useState<SortKey>('relevance');
  const [view, setView] = React.useState<LoomView>('tile');
  // List-view "Install live example" → opens the shared wizard for one app.
  const [installTopic, setInstallTopic] = React.useState<{ appId: string; title: string } | null>(null);

  // Category options depend on the selected section (so the list stays sane).
  const categories = React.useMemo(() => {
    const pool = section === 'all' ? all : all.filter((t) => t.section === section);
    return Array.from(new Set(pool.map((t) => t.category))).sort();
  }, [all, section]);

  const filtered = React.useMemo(() => {
    let rows = all.filter((t) => matches(t, query));
    if (section !== 'all') rows = rows.filter((t) => t.section === section);
    if (category !== 'all') rows = rows.filter((t) => t.category === category);

    const byTitle = (a: LearnTopic, b: LearnTopic) => a.title.localeCompare(b.title);
    switch (sort) {
      case 'title-asc': rows = [...rows].sort(byTitle); break;
      case 'title-desc': rows = [...rows].sort((a, b) => byTitle(b, a)); break;
      case 'section':
        rows = [...rows].sort(
          (a, b) =>
            SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) ||
            a.category.localeCompare(b.category) ||
            byTitle(a, b),
        );
        break;
      default: break; // relevance = catalog/source order
    }
    return rows;
  }, [all, query, section, category, sort]);

  // Group the filtered rows by section for the grouped tile layout.
  const grouped = React.useMemo(() => {
    const map = new Map<LearnSection, LearnTopic[]>();
    for (const t of filtered) {
      const arr = map.get(t.section) ?? [];
      arr.push(t);
      map.set(t.section, arr);
    }
    return SECTION_ORDER.filter((sec) => map.has(sec)).map((sec) => ({ sec, rows: map.get(sec)! }));
  }, [filtered]);

  const missing = all.filter((t) => !t.hasLoomDoc).length;

  // Reset category when section changes and the old category no longer applies.
  React.useEffect(() => {
    if (category !== 'all' && !categories.includes(category)) setCategory('all');
  }, [categories, category]);

  return (
    <PageShell
      title="Learn"
      subtitle="Tutorials, per-editor guides, and reference docs — every link goes to the CSA Loom docs first."
    >
      {/* Hero */}
      <div className={s.hero}>
        <span className={s.heroIcon} aria-hidden><BookOpen24Regular /></span>
        <div className={s.heroText}>
          <h1 className={s.heroTitle}>CSA Loom Learn library</h1>
          <Text className={s.heroSub}>
            Hands-on walkthroughs and one guide for every Azure / Fabric editor Loom
            ships. Each topic links to the CSA Loom docs first, with Microsoft Learn a
            click away. The same guidance powers the in-editor "Learn about this item" drawer.
          </Text>
          <div className={s.heroStats}>
            <span className={s.stat}>
              <span className={s.statNum}>{all.length}</span>
              <Text size={200} className={s.statLbl}>topics</Text>
            </span>
            <span className={s.stat}>
              <span className={s.statNum}>{all.filter((t) => t.section === 'Editor guides').length}</span>
              <Text size={200} className={s.statLbl}>editor guides</Text>
            </span>
            <span className={s.stat}>
              <span className={s.statNum}>{all.filter((t) => t.section === 'Tutorials').length}</span>
              <Text size={200} className={s.statLbl}>tutorials</Text>
            </span>
            <span className={s.stat}>
              <span className={s.statNum}>{all.length - missing}</span>
              <Text size={200} className={s.statLbl}>Loom guides live</Text>
            </span>
          </div>
        </div>
      </div>

      {/* Controls */}
      <Toolbar
        search={query}
        onSearch={setQuery}
        searchPlaceholder="Search topics…"
        actions={
          <div className={s.filters}>
            <Dropdown
              className={s.drop}
              aria-label="Filter by section"
              value={section === 'all' ? 'All sections' : section}
              selectedOptions={[section]}
              onOptionSelect={(_, d) => setSection((d.optionValue as 'all' | LearnSection) ?? 'all')}
            >
              <Option value="all">All sections</Option>
              {SECTION_ORDER.map((sec) => (
                <Option key={sec} value={sec}>{sec}</Option>
              ))}
            </Dropdown>
            <Dropdown
              className={s.drop}
              aria-label="Filter by category"
              value={category === 'all' ? 'All categories' : category}
              selectedOptions={[category]}
              onOptionSelect={(_, d) => setCategory((d.optionValue as string) ?? 'all')}
            >
              <Option value="all">All categories</Option>
              {categories.map((c) => (
                <Option key={c} value={c}>{c}</Option>
              ))}
            </Dropdown>
            <Dropdown
              className={s.drop}
              aria-label="Sort topics"
              value={
                sort === 'relevance' ? 'Suggested'
                  : sort === 'title-asc' ? 'Title (A–Z)'
                  : sort === 'title-desc' ? 'Title (Z–A)'
                  : 'By section'
              }
              selectedOptions={[sort]}
              onOptionSelect={(_, d) => setSort((d.optionValue as SortKey) ?? 'relevance')}
            >
              <Option value="relevance">Suggested</Option>
              <Option value="title-asc">Title (A–Z)</Option>
              <Option value="title-desc">Title (Z–A)</Option>
              <Option value="section">By section</Option>
            </Dropdown>
            <ViewToggle value={view} onChange={setView} />
          </div>
        }
      />

      {filtered.length === 0 && (
        <Section bare>
          <div className={s.empty}>
            <Text size={400}>No topics match your search.</Text>
            <br />
            <Text size={300}>Try a different keyword or clear the filters.</Text>
          </div>
        </Section>
      )}

      {/* Grouped sections (tile view) or a single flat list (list view) */}
      {filtered.length > 0 && view === 'tile' && grouped.map(({ sec, rows }) => (
        <section key={sec} style={{ marginBottom: tokens.spacingVerticalXXL }}>
          <div className={s.sectionHead}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text size={500} weight="semibold">{sec}</Text>
              <Badge appearance="tint" color="brand">{rows.length}</Badge>
            </div>
            <Text size={200} className={s.sectionBlurb}>{SECTION_BLURB[sec]}</Text>
          </div>
          <TileGrid minTileWidth={300}>
            {rows.map((t) => <LearnTopicCard key={t.id} topic={t} />)}
          </TileGrid>
        </section>
      ))}

      {filtered.length > 0 && view === 'list' && (
        <Section title={`${filtered.length} topics`}>
          <div className={s.list}>
            {filtered.map((t) => {
              const visual = itemVisual(t.visualType);
              const Icon = visual.icon;
              return (
                <div key={t.id} className={s.listRow}>
                  <span
                    className={s.listChip}
                    style={{ backgroundColor: `${visual.color}1f`, color: visual.color }}
                    aria-hidden
                  >
                    <Icon style={{ width: 22, height: 22, color: visual.color }} />
                  </span>
                  <div className={s.listMain}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <Text className={s.listTitle} title={t.title}>{t.title}</Text>
                      {t.preview && <Badge size="small" appearance="tint" color="warning">Preview</Badge>}
                      {!t.hasLoomDoc && (
                        <Badge size="small" appearance="outline" color="informative">Loom guide coming</Badge>
                      )}
                    </div>
                    <Text size={200} className={s.listSummary} title={t.summary}>
                      {t.category}{t.summary ? ` · ${t.summary}` : ''}
                    </Text>
                  </div>
                  <div className={s.listLinks}>
                    <a className={s.listPrimary} href={t.primaryUrl} target="_blank" rel="noreferrer">
                      <DocumentBulletList16Regular />
                      {t.primaryLabel}
                      <Open16Regular />
                    </a>
                    {t.hasLoomDoc && t.msLearnUrl && (
                      <a className={s.listSecondary} href={t.msLearnUrl} target="_blank" rel="noreferrer">
                        MS Learn <Open16Regular />
                      </a>
                    )}
                    {t.appId && (
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<ArrowDownload16Regular />}
                        onClick={() => setInstallTopic({ appId: t.appId!, title: t.title })}
                      >
                        Install live example
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Footer: link to the full docs site */}
      <div style={{ paddingTop: tokens.spacingVerticalL, color: tokens.colorNeutralForeground3 }}>
        <Text size={200}>
          Looking for the complete documentation?{' '}
          <a
            className={mergeClasses(s.listPrimary)}
            style={{ display: 'inline-flex' }}
            href={loomDocUrl('fiab/index')}
            target="_blank"
            rel="noreferrer"
          >
            Open the CSA Loom docs site <Open16Regular />
          </a>
        </Text>
      </div>

      {/* Shared install wizard for the list-view "Install live example" action.
          (Tile view renders its own per-card dialog inside LearnTopicCard.) */}
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

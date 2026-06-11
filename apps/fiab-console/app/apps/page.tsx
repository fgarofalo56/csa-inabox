'use client';

/**
 * /apps — top-level Apps page. Lists every curated CSA app from
 * /api/apps-catalog (Cosmos apps-catalog container, partitioned by
 * tenantId = session.claims.oid). Each card links to /apps/[id].
 *
 * Polished card layout mirrors /workloads:
 *   - per-card iconBox (40x40, brand/purple/green by category)
 *   - section grouping by category with count badge
 *   - 4-zone card: header (icon + name + bundle badge) → description
 *     → item-type pills → footer (category badge + Install button)
 *   - hover lift (translate -2px + shadow8 + brandStroke1 border)
 */

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Input, Badge, Button, Caption1, Subtitle2, Tooltip,
} from '@fluentui/react-components';
import {
  Database24Regular, DataLine24Regular, Flow24Regular, Bot24Regular,
  ServerRegular, ChartMultiple24Regular, Earth24Regular,
  Shield24Regular, Diversity24Regular, Code24Regular, Cloud24Regular,
  AppGeneric24Regular, Search24Regular, PuzzlePieceRegular,
  Sparkle24Regular, ArrowDownload20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface AppItemRef { type: string; template?: string; displayName?: string; }
interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
  items?: AppItemRef[];
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24,
    paddingBottom: 16, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  toolbarSpacer: { flex: 1 },
  section: { marginBottom: 32 },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12,
    paddingBottom: 8, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sectionTitle: {
    fontSize: 16, fontWeight: 600, color: tokens.colorNeutralForeground1,
  },
  sectionCount: {
    color: tokens.colorNeutralForeground3, fontSize: 13,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 16,
  },
  card: {
    paddingTop: 18, paddingRight: 18, paddingBottom: 18, paddingLeft: 18,
    borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
    display: 'flex', flexDirection: 'column', gap: 10,
    minHeight: 200,
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardHeader: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  iconBox: {
    width: 40, height: 40, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    color: tokens.colorBrandForeground1,
    backgroundColor: tokens.colorBrandBackground2,
  },
  iconBoxAi: {
    color: tokens.colorPalettePurpleForeground2,
    backgroundColor: tokens.colorPalettePurpleBackground2,
  },
  iconBoxData: {
    color: tokens.colorPaletteGreenForeground2,
    backgroundColor: tokens.colorPaletteGreenBackground2,
  },
  iconBoxIndustry: {
    color: tokens.colorPaletteMarigoldForeground2,
    backgroundColor: tokens.colorPaletteMarigoldBackground2,
  },
  iconBoxSecurity: {
    color: tokens.colorPaletteRedForeground2,
    backgroundColor: tokens.colorPaletteRedBackground2,
  },
  titleCol: {
    display: 'flex', flexDirection: 'column', gap: 4,
    minWidth: 0, flex: 1,
  },
  name: {
    fontSize: 15, fontWeight: 600, color: tokens.colorNeutralForeground1,
    lineHeight: 1.3,
  },
  bundleBadge: { alignSelf: 'flex-start' },
  desc: {
    fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.5,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
    flex: 1,
  },
  pills: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  pill: {
    fontSize: 11, padding: '2px 8px', borderRadius: 999,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, marginTop: 4,
    paddingTop: 10, borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  empty: {
    padding: 32, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center', lineHeight: 1.5,
  },
});

/** Pick an icon based on app id / name / category. */
function appIcon(id: string, name: string, category?: string): React.ReactNode {
  const key = (id + ' ' + name + ' ' + (category ?? '')).toLowerCase();
  if (key.includes('copilot') || key.includes('agent') || key.includes('chatbot')) return <Bot24Regular />;
  if (key.includes('ai') || key.includes('ml') || key.includes('genai')) return <Sparkle24Regular />;
  if (key.includes('warehouse') || key.includes('sql') || key.includes('lakehouse')) return <Database24Regular />;
  if (key.includes('realtime') || key.includes('streaming') || key.includes('event')) return <DataLine24Regular />;
  if (key.includes('pipeline') || key.includes('factory') || key.includes('ingest')) return <Flow24Regular />;
  if (key.includes('database') || key.includes('cosmos')) return <ServerRegular />;
  if (key.includes('bi') || key.includes('report') || key.includes('dashboard')) return <ChartMultiple24Regular />;
  if (key.includes('geo') || key.includes('map') || key.includes('spatial')) return <Earth24Regular />;
  if (key.includes('fedramp') || key.includes('compliance') || key.includes('security') || key.includes('audit')) return <Shield24Regular />;
  if (key.includes('industry') || key.includes('retail') || key.includes('healthcare') || key.includes('finance')) return <Diversity24Regular />;
  if (key.includes('graph') || key.includes('vector') || key.includes('search')) return <PuzzlePieceRegular />;
  if (key.includes('code') || key.includes('dev')) return <Code24Regular />;
  if (key.includes('platform') || key.includes('cloud')) return <Cloud24Regular />;
  return <AppGeneric24Regular />;
}

/** Map app category to an icon-box color treatment. */
function iconBoxTone(category?: string): 'ai' | 'data' | 'industry' | 'security' | 'brand' {
  const key = (category ?? '').toLowerCase();
  if (key.includes('ai') || key.includes('agent') || key.includes('copilot') || key.includes('ml')) return 'ai';
  if (key.includes('data') || key.includes('analytics') || key.includes('warehouse') || key.includes('lakehouse') || key.includes('engineering')) return 'data';
  if (key.includes('industry') || key.includes('retail') || key.includes('healthcare') || key.includes('finance') || key.includes('public')) return 'industry';
  if (key.includes('security') || key.includes('compliance') || key.includes('governance') || key.includes('fedramp')) return 'security';
  return 'brand';
}

/** Friendly label for the item-type pills (e.g. "synapse-dedicated-sql-pool" → "synapse dedicated sql pool"). */
function pillLabel(s: string): string {
  return s.replace(/-/g, ' ');
}

interface Section { label: string; items: AppDoc[]; }

/** Bucket apps by category, with deterministic section ordering. */
function bucket(apps: AppDoc[]): Section[] {
  const byCat = new Map<string, AppDoc[]>();
  for (const a of apps) {
    const cat = a.category?.trim() || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(a);
  }
  // Deterministic alpha order; force "Other" last.
  const labels = Array.from(byCat.keys()).sort((x, y) => {
    if (x === 'Other') return 1;
    if (y === 'Other') return -1;
    return x.localeCompare(y);
  });
  return labels.map((label) => ({ label, items: byCat.get(label)! }));
}

export default function AppsPage() {
  const s = useStyles();
  const router = useRouter();
  const [apps, setApps] = useState<AppDoc[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    clientFetch('/api/apps-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setApps([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setApps(Array.isArray(d?.apps) ? d.apps : []);
    }).catch(() => setApps([]));
  }, []);

  const filter = q.toLowerCase().trim();
  const visible = useMemo(() => (apps ?? []).filter(a =>
    !filter || a.name.toLowerCase().includes(filter) ||
    (a.description ?? '').toLowerCase().includes(filter) ||
    (a.category ?? '').toLowerCase().includes(filter) ||
    (a.items ?? []).some(i => i.type.toLowerCase().includes(filter))
  ), [apps, filter]);

  const sections = useMemo(() => bucket(visible), [visible]);

  const totalCount = (apps ?? []).length;
  const shownCount = visible.length;

  function openApp(a: AppDoc) {
    router.push(`/apps/${a.id}`);
  }

  return (
    <PageShell
      title="Apps"
      subtitle="Curated CSA solutions that bundle items, dashboards, and pipelines into one click."
    >
      {unauth && <SignInRequired subject="the apps catalog" />}

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Filter by name, category, or bundled item type…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 480 }}
        />
        <div className={s.toolbarSpacer} />
        {apps !== null && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {filter ? `${shownCount} of ${totalCount} apps` : `${totalCount} apps`}
          </Caption1>
        )}
      </div>

      {apps === null && <Spinner label="Loading apps…" />}

      {apps !== null && apps.length === 0 && (
        <div className={s.empty}>
          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>No apps in this tenant yet</Subtitle2>
          <div>
            Run <code>scripts/csa-loom/seed-catalogs.sh</code> to seed the 10 curated CSA apps.
          </div>
          <div style={{ marginTop: 4 }}>
            First sign-in also triggers a copy from the GLOBAL seed.
          </div>
        </div>
      )}

      {apps !== null && apps.length > 0 && shownCount === 0 && (
        <div className={s.empty}>No apps match &ldquo;{q}&rdquo;.</div>
      )}

      {sections.map((section) => (
        <div key={section.label} className={s.section}>
          <div className={s.sectionHeader}>
            <div className={s.sectionTitle}>{section.label}</div>
            <Caption1 className={s.sectionCount}>· {section.items.length}</Caption1>
          </div>
          <div className={s.grid}>
            {section.items.map((a) => {
              const tone = iconBoxTone(a.category);
              const iconClass =
                tone === 'ai' ? `${s.iconBox} ${s.iconBoxAi}` :
                tone === 'data' ? `${s.iconBox} ${s.iconBoxData}` :
                tone === 'industry' ? `${s.iconBox} ${s.iconBoxIndustry}` :
                tone === 'security' ? `${s.iconBox} ${s.iconBoxSecurity}` :
                s.iconBox;
              const bundleCount = a.items?.length ?? 0;
              const itemTypes = Array.from(new Set((a.items ?? []).map(i => i.type)));
              return (
                <div
                  key={a.id}
                  className={s.card}
                  role="button"
                  tabIndex={0}
                  onClick={() => openApp(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openApp(a);
                    }
                  }}
                >
                  <div className={s.cardHeader}>
                    <div className={iconClass}>{appIcon(a.id, a.name, a.category)}</div>
                    <div className={s.titleCol}>
                      <div className={s.name}>{a.name}</div>
                      {bundleCount > 0 && (
                        <Badge
                          appearance="outline"
                          color="informative"
                          size="small"
                          className={s.bundleBadge}
                        >
                          Bundle of {bundleCount} item{bundleCount === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {a.description && <div className={s.desc}>{a.description}</div>}

                  {itemTypes.length > 0 && (
                    <div className={s.pills}>
                      {itemTypes.slice(0, 4).map(t => (
                        <span key={t} className={s.pill}>{pillLabel(t)}</span>
                      ))}
                      {itemTypes.length > 4 && (
                        <Tooltip
                          content={itemTypes.slice(4).map(pillLabel).join(', ')}
                          relationship="description"
                        >
                          <span className={s.pill}>+{itemTypes.length - 4} more</span>
                        </Tooltip>
                      )}
                    </div>
                  )}

                  <div className={s.footer}>
                    <Badge appearance="tint" color="brand" size="small">
                      {a.category ?? 'App'}
                    </Badge>
                    <Button
                      appearance="primary"
                      size="small"
                      icon={<ArrowDownload20Regular />}
                      onClick={(e) => {
                        // Defer to the detail page where the workspace
                        // picker + install POST live.
                        e.stopPropagation();
                        openApp(a);
                      }}
                    >
                      Install
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </PageShell>
  );
}

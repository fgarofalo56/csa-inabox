'use client';

/**
 * /workloads — Fabric-parity Workloads page. Lists the per-tenant
 * workloads catalog from /api/workloads-catalog. Workloads bundle
 * related item types (e.g. Data Engineering = Synapse + ADF + Spark)
 * and define what a workspace can contain.
 *
 * Layout mirrors Fabric's "More workloads" hub:
 *   - hero header with count + filter
 *   - sectioned by category (Included → CSA → Optional)
 *   - per-workload card has icon + name + description + capability pills
 *   - hover lifts the card; "Add to workspace" / "Manage" actions land in v3
 */

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Badge, Input, Button, Caption1, Subtitle2, Tooltip,
} from '@fluentui/react-components';
import { Search24Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { matchWorkloadKey } from '@/lib/catalog/workload-hub';

interface Workload {
  id: string; name: string; description?: string;
  category?: string; included?: boolean;
  featureSlugs?: string[];
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
    gap: 14,
  },
  card: {
    padding: 16, borderRadius: 8,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
    display: 'flex', flexDirection: 'column', gap: 8,
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
  iconBoxCsa: {
    color: tokens.colorPalettePurpleForeground2,
    backgroundColor: tokens.colorPalettePurpleBackground2,
  },
  iconBoxOptional: {
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  titleCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  name: { fontSize: 15, fontWeight: 600, color: tokens.colorNeutralForeground1 },
  desc: {
    fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.45,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
  },
  features: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 },
  pill: {
    fontSize: 11, padding: '2px 8px', borderRadius: 999,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  empty: {
    padding: 32, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center',
  },
});

/** Representative item-type slug for a workload — its first featureSlug, which
 *  the catalog seed always sets to a real item-type slug. itemVisual() resolves
 *  it to a Fluent icon + brand color from the shared registry. */
function workloadTypeSlug(w: Workload): string {
  return (w.featureSlugs || [])[0] || 'data-product';
}

interface Section { label: string; tone: 'included' | 'csa' | 'optional'; items: Workload[]; }

/** Bucket workloads by category for the section view. */
function bucket(workloads: Workload[]): Section[] {
  const included: Workload[] = [];
  const csa: Workload[] = [];
  const optional: Workload[] = [];
  for (const w of workloads) {
    if (w.category === 'CSA') csa.push(w);
    else if (w.included) included.push(w);
    else optional.push(w);
  }
  const sections: Section[] = [];
  if (included.length) sections.push({ label: 'Included with Loom', tone: 'included', items: included });
  if (csa.length) sections.push({ label: 'CSA accelerators', tone: 'csa', items: csa });
  if (optional.length) sections.push({ label: 'Optional add-ons', tone: 'optional', items: optional });
  return sections;
}

export default function WorkloadsPage() {
  const s = useStyles();
  const router = useRouter();
  const [items, setItems] = useState<Workload[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    clientFetch('/api/workloads-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setItems(Array.isArray(d?.workloads) ? d.workloads : []);
    }).catch(() => setItems([]));
  }, []);

  const filter = q.toLowerCase().trim();
  const visible = useMemo(() => (items ?? []).filter(w =>
    !filter || w.name.toLowerCase().includes(filter) ||
    (w.description ?? '').toLowerCase().includes(filter) ||
    (w.category ?? '').toLowerCase().includes(filter) ||
    (w.featureSlugs || []).some(f => f.toLowerCase().includes(filter))
  ), [items, filter]);

  const sections = useMemo(() => bucket(visible), [visible]);

  const totalCount = (items ?? []).length;
  const shownCount = visible.length;

  function openWorkload(w: Workload) {
    // Expand into the workload's landing page (its item types) when we can
    // resolve it to a registry workload group; otherwise fall back to the
    // first feature's create wizard.
    const key = matchWorkloadKey(w.name, w.featureSlugs || []);
    if (key) { router.push(`/workload-hub/${key}`); return; }
    const first = (w.featureSlugs || [])[0];
    if (first) router.push(`/items/${first}/new`);
  }

  return (
    <PageShell
      title="Workloads"
      subtitle="Each workload bundles the item types that solve a problem together. Click any workload to start building."
    >
      {unauth && <SignInRequired subject="workloads" />}

      <div className={s.toolbar}>
        <Input
          contentBefore={<Search24Regular />}
          placeholder="Filter by name, capability, or category…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
          style={{ flex: 1, maxWidth: 480 }}
        />
        <div className={s.toolbarSpacer} />
        {items !== null && (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {filter ? `${shownCount} of ${totalCount} workloads` : `${totalCount} workloads`}
          </Caption1>
        )}
      </div>

      {items === null && <Spinner label="Loading workloads…" />}

      {items !== null && items.length === 0 && (
        <div className={s.empty}>
          <Subtitle2 style={{ display: 'block', marginBottom: 8 }}>No workloads in this tenant yet</Subtitle2>
          <div>POST <code>/api/admin/bootstrap-catalogs</code> once per environment to seed GLOBAL.</div>
          <div style={{ marginTop: 4 }}>First <code>/api/workloads-catalog</code> GET copies into your tenant automatically.</div>
        </div>
      )}

      {items !== null && items.length > 0 && shownCount === 0 && (
        <div className={s.empty}>No workloads match &ldquo;{q}&rdquo;.</div>
      )}

      {sections.map((section) => (
        <div key={section.label} className={s.section}>
          <div className={s.sectionHeader}>
            <div className={s.sectionTitle}>{section.label}</div>
            <Caption1 className={s.sectionCount}>· {section.items.length}</Caption1>
          </div>
          <div className={s.grid}>
            {section.items.map((w) => {
              const iconClass =
                section.tone === 'csa' ? s.iconBoxCsa :
                section.tone === 'optional' ? s.iconBoxOptional :
                s.iconBox;
              return (
                <div
                  key={w.id}
                  className={s.card}
                  role="button"
                  tabIndex={0}
                  onClick={() => openWorkload(w)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkload(w); } }}
                >
                  <div className={s.cardHeader}>
                    {(() => {
                      const v = itemVisual(workloadTypeSlug(w));
                      return (
                        <div
                          className={iconClass}
                          style={{ backgroundColor: `${v.color}1f`, color: v.color }}
                          aria-hidden
                        >
                          <v.icon style={{ width: 24, height: 24, color: v.color }} />
                        </div>
                      );
                    })()}
                    <div className={s.titleCol}>
                      <div className={s.name}>{w.name}</div>
                      <Badge
                        appearance={section.tone === 'included' ? 'filled' : 'outline'}
                        color={section.tone === 'csa' ? 'brand' : section.tone === 'included' ? 'success' : 'informative'}
                        size="small"
                        style={{ alignSelf: 'flex-start' }}
                      >
                        {section.tone === 'csa' ? 'CSA' : section.tone === 'included' ? 'Included' : 'Optional'}
                      </Badge>
                    </div>
                  </div>
                  {w.description && <div className={s.desc}>{w.description}</div>}
                  {w.featureSlugs && w.featureSlugs.length > 0 && (
                    <div className={s.features}>
                      {w.featureSlugs.slice(0, 6).map(f => (
                        <span key={f} className={s.pill}>{f.replace(/-/g, ' ')}</span>
                      ))}
                      {w.featureSlugs.length > 6 && (
                        <Tooltip
                          content={w.featureSlugs.slice(6).map(f => f.replace(/-/g, ' ')).join(', ')}
                          relationship="description"
                        >
                          <span className={s.pill}>+{w.featureSlugs.length - 6} more</span>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </PageShell>
  );
}

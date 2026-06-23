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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Badge, Input, Button, Caption1, Subtitle2, Tooltip,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Textarea, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import { Search24Regular, Add24Regular, Delete20Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { matchWorkloadKey } from '@/lib/catalog/workload-hub';

interface Workload {
  id: string; name: string; description?: string;
  category?: string; included?: boolean;
  featureSlugs?: string[];
  createdBy?: string;
}

/** A tenant-authored custom workload (vs a seeded GLOBAL → tenant copy). */
function isCustom(w: Workload): boolean {
  return !!w.createdBy || w.category === 'Org';
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  toolbarSpacer: { flex: 1 },
  section: { marginBottom: '32px' },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase400, fontWeight: 600, color: tokens.colorNeutralForeground1,
  },
  sectionCount: {
    color: tokens.colorNeutralForeground3, fontSize: '13px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '14px',
  },
  card: {
    padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS,
    ':hover': {
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
      borderColor: tokens.colorBrandStroke1,
    },
  },
  cardHeader: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM },
  cardActions: { position: 'absolute', top: tokens.spacingVerticalS, right: tokens.spacingHorizontalS },
  cardRel: { position: 'relative' },
  dialogCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, minWidth: '440px' },
  iconBox: {
    width: '40px', height: '40px', borderRadius: tokens.borderRadiusXLarge,
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
  titleCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXXS, minWidth: 0, flex: 1 },
  name: { fontSize: '15px', fontWeight: 600, color: tokens.colorNeutralForeground1 },
  desc: {
    fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.45,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
  },
  features: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', marginTop: tokens.spacingVerticalXS },
  pill: {
    fontSize: '11px', padding: '2px 8px', borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  empty: {
    padding: '32px', borderRadius: '10px',
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: '13px', textAlign: 'center',
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
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(() => {
    return clientFetch('/api/workloads-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setItems(Array.isArray(d?.workloads) ? d.workloads : []);
    }).catch(() => setItems([]));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const removeWorkload = useCallback(async (w: Workload) => {
    if (!confirm(`Remove the custom workload "${w.name}" from this tenant's catalog?`)) return;
    setDeletingId(w.id);
    try {
      const r = await clientFetch(`/api/workloads-catalog?id=${encodeURIComponent(w.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { alert(j?.error || `Delete failed (${r.status})`); return; }
      await load();
    } finally {
      setDeletingId(null);
    }
  }, [load]);

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
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => setAddOpen(true)} disabled={unauth}>
          Add custom workload
        </Button>
      </div>

      <AddWorkloadDialog open={addOpen} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); void load(); }} />

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
                  className={`${s.card} ${s.cardRel}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => openWorkload(w)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkload(w); } }}
                >
                  {isCustom(w) && (
                    <div className={s.cardActions} onClick={(e) => e.stopPropagation()}>
                      <Tooltip content="Remove custom workload" relationship="label">
                        <Button
                          size="small" appearance="subtle"
                          icon={deletingId === w.id ? <Spinner size="tiny" /> : <Delete20Regular />}
                          disabled={deletingId === w.id}
                          aria-label={`Remove ${w.name}`}
                          onClick={() => removeWorkload(w)}
                        />
                      </Tooltip>
                    </div>
                  )}
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

/* ───────────────────────── Add custom workload ────────────────────────── */

function AddWorkloadDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [featureSlugs, setFeatureSlugs] = useState('');
  const [included, setIncluded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => { setName(''); setDescription(''); setFeatureSlugs(''); setIncluded(true); setErr(null); };

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const slugs = featureSlugs.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await clientFetch('/api/workloads-catalog', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, category: 'Org', included, featureSlugs: slugs }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setErr(j?.error || `Create failed (${r.status})`); return; }
      reset(); onCreated();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) { reset(); onClose(); } }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add a custom workload</DialogTitle>
          <DialogContent>
            <div className={s.dialogCol}>
              {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              <Field label="Name" required>
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="e.g. Risk Analytics" />
              </Field>
              <Field label="Description">
                <Textarea value={description} onChange={(_, d) => setDescription(d.value)} />
              </Field>
              <Field label="Capability item-type slugs (comma-separated)" hint="e.g. data-product, eventstream, kql-database — these drive the workload's icon + capability pills.">
                <Input value={featureSlugs} onChange={(_, d) => setFeatureSlugs(d.value)} placeholder="data-product, eventstream" />
              </Field>
              <Field label="Include in this tenant by default">
                <Badge appearance={included ? 'filled' : 'outline'} color={included ? 'success' : 'informative'} onClick={() => setIncluded((v) => !v)} style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
                  {included ? 'Included' : 'Optional'}
                </Badge>
              </Field>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button>
            <Button appearance="primary" onClick={save} disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Add workload'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

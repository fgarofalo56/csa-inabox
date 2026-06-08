'use client';

/**
 * DataProductDetailEditor (F3) — full-page owner view of a data product.
 *
 * Azure-native parity with the Microsoft Purview Unified Catalog "data product
 * details" page. Reads a REAL product from the Cosmos `dataproducts` container
 * via GET /api/data-products/[id] (no Fabric / Purview dependency on the default
 * path). Renders:
 *
 *   - Sticky header: name, status badge (Draft/Published/Expired), Endorsed
 *     badge, owner avatars, action buttons.
 *   - Details tab: description, use-case, governance grid, owner contacts with
 *     editable label inputs (persisted via PATCH), paginated subscribers,
 *     terms-of-use + documentation lists, a real DQ-score gauge (or honest-gate
 *     MessageBar naming the missing config), health-action cards, and a Custom
 *     Attributes section with a show-empty toggle.
 *   - Data Observability tab: honest-gate placeholder pending dm-T16 (names the
 *     LOOM_KUSTO_ENDPOINT env var + ADX role).
 *
 * Per no-vaporware.md every control is wired to a real backend or shows an
 * honest Fluent MessageBar gate. No fabricated DQ scores, no mock subscribers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  Avatar, Badge, Body1, Button, Caption1, Card, CardHeader, Field, Input, Label,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Subtitle1, Subtitle2,
  Switch, Tab, TabList,
  Table, TableBody, TableCell, TableRow,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular, CheckmarkCircle16Filled, DocumentText20Regular,
  Edit20Regular, Open16Regular, ShieldTask20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type {
  DataProductDoc, DataProductDetailResponse, DataProductOwner,
} from '@/lib/types/data-product';

// The full owner edit form (create/update, datasets, glossary, lineage, access
// policies) lives in DataProductEditor. The details page is the read-first
// landing surface; "Edit" / "Manage policies" switch to the working editor via
// the ?view=edit query param on the SAME route. Lazy-loaded so the heavy editor
// module stays out of the details bundle until the owner clicks Edit.
const DataProductEditForm = dynamic(
  () => import('./apim-editors').then((m) => m.DataProductEditor),
  { ssr: false, loading: () => <Spinner label="Opening editor…" /> },
);

const useStyles = makeStyles({
  // Sticky header pins to the scroll container provided by ItemEditorChrome.
  sticky: {
    position: 'sticky', top: 0, zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingBottom: 12, marginBottom: 12,
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  headerRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  headerSpacer: { flex: 1 },
  badges: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  avatars: { display: 'flex', alignItems: 'center', gap: 4 },
  actions: { display: 'flex', alignItems: 'center', gap: 8 },
  body: { display: 'flex', flexDirection: 'column', gap: 16 },
  card: { padding: 12 },
  grid2: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 16, rowGap: 8, alignItems: 'center' },
  attrGrid: { display: 'grid', gridTemplateColumns: 'minmax(160px, 240px) 1fr', columnGap: 16, rowGap: 6 },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  contactRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  contactName: { minWidth: 180 },
  links: { display: 'flex', flexDirection: 'column', gap: 4 },
  link: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  muted: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
  gaugeWrap: { display: 'flex', alignItems: 'center', gap: 16 },
  healthCards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 },
  subsBar: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 },
});

interface SubscriberRow {
  id: string;
  requesterUpn?: string;
  requesterDisplayName?: string;
  grantedAt?: string;
  purpose?: string;
}

function statusColor(status?: string): 'warning' | 'success' | 'danger' | 'subtle' {
  if (status === 'Published') return 'success';
  if (status === 'Draft') return 'warning';
  if (status === 'Expired') return 'danger';
  return 'subtle';
}

/** SVG semicircle gauge for the real DQ score. */
function DqGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const r = 52;
  const circ = Math.PI * r; // semicircle length
  const offset = circ * (1 - clamped / 100);
  const color = clamped >= 80 ? tokens.colorPaletteGreenForeground1
    : clamped >= 60 ? tokens.colorPaletteYellowForeground1
      : tokens.colorPaletteRedForeground1;
  return (
    <svg width={140} height={86} viewBox="0 0 140 86" role="img" aria-label={`Data quality score ${clamped} out of 100`}>
      <path d="M 14 76 A 52 52 0 0 1 126 76" fill="none" stroke={tokens.colorNeutralStroke2} strokeWidth={12} strokeLinecap="round" />
      <path
        d="M 14 76 A 52 52 0 0 1 126 76" fill="none" stroke={color} strokeWidth={12} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
      />
      <text x={70} y={68} textAnchor="middle" fontSize={26} fontWeight={600} fill={tokens.colorNeutralForeground1}>{clamped}</text>
    </svg>
  );
}

function LinkList({ items }: { items?: { label: string; url: string }[] }) {
  const s = useStyles();
  if (!items || items.length === 0) return <Caption1 className={s.muted}>None defined.</Caption1>;
  return (
    <div className={s.links}>
      {items.map((l, i) => (
        <a key={i} className={s.link} href={l.url} target="_blank" rel="noreferrer">
          <Open16Regular /> {l.label || l.url}
        </a>
      ))}
    </div>
  );
}

export function DataProductDetailEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ?view=edit switches the SAME route to the full owner edit form. Returning
  // (Back / "Done") drops the param and re-renders the read-first details view.
  const editView = searchParams?.get('view') === 'edit';
  const gotoEdit = useCallback((tab?: string) => {
    const base = pathname || `/items/${item.slug}/${id}`;
    router.push(`${base}?view=edit${tab ? `&tab=${tab}` : ''}`);
  }, [pathname, item.slug, id, router]);

  const [product, setProduct] = useState<DataProductDoc | null>(null);
  const [dqScore, setDqScore] = useState<number | null>(null);
  const [dqGate, setDqGate] = useState<string | null>(null);
  const [subscriberCount, setSubscriberCount] = useState(0);
  const [loading, setLoading] = useState(id !== 'new');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [tab, setTab] = useState<'details' | 'observability'>('details');
  const [showEmpty, setShowEmpty] = useState(false);

  // Owner contact-label editing (persisted via PATCH).
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [labelsDirty, setLabelsDirty] = useState(false);
  const [savingLabels, setSavingLabels] = useState(false);
  const [labelMsg, setLabelMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Subscribers (lazy, paginated).
  const [subs, setSubs] = useState<SubscriberRow[] | null>(null);
  const [subPage, setSubPage] = useState(0);
  const [subBusy, setSubBusy] = useState(false);
  const SUB_PAGE_SIZE = 10;

  const hydrate = useCallback((d: DataProductDetailResponse) => {
    setProduct(d.product ?? null);
    setDqScore(d.dqScore ?? null);
    setDqGate(d.dqGate ?? null);
    setSubscriberCount(d.subscriberCount ?? 0);
    const init: Record<string, string> = {};
    (d.product?.owners ?? []).forEach((o) => { init[o.id] = o.label ?? ''; });
    setLabels(init);
    setLabelsDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (id === 'new') {
      setLoadErr('Open an existing data product from the Marketplace to view its details. Use "New data product" to create one.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`);
      const j = (await r.json()) as DataProductDetailResponse;
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      hydrate(j);
    } catch (e: any) {
      setLoadErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id, hydrate]);

  useEffect(() => { void load(); }, [load]);

  const saveLabels = useCallback(async () => {
    setSavingLabels(true);
    setLabelMsg(null);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerLabels: labels }),
      });
      const j = (await r.json()) as { ok: boolean; product?: DataProductDoc; error?: string };
      if (!j.ok || !j.product) { setLabelMsg({ intent: 'error', text: j.error || `HTTP ${r.status}` }); return; }
      setProduct(j.product);
      const init: Record<string, string> = {};
      (j.product.owners ?? []).forEach((o) => { init[o.id] = o.label ?? ''; });
      setLabels(init);
      setLabelsDirty(false);
      setLabelMsg({ intent: 'success', text: 'Contact labels saved.' });
    } catch (e: any) {
      setLabelMsg({ intent: 'error', text: e?.message || String(e) });
    } finally {
      setSavingLabels(false);
    }
  }, [id, labels]);

  const loadSubscribers = useCallback(async (page: number) => {
    setSubBusy(true);
    try {
      const r = await fetch(`/api/data-products/${encodeURIComponent(id)}/subscribers?page=${page}&pageSize=${SUB_PAGE_SIZE}`);
      const j = (await r.json()) as { ok: boolean; subscribers?: SubscriberRow[] };
      if (j.ok) { setSubs(j.subscribers ?? []); setSubPage(page); }
    } catch {
      setSubs([]);
    } finally {
      setSubBusy(false);
    }
  }, [id]);

  const visibleAttrs = useMemo(() => {
    const all = product?.customAttributes ?? [];
    return showEmpty ? all : all.filter((a) => a.value != null && a.value !== '');
  }, [product?.customAttributes, showEmpty]);

  const ribbon: RibbonTab[] = useMemo(() => [
    {
      id: 'home', label: 'Home',
      groups: [
        {
          label: 'Actions',
          actions: [
            { label: loading ? 'Loading…' : 'Refresh', icon: <ArrowClockwise20Regular />, onClick: loading ? undefined : () => void load(), disabled: loading },
            { label: 'Edit', icon: <Edit20Regular />, onClick: product ? () => gotoEdit() : undefined, disabled: !product },
            { label: 'Manage policies', icon: <ShieldTask20Regular />, onClick: product ? () => gotoEdit('policies') : undefined, disabled: !product },
          ],
        },
      ],
    },
  ], [loading, load, product, gotoEdit]);

  const main = (() => {
    if (loading) return <Spinner label="Loading data product…" />;
    if (loadErr) {
      return (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Unable to load this data product</MessageBarTitle>
            {loadErr}
          </MessageBarBody>
        </MessageBar>
      );
    }
    if (!product) return <Body1>No data product to show.</Body1>;

    const owners: DataProductOwner[] = product.owners ?? [];

    return (
      <div>
        {/* Sticky header */}
        <div className={s.sticky}>
          <div className={s.headerRow}>
            <Subtitle1>{product.name}</Subtitle1>
            <div className={s.badges}>
              <Badge appearance="filled" color={statusColor(product.status)}>{product.status}</Badge>
              {product.endorsed && (
                <Badge appearance="outline" color="informative" icon={<CheckmarkCircle16Filled />}>Endorsed</Badge>
              )}
            </div>
            <div className={s.headerSpacer} />
            {owners.length > 0 && (
              <div className={s.avatars}>
                {owners.slice(0, 5).map((o) => (
                  <Avatar key={o.id} size={28} color="colorful" name={o.displayName || o.upn || o.id}
                    aria-label={o.displayName || o.upn || o.id} />
                ))}
                {owners.length > 5 && <Caption1>+{owners.length - 5}</Caption1>}
              </div>
            )}
            <div className={s.actions}>
              <Button appearance="primary" icon={<Edit20Regular />}
                onClick={() => gotoEdit()}>Edit</Button>
            </div>
          </div>
        </div>

        <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'details' | 'observability')}>
          <Tab value="details">Details</Tab>
          <Tab value="observability">Data Observability</Tab>
        </TabList>

        {tab === 'details' && (
          <div className={s.body} style={{ marginTop: 12 }}>
            {/* Description */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Description</Subtitle2>} />
              {product.description ? <Body1>{product.description}</Body1> : <Caption1 className={s.muted}>No description.</Caption1>}
            </Card>

            {/* Use case */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Use case</Subtitle2>} />
              {product.useCase ? <Body1>{product.useCase}</Body1> : <Caption1 className={s.muted}>No use case defined.</Caption1>}
            </Card>

            {/* Governance grid */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Governance</Subtitle2>} />
              <div className={s.grid2}>
                <Caption1>Governance domain</Caption1>
                <Body1>{product.governanceDomainName || product.governanceDomainId || '—'}</Body1>
                <Caption1>Update frequency</Caption1>
                <Body1>{product.updateFrequency || 'Not set'}</Body1>
                <Caption1>Status</Caption1>
                <Body1><Badge appearance="filled" color={statusColor(product.status)}>{product.status}</Badge></Body1>
                {product.type && (<><Caption1>Type</Caption1><Body1>{product.type}</Body1></>)}
              </div>
            </Card>

            {/* Owner contacts — editable labels (PATCH) */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Owner contacts</Subtitle2>} />
              {owners.length === 0 ? (
                <Caption1 className={s.muted}>No owners assigned.</Caption1>
              ) : (
                <>
                  {owners.map((o) => (
                    <div key={o.id} className={s.contactRow}>
                      <Avatar size={24} color="colorful" name={o.displayName || o.upn || o.id} aria-hidden />
                      <Body1 className={s.contactName}>{o.displayName || o.upn || o.id}</Body1>
                      <Field label="Contact label" orientation="horizontal">
                        <Input
                          value={labels[o.id] ?? ''}
                          placeholder="e.g. Primary contact"
                          onChange={(_, d) => { setLabels((p) => ({ ...p, [o.id]: d.value })); setLabelsDirty(true); }}
                        />
                      </Field>
                    </div>
                  ))}
                  <div className={s.actions}>
                    <Button appearance="primary" disabled={!labelsDirty || savingLabels} onClick={() => void saveLabels()}>
                      {savingLabels ? 'Saving…' : 'Save contact labels'}
                    </Button>
                  </div>
                  {labelMsg && (
                    <MessageBar intent={labelMsg.intent === 'success' ? 'success' : 'error'} style={{ marginTop: 8 }}>
                      <MessageBarBody>{labelMsg.text}</MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}
            </Card>

            {/* Subscribers — real, paginated */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Subscribers</Subtitle2>} />
              <Caption1>{subscriberCount} approved subscriber{subscriberCount === 1 ? '' : 's'}</Caption1>
              {subscriberCount > 0 && (
                <div className={s.subsBar}>
                  <Button size="small" disabled={subBusy} onClick={() => void loadSubscribers(0)}>
                    {subs === null ? 'Load subscribers' : 'Reload'}
                  </Button>
                  {subs !== null && (
                    <>
                      <Button size="small" disabled={subBusy || subPage === 0} onClick={() => void loadSubscribers(subPage - 1)}>Prev</Button>
                      <Caption1>Page {subPage + 1}</Caption1>
                      <Button size="small" disabled={subBusy || subs.length < SUB_PAGE_SIZE} onClick={() => void loadSubscribers(subPage + 1)}>Next</Button>
                    </>
                  )}
                </div>
              )}
              {subs !== null && subs.length > 0 && (
                <Table size="small" style={{ marginTop: 8 }}>
                  <TableBody>
                    {subs.map((sub) => (
                      <TableRow key={sub.id}>
                        <TableCell>{sub.requesterDisplayName || sub.requesterUpn || sub.id}</TableCell>
                        <TableCell>{sub.purpose || '—'}</TableCell>
                        <TableCell>{sub.grantedAt ? new Date(sub.grantedAt).toLocaleDateString() : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {subs !== null && subs.length === 0 && <Caption1 className={s.muted}>No subscribers on this page.</Caption1>}
            </Card>

            {/* Terms of use + Documentation */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Terms of use</Subtitle2>} />
              <LinkList items={product.termsOfUse} />
            </Card>
            <Card className={s.card}>
              <CardHeader header={<div className={s.link}><DocumentText20Regular /><Subtitle2>Documentation</Subtitle2></div>} />
              <LinkList items={product.documentation} />
            </Card>

            {/* DQ score gauge or honest-gate */}
            <Card className={s.card}>
              <CardHeader header={<Subtitle2>Data quality</Subtitle2>} />
              {dqScore !== null ? (
                <div className={s.gaugeWrap}>
                  <DqGauge score={dqScore} />
                  <Body1>Score computed from this tenant&apos;s enabled data-quality rules.</Body1>
                </div>
              ) : (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>No data-quality score yet</MessageBarTitle>
                    {dqGate || 'Configure data-quality rules to compute a real score.'}{' '}
                    <Button appearance="transparent" size="small" onClick={() => router.push('/admin/data-quality-rules')}>Open Data Quality Rules</Button>
                  </MessageBarBody>
                </MessageBar>
              )}
            </Card>

            {/* Health-action cards — derived from real DQ posture */}
            <div>
              <Subtitle2 className={s.sectionTitle}>Health actions</Subtitle2>
              <div className={s.healthCards} style={{ marginTop: 8 }}>
                {dqScore === null ? (
                  <Card className={s.card}>
                    <CardHeader header={<Body1>Configure data-quality rules</Body1>}
                      description={<Caption1>No rules are defined for this tenant.</Caption1>} />
                    <Button size="small" onClick={() => router.push('/admin/data-quality-rules')}>Fix</Button>
                  </Card>
                ) : dqScore < 80 ? (
                  <Card className={s.card}>
                    <CardHeader header={<Body1>Improve data-quality coverage</Body1>}
                      description={<Caption1>Score is {dqScore}/100 — some rules are disabled.</Caption1>} />
                    <Button size="small" onClick={() => router.push('/admin/data-quality-rules')}>Review rules</Button>
                  </Card>
                ) : (
                  <Caption1 className={s.muted}>No health actions needed.</Caption1>
                )}
              </div>
            </div>

            {/* Custom Attributes — show-empty toggle */}
            <Card className={s.card}>
              <CardHeader
                header={<Subtitle2>Custom attributes</Subtitle2>}
                action={<Switch checked={showEmpty} onChange={(_, d) => setShowEmpty(d.checked)} label="Show attributes without a value" />}
              />
              {visibleAttrs.length === 0 ? (
                <Caption1 className={s.muted}>
                  {(product.customAttributes ?? []).length === 0 ? 'No custom attributes.' : 'All attributes are empty. Toggle "Show attributes without a value" to reveal them.'}
                </Caption1>
              ) : (
                <div className={s.attrGrid}>
                  {visibleAttrs.map((a, i) => (
                    <Field key={`${a.groupName}-${a.name}-${i}`}>
                      <Label weight="semibold">{a.groupName ? `${a.groupName} · ${a.name}` : a.name}</Label>
                      <Body1>{a.value != null && a.value !== '' ? String(a.value) : <span className={s.muted}>—</span>}</Body1>
                    </Field>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'observability' && (
          <div style={{ marginTop: 12 }}>
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Data Observability (preview) — content from dm-T16</MessageBarTitle>
                This tab renders lineage and Azure Data Explorer health-metric charts when{' '}
                <code>LOOM_KUSTO_ENDPOINT</code> is configured and a connected ADX cluster is
                available. Grant the Console UAMI the <code>AllDatabasesViewer</code> role on the
                cluster. See <code>docs/fiab/parity/data-product.md</code>.
              </MessageBarBody>
            </MessageBar>
          </div>
        )}
      </div>
    );
  })();

  // ?view=edit → hand off to the full working owner editor on the same route.
  if (editView) return <DataProductEditForm item={item} id={id} />;

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}

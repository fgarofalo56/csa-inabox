'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  makeStyles, tokens, TabList, Tab, Badge, Button, Text, Spinner, Body1,
  Caption1, MessageBar, MessageBarBody, MessageBarTitle, Divider, Card,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
} from '@fluentui/react-components';
import {
  KeyRegular, CheckmarkCircleRegular, LockClosedRegular, DatabaseRegular,
  BookRegular, PersonRegular,
} from '@fluentui/react-icons';
import { RequestAccessDialog } from './components/request-access-dialog';
import type { AccessRequest, AccessRequestStatus } from '@/lib/types/access-request';
import type { WorkspaceItem } from '@/lib/types/workspace';

interface DataProductDataset { name: string; typeName?: string; qualifiedName?: string; classifications?: string[]; guid?: string; }
interface DataProductGlossaryLink { name: string; guid?: string; }
interface DataProductState {
  displayName?: string;
  description?: string;
  domain?: string;
  owner?: string;
  certified?: boolean;
  sla?: string;
  bundle?: string[];
  datasets?: DataProductDataset[];
  glossaryLinks?: DataProductGlossaryLink[];
  purviewDataProductId?: string;
  lastRegisteredAt?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalXXL, maxWidth: '1100px' },
  header: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  ownerLine: { color: tokens.colorNeutralForeground3 },
  actions: { marginTop: tokens.spacingVerticalS },
  tabContent: { paddingTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  metaGrid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: tokens.spacingHorizontalXL, rowGap: tokens.spacingVerticalS, alignItems: 'baseline' },
  metaLabel: { color: tokens.colorNeutralForeground3, fontWeight: tokens.fontWeightSemibold },
  card: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontWeight: tokens.fontWeightSemibold },
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  empty: { color: tokens.colorNeutralForeground3 },
});

const STATUS_COLOR: Record<AccessRequestStatus, 'warning' | 'success' | 'danger' | 'brand'> = {
  pending: 'warning', approved: 'success', rejected: 'danger', completed: 'brand',
};

/**
 * F15 — consumer (read-only) details view of a Published data product.
 *
 * A non-owner sees the same product details (overview / datasets / glossary)
 * with NO owner-edit controls, plus a "Request access" CTA that opens the
 * purpose-bound RequestAccessDialog. Their own access requests for this product
 * are shown inline ("My data access", T12). Owners see a banner and the CTA is
 * disabled (they already own it).
 *
 * Reads from /api/data-products/[id] (no ownership gate) — Cosmos-only, no
 * Fabric/Power BI dependency.
 */
export function DataProductDetailEditor({ id }: { id: string }) {
  const s = useStyles();
  const [item, setItem] = useState<WorkspaceItem | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [myRequests, setMyRequests] = useState<AccessRequest[]>([]);

  const loadMyRequests = useCallback(async () => {
    try {
      const r = await fetch(`/api/data-products/${id}/access-requests`);
      const j = await r.json();
      if (j.ok) setMyRequests(j.requests ?? []);
    } catch { /* non-fatal; the request panel just stays empty */ }
  }, [id]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/data-products/${id}`)
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (j.ok) { setItem(j.item); setIsOwner(j.isOwner ?? false); }
        else setError(j.error || 'Failed to load data product');
      })
      .catch((e) => { if (live) setError(e?.message || String(e)); })
      .finally(() => { if (live) setLoading(false); });
    loadMyRequests();
    return () => { live = false; };
  }, [id, loadMyRequests]);

  if (loading) return <Spinner label="Loading data product…" />;
  if (error) return <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>;
  if (!item) return null;

  const state = (item.state ?? {}) as DataProductState;
  const name = state.displayName || item.displayName;

  return (
    <div className={s.root}>
      <div className={s.header}>
        <div className={s.titleRow}>
          <LockClosedRegular aria-label="Read-only" />
          <Text size={600} weight="semibold">{name}</Text>
          <Badge appearance="outline" color="informative">Read-only</Badge>
          {state.certified && (
            <Badge appearance="tint" color="success" icon={<CheckmarkCircleRegular />}>Certified</Badge>
          )}
          {state.domain && <Badge appearance="outline">{state.domain}</Badge>}
          {state.sla && <Badge appearance="tint" color="informative">SLA: {state.sla}</Badge>}
          {isOwner && <Badge appearance="tint" color="warning">You own this product</Badge>}
        </div>
        {state.owner && <Caption1 className={s.ownerLine}><PersonRegular style={{ verticalAlign: 'middle' }} /> Owner: {state.owner}</Caption1>}
        {item.description && <Body1>{item.description}</Body1>}
        <div className={s.actions}>
          <Button
            appearance="primary"
            icon={<KeyRegular />}
            disabled={isOwner}
            title={isOwner ? 'You own this product' : 'Request access to this data product'}
            onClick={() => setDialogOpen(true)}
          >
            Request access
          </Button>
        </div>
      </div>

      <Divider />

      <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as string)}>
        <Tab value="overview" icon={<BookRegular />}>Overview</Tab>
        <Tab value="datasets" icon={<DatabaseRegular />}>Datasets</Tab>
        <Tab value="glossary" icon={<BookRegular />}>Glossary</Tab>
        <Tab value="access" icon={<KeyRegular />}>My data access</Tab>
      </TabList>

      <div className={s.tabContent}>
        {activeTab === 'overview' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}>Overview</Text>
            <div className={s.metaGrid}>
              <Caption1 className={s.metaLabel}>Description</Caption1>
              <Body1>{state.description || item.description || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>Domain</Caption1>
              <Body1>{state.domain || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>Owner</Caption1>
              <Body1>{state.owner || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>SLA</Caption1>
              <Body1>{state.sla || <span className={s.empty}>—</span>}</Body1>
              <Caption1 className={s.metaLabel}>Endorsement</Caption1>
              <Body1>{state.certified ? 'Certified' : <span className={s.empty}>None</span>}</Body1>
              <Caption1 className={s.metaLabel}>Catalog</Caption1>
              <Body1>{state.purviewDataProductId
                ? <>Registered <code>{state.purviewDataProductId}</code></>
                : <span className={s.empty}>Not registered with the unified catalog</span>}</Body1>
            </div>
          </Card>
        )}

        {activeTab === 'datasets' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><DatabaseRegular /> Datasets</Text>
            {(state.datasets ?? []).length === 0 ? (
              <Caption1 className={s.empty}>This data product has no published datasets.</Caption1>
            ) : (
              <Table size="small" aria-label="Datasets">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Classifications</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(state.datasets ?? []).map((d, i) => (
                    <TableRow key={d.guid || d.qualifiedName || `${d.name}-${i}`}>
                      <TableCell>{d.name}</TableCell>
                      <TableCell>{d.typeName || '—'}</TableCell>
                      <TableCell>
                        {(d.classifications ?? []).length
                          ? <div className={s.chips}>{(d.classifications ?? []).map((c) => <Badge key={c} appearance="outline" size="small">{c}</Badge>)}</div>
                          : <span className={s.empty}>—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        )}

        {activeTab === 'glossary' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><BookRegular /> Glossary terms</Text>
            {(state.glossaryLinks ?? []).length === 0 ? (
              <Caption1 className={s.empty}>No glossary terms are linked to this data product.</Caption1>
            ) : (
              <div className={s.chips}>
                {(state.glossaryLinks ?? []).map((g) => (
                  <Badge key={g.guid || g.name} appearance="tint" color="brand">{g.name}</Badge>
                ))}
              </div>
            )}
          </Card>
        )}

        {activeTab === 'access' && (
          <Card className={s.card}>
            <Text className={s.sectionTitle}><KeyRegular /> My data access</Text>
            {myRequests.length === 0 ? (
              <Caption1 className={s.empty}>
                You have no access requests for this data product yet. Use{' '}
                <strong>Request access</strong> above to submit one.
              </Caption1>
            ) : (
              <Table size="small" aria-label="My access requests">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Purpose</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Requested</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myRequests.map((rq) => (
                    <TableRow key={rq.id}>
                      <TableCell>{rq.purposeName}</TableCell>
                      <TableCell>
                        <Badge appearance="tint" color={STATUS_COLOR[rq.status]}>{rq.status}</Badge>
                      </TableCell>
                      <TableCell>{new Date(rq.createdAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        )}
      </div>

      <RequestAccessDialog
        dataProductId={id}
        dataProductName={name}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={() => { setActiveTab('access'); loadMyRequests(); }}
      />
    </div>
  );
}

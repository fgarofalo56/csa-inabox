'use client';

/**
 * Data Product details / creation receipt — the page the wizard lands on after
 * a successful create (/data-products/<id>). Reads the REAL Cosmos draft via
 * /api/cosmos-items/data-product/<id> and shows every field the wizard wrote,
 * plus the Purview Unified Catalog registration outcome (the "receipt": the new
 * id + whether it also landed in Purview, or an honest hint when it didn't).
 *
 * The data product is created in DRAFT — per Purview, other users can't see it
 * until assets + an access policy are added and it's published. We surface that
 * exactly as the portal does, with links to the relevant next steps.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Body1, Button, Caption1, Divider, Spinner, Subtitle2, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, CheckmarkCircle20Filled, Open20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import {
  dataProductTypeLabel, audienceLabel,
} from '@/lib/catalog/data-product-enums';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacingHorizontalM, maxWidth: '920px' },
  card: { padding: '14px', borderRadius: tokens.borderRadiusXLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalXS },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalM, maxWidth: '920px' },
  desc: { whiteSpace: 'pre-wrap' },
  tags: { display: 'flex', gap: tokens.spacingHorizontalSNudge, flexWrap: 'wrap' },
});

interface DataProductItem {
  id: string;
  displayName: string;
  description?: string;
  state?: {
    status?: string;
    type?: string;
    audience?: string[];
    governanceDomainId?: string | null;
    governanceDomainName?: string | null;
    useCase?: string;
    endorsed?: boolean;
    owners?: Array<{ id: string; upn: string; displayName: string }>;
    customAttributes?: Record<string, unknown>;
    purviewRegistered?: boolean;
    purviewDataProductId?: string;
    purviewHint?: string;
  };
  createdAt?: string;
}

export function DataProductDetails({ id }: { id: string }) {
  const s = useStyles();
  const router = useRouter();
  const [item, setItem] = useState<DataProductItem | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const r = await fetch(`/api/cosmos-items/data-product/${encodeURIComponent(id)}`);
      if (r.status === 404) { setError('Data product not found.'); setItem(null); return; }
      const j = await r.json();
      if (j?.ok === false) { setError(j.error || `HTTP ${r.status}`); setItem(null); }
      else setItem(j as DataProductItem);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const st = item?.state || {};
  const customEntries = Object.entries(st.customAttributes || {}).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));

  return (
    <PageShell
      title={item?.displayName || 'Data product'}
      subtitle="Microsoft Purview Unified Catalog data product"
      breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Data products', href: '/data-products' }, { label: item?.displayName || id }]}
      actions={
        <div className={s.tags}>
          <Badge appearance="outline" color={st.status === 'PUBLISHED' ? 'success' : 'informative'}>{st.status || 'DRAFT'}</Badge>
          {st.endorsed && <Badge appearance="filled" color="success" icon={<CheckmarkCircle20Filled />}>Endorsed</Badge>}
        </div>
      }
    >
      {loading && <Spinner size="small" label="Loading data product…" />}
      {error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Unable to load</MessageBarTitle>{error}</MessageBarBody></MessageBar>}

      {item && !loading && (
        <div className={s.section}>
          {/* Creation receipt */}
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Draft created</MessageBarTitle>
              Data product <code>{item.id}</code> was saved in Loom.
              {st.purviewRegistered
                ? <> It was also registered in Microsoft Purview Unified Catalog{st.purviewDataProductId ? <> (<code>{st.purviewDataProductId}</code>)</> : null}.</>
                : <> {st.purviewHint || 'It was not registered in Purview Unified Catalog.'}</>}
            </MessageBarBody>
          </MessageBar>

          <MessageBar intent="info">
            <MessageBarBody>
              This data product is in <strong>draft</strong>. Other users can't see it until you add data assets, create an access policy, and publish it.
            </MessageBarBody>
          </MessageBar>

          {item.description && (
            <div>
              <Subtitle2>Description</Subtitle2>
              <Body1 className={s.desc}>{item.description}</Body1>
            </div>
          )}

          <Divider />

          <div className={s.grid}>
            <div className={s.card}><Caption1>Type</Caption1><Text>{dataProductTypeLabel(st.type)}</Text></div>
            <div className={s.card}>
              <Caption1>Governance domain</Caption1>
              <Text>{st.governanceDomainName || st.governanceDomainId || '—'}</Text>
            </div>
            <div className={s.card}>
              <Caption1>Audience</Caption1>
              <div className={s.tags}>
                {(st.audience || []).length === 0 ? <Text>—</Text> : (st.audience || []).map((a) => (
                  <Badge key={a} appearance="tint">{audienceLabel(a)}</Badge>
                ))}
              </div>
            </div>
            <div className={s.card}>
              <Caption1>Owners</Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {(st.owners || []).length === 0 ? <Text>—</Text> : (st.owners || []).map((o) => (
                  <Text key={o.id}>{o.displayName}{o.upn ? ` (${o.upn})` : ''}</Text>
                ))}
              </div>
            </div>
          </div>

          {st.useCase && (
            <div>
              <Subtitle2>Use case</Subtitle2>
              <Body1 className={s.desc}>{st.useCase}</Body1>
            </div>
          )}

          {customEntries.length > 0 && (
            <div>
              <Subtitle2>Custom attributes</Subtitle2>
              <div className={s.grid}>
                {customEntries.map(([k, v]) => (
                  <div key={k} className={s.card}>
                    <Caption1>{k}</Caption1>
                    <Text>{Array.isArray(v) ? v.join(', ') : String(v)}</Text>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Divider />
          <div className={s.tags}>
            <Button icon={<Add20Regular />} appearance="primary" onClick={() => router.push('/data-products/new')}>
              New data product
            </Button>
            <Button icon={<Open20Regular />} onClick={() => router.push(`/items/data-product/${encodeURIComponent(item.id)}`)}>
              Open in full editor (assets, glossary, access policies)
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}

'use client';

/**
 * LivingMarketplace — WS-10.4 (BTB-11) unified "Catalog" tab of the Loom
 * Marketplace. Lists, publishes, and subscribes to ALL FIVE product kinds
 * (data | agent | mcp | app | ontology) from ONE Cosmos `marketplace` schema:
 *
 *   list      GET  /api/marketplace/products         (unified, cert + LCU on each tile)
 *   publish   POST /api/marketplace/products          (runs gate registry = auto-cert)
 *   subscribe POST /api/marketplace/products/[id]/subscribe  (real grant + LCU meter)
 *
 * Certification badges are REAL: `certified` means the product's backend gates
 * all passed at publish time; `failed` shows the exact missing env var to fix.
 * Subscribing creates a real access-governance grant and meters LCU to the
 * tenant chargeback. Web3-UI: TileGrid / tokens / EmptyState / badges, matching
 * the sibling marketplace surfaces (unified-discover, data-marketplace).
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Body1, Caption1, Text, Badge, Button, Spinner, Card, CardHeader,
  Input, Tag, Tooltip, Field, Textarea, Select,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, shorthands, tokens,
} from '@fluentui/react-components';
import {
  Search20Regular, ArrowSync20Regular, Add20Regular, Ribbon16Regular,
  Warning16Regular, MoneyRegular, StoreMicrosoft24Regular, Database20Regular,
  Bot20Regular, PlugConnected20Regular, Apps20Regular, Share20Regular,
} from '@fluentui/react-icons';
import { VirtualizedGrid } from '@/lib/components/ui/virtualized-grid';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import { BrandedItemIcon } from '@/lib/components/ui/branded-item-icon';
import { EmptyState } from '@/lib/components/empty-state';

/** Local mirror of the unified product record (shape from product-types.ts). */
interface CertGate { gateId: string; title: string; status: 'configured' | 'blocked'; missing: string[] }
interface Product {
  id: string;
  productKind: 'data' | 'agent' | 'mcp' | 'app' | 'ontology';
  displayName: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;
  certification: 'draft' | 'certified' | 'failed';
  certGates?: CertGate[];
  accessModel: 'open' | 'request';
  grantRole: string;
  lcuPerSubscription: number;
  publishStatus: 'draft' | 'published' | 'deprecated';
  subscriberCount: number;
}

type Kind = Product['productKind'];
const KINDS: Kind[] = ['data', 'agent', 'mcp', 'app', 'ontology'];
const KIND_LABEL: Record<Kind, string> = {
  data: 'Data product', agent: 'Agent', mcp: 'MCP server', app: 'App', ontology: 'Ontology',
};
const KIND_ICON: Record<Kind, ReactElement> = {
  data: <Database20Regular />, agent: <Bot20Regular />, mcp: <PlugConnected20Regular />,
  app: <Apps20Regular />, ontology: <Share20Regular />,
};
const KIND_TYPE: Record<Kind, string> = {
  data: 'data-product', agent: 'agent-flow', mcp: 'mcp-server', app: 'loom-app', ontology: 'ontology',
};

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  kinds: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  card: {
    padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    minWidth: 0,
    transitionProperty: 'box-shadow, transform, border-color',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow16,
      transform: 'translateY(-2px)',
      ...shorthands.borderColor(tokens.colorBrandStroke1),
    },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  meta: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center', marginTop: tokens.spacingVerticalXS, minWidth: 0 },
  cost: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', color: tokens.colorNeutralForeground2 },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
});

export function LivingMarketplace() {
  const s = useStyles();
  // U10 kill-switch (FLAG0) — OFF reverts to the pre-U10 full-render grid.
  const virtualizeOn = useRuntimeFlag('u10-browse-virtualization');
  const [q, setQ] = useState('');
  const [activeKinds, setActiveKinds] = useState<Set<Kind>>(new Set(KINDS));
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [banner, setBanner] = useState<{ intent: 'success' | 'warning' | 'error'; title: string; body: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await clientFetch('/api/marketplace/products');
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setErr(j.error || 'failed to load products');
        setProducts([]);
      } else {
        setProducts(j.products || []);
      }
    } catch {
      setErr('marketplace catalog unavailable');
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (products || []).filter((p) =>
      activeKinds.has(p.productKind) &&
      (!query || p.displayName.toLowerCase().includes(query) || (p.description || '').toLowerCase().includes(query) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(query))));
  }, [products, activeKinds, q]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of (products || [])) c[p.productKind] = (c[p.productKind] || 0) + 1;
    return c;
  }, [products]);

  const toggleKind = (k: Kind) => setActiveKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next.size === 0 ? new Set(KINDS) : next;
  });

  const subscribe = useCallback(async (p: Product) => {
    setBanner(null);
    try {
      const r = await clientFetch(`/api/marketplace/products/${encodeURIComponent(p.id)}/subscribe`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        setBanner({ intent: 'warning', title: 'Subscribe blocked', body: j.error || 'could not subscribe' });
        return;
      }
      setBanner({
        intent: 'success',
        title: `Subscribed to ${p.displayName}`,
        body: `Entitlement ${j.entitlementState} · metered ${j.lcu} LCU (~$${(j.estCostUsd ?? 0).toFixed(2)}) to your tenant chargeback.`,
      });
      void load();
    } catch {
      setBanner({ intent: 'error', title: 'Subscribe failed', body: 'network error' });
    }
  }, [load]);

  return (
    <div className={s.pad}>
      {banner && (
        <MessageBar intent={banner.intent} layout="multiline">
          <MessageBarBody><MessageBarTitle>{banner.title}</MessageBarTitle> {banner.body}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.row}>
        <Input style={{ minWidth: 320, flex: 1 }} contentBefore={<Search20Regular />}
          placeholder="Search products, agents, MCP servers, apps, ontologies…"
          value={q} onChange={(_, d) => setQ(d.value)} />
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setPublishOpen(true)}>Publish product</Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
        <Text size={200}>{filtered.length} product{filtered.length === 1 ? '' : 's'}</Text>
      </div>

      <div className={s.kinds}>
        <Caption1 className={s.hint}>Show:</Caption1>
        {KINDS.map((k) => (
          <Tag key={k} appearance={activeKinds.has(k) ? 'filled' : 'outline'} icon={KIND_ICON[k]}
            onClick={() => toggleKind(k)} style={{ cursor: 'pointer' }}>
            {KIND_LABEL[k]} {counts[k] ? `(${counts[k]})` : ''}
          </Tag>
        ))}
      </div>

      {err && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody><MessageBarTitle>Catalog error</MessageBarTitle> {err}</MessageBarBody>
        </MessageBar>
      )}

      {filtered.length === 0 && !loading && (
        <EmptyState
          icon={<StoreMicrosoft24Regular />}
          title="No products published yet"
          body="Publish a data product, agent, MCP server, app, or ontology. Publishing runs the platform gates as auto-certification — a certified product is subscribable, with entitlement tracked under My access and usage metered to your tenant chargeback."
          primaryAction={{ label: 'Publish product', onClick: () => setPublishOpen(true) }}
        />
      )}

      {/* U10 — windows past 200 products; kill-switch OFF or ≤200 renders the
          plain TileGrid path (pre-U10). */}
      <VirtualizedGrid
        items={filtered}
        enabled={virtualizeOn}
        minTileWidth={300}
        getKey={(p) => p.id}
        ariaLabel="Marketplace products"
        renderTile={(p) => {
          const blockers = (p.certGates || []).flatMap((g) => g.missing).filter(Boolean);
          const subscribable = p.certification === 'certified' && p.publishStatus !== 'deprecated';
          return (
            <Card key={p.id} className={s.card}>
              <CardHeader
                image={<BrandedItemIcon type={KIND_TYPE[p.productKind]} size="md" />}
                header={<Body1><b>{p.displayName}</b></Body1>}
                description={<Caption1 className={s.hint}>{p.description || KIND_LABEL[p.productKind]}</Caption1>}
                action={p.certification === 'certified' ? (
                  <Tooltip content="Auto-certified — all backend gates passed" relationship="description">
                    <Badge appearance="filled" color="success" icon={<Ribbon16Regular />}>Certified</Badge>
                  </Tooltip>
                ) : p.certification === 'failed' ? (
                  <Tooltip content={`Certification blocked — set: ${blockers.join(', ') || 'required backend'}`} relationship="description">
                    <Badge appearance="tint" color="warning" icon={<Warning16Regular />}>Needs fix</Badge>
                  </Tooltip>
                ) : (
                  <Badge appearance="outline">Draft</Badge>
                )}
              />
              <div className={s.meta}>
                <Badge appearance="tint" color="brand">{KIND_LABEL[p.productKind]}</Badge>
                {p.domain && <Badge appearance="outline">{p.domain}</Badge>}
                <Badge appearance="outline">{p.accessModel === 'open' ? 'Self-serve' : 'Request'}</Badge>
                <span className={s.cost}><MoneyRegular fontSize={14} /><Caption1>{p.lcuPerSubscription} LCU / sub</Caption1></span>
                {p.subscriberCount > 0 && <Caption1 className={s.hint}>{p.subscriberCount} subscriber{p.subscriberCount === 1 ? '' : 's'}</Caption1>}
                {(p.tags || []).slice(0, 3).map((t) => <Tag key={t} size="extra-small">{t}</Tag>)}
              </div>
              {p.certification === 'failed' && blockers.length > 0 && (
                <Caption1 className={s.hint}>Set {blockers.join(', ')} to certify, then re-certify.</Caption1>
              )}
              <div className={s.actions}>
                <Button size="small" appearance="primary" disabled={!subscribable} onClick={() => void subscribe(p)}>
                  Subscribe
                </Button>
                {!subscribable && p.certification === 'failed' && (
                  <Button size="small" appearance="subtle" onClick={() => void recertify(p, load, setBanner)}>Re-certify</Button>
                )}
              </div>
            </Card>
          );
        }}
      />

      <PublishDialog open={publishOpen} setOpen={setPublishOpen} onDone={(res) => { setBanner(res); void load(); }} />
    </div>
  );
}

async function recertify(
  p: Product,
  reload: () => void,
  setBanner: (b: { intent: 'success' | 'warning' | 'error'; title: string; body: string }) => void,
) {
  try {
    const r = await clientFetch(`/api/marketplace/products/${encodeURIComponent(p.id)}/certify`, { method: 'POST' });
    const j = await r.json();
    if (j.certification === 'certified') {
      setBanner({ intent: 'success', title: `${p.displayName} certified`, body: 'All backend gates now pass — the product is subscribable.' });
    } else {
      setBanner({ intent: 'warning', title: 'Still blocked', body: `Set: ${(j.blockers || []).join(', ') || 'required backend'}` });
    }
    reload();
  } catch {
    setBanner({ intent: 'error', title: 'Re-certify failed', body: 'network error' });
  }
}

/** Publish dialog — pick a kind, name it, choose access model + LCU price. */
function PublishDialog({
  open, setOpen, onDone,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  onDone: (banner: { intent: 'success' | 'warning' | 'error'; title: string; body: string }) => void;
}) {
  const s = useStyles();
  const [kind, setKind] = useState<Kind>('data');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [domain, setDomain] = useState('');
  const [accessModel, setAccessModel] = useState<'open' | 'request'>('open');
  const [lcu, setLcu] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setKind('data'); setDisplayName(''); setDescription(''); setDomain(''); setAccessModel('open'); setLcu(''); };

  const publish = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { productKind: kind, displayName: displayName.trim(), accessModel };
      if (description.trim()) body.description = description.trim();
      if (domain.trim()) body.domain = domain.trim();
      if (lcu.trim() && !Number.isNaN(Number(lcu))) body.lcuPerSubscription = Number(lcu);
      const r = await clientFetch('/api/marketplace/products', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j.ok === false) {
        onDone({ intent: 'error', title: 'Publish failed', body: j.error || 'could not publish' });
      } else if (j.certification === 'certified') {
        onDone({ intent: 'success', title: `Published ${displayName.trim()}`, body: 'Auto-certified — all backend gates passed. The product is now subscribable.' });
      } else {
        onDone({ intent: 'warning', title: `Published ${displayName.trim()} (draft)`, body: `Certification blocked — set ${(j.blockers || []).join(', ') || 'the required backend'}, then re-certify to make it subscribable.` });
      }
      reset();
      setOpen(false);
    } catch {
      onDone({ intent: 'error', title: 'Publish failed', body: 'network error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Publish a product</DialogTitle>
          <DialogContent>
            <div className={s.form}>
              <Field label="Product kind" hint="One unified catalog covers all five kinds.">
                <Select value={kind} onChange={(_, d) => setKind(d.value as Kind)}>
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </Select>
              </Field>
              <Field label="Display name" required>
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="e.g. Customer 360 Agent" />
              </Field>
              <Field label="Description">
                <Textarea value={description} onChange={(_, d) => setDescription(d.value)} rows={2}
                  placeholder="What this product does and who should subscribe." />
              </Field>
              <Field label="Governance domain">
                <Input value={domain} onChange={(_, d) => setDomain(d.value)} placeholder="e.g. Sales" />
              </Field>
              <Field label="Access model" hint="Self-serve grants immediately; Request routes through the access inbox.">
                <Select value={accessModel} onChange={(_, d) => setAccessModel(d.value as 'open' | 'request')}>
                  <option value="open">Self-serve (immediate grant)</option>
                  <option value="request">Request (owner approves)</option>
                </Select>
              </Field>
              <Field label="LCU per subscription" hint="Metered to the subscriber's tenant chargeback. Leave blank for the kind default.">
                <Input value={lcu} onChange={(_, d) => setLcu(d.value)} type="number" placeholder="kind default" />
              </Field>
              <MessageBar intent="info" layout="multiline">
                <MessageBarBody>
                  Publishing runs the platform gate registry as auto-certification. A certified product is immediately subscribable; a blocked one publishes as a draft naming the exact remediation.
                </MessageBarBody>
              </MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            </DialogTrigger>
            <Button appearance="primary" disabled={busy || !displayName.trim()} onClick={() => void publish()}>
              {busy ? 'Publishing…' : 'Publish'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

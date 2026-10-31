'use client';

/**
 * Gateway detail (W1-5): Overview (telemetry, observed inventory counts, gates + Fix-its,
 * declared gaps) and Manage (the eight APIM panes, scoped with `gatewayId`).
 */
import { useState } from 'react';
import {
  Badge, Body1, Button, Caption1, MessageBar, MessageBarBody, Spinner, Subtitle2, Tab, TabList, Title3,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Apps24Regular, Box24Regular, ArrowSync16Regular, CheckmarkCircle16Regular, DismissCircle16Regular,
  Key24Regular, PersonBoard24Regular, Server24Regular, ShieldTask24Regular, Tag24Regular,
} from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import type { GatewayDoc } from '@/lib/api-gateway/registry/types';
import { ApimServicePane } from '@/lib/components/admin/apim-service-pane';
import { ApimApisPane } from '@/lib/components/admin/apim-apis-pane';
import { ApimProductsPane } from '@/lib/components/admin/apim-products-pane';
import { ApimSubscriptionsPane } from '@/lib/components/admin/apim-subscriptions-pane';
import { ApimNamedValuesPane } from '@/lib/components/admin/apim-named-values-pane';
import { ApimBackendsPane } from '@/lib/components/admin/apim-backends-pane';
import { ApimPoliciesPane } from '@/lib/components/admin/apim-policies-pane';
import { ApimDeveloperPortalPane } from '@/lib/components/admin/apim-developer-portal-pane';
import { GatewayGates } from './gateway-gates';
import { paneGatewayId, telemetryChecks } from './_lib/hub-model';
import { syncGateway, type SyncData } from './_lib/hub-api';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', minWidth: 0 },
  headText: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  name: { overflowWrap: 'anywhere' },
  badges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  tileValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: 1.1 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 },
  pass: { color: tokens.colorPaletteGreenForeground1, display: 'flex' },
  fail: { color: tokens.colorPaletteRedForeground1, display: 'flex' },
  section: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  panes: { minWidth: 0, paddingTop: tokens.spacingVerticalM },
});

const MANAGE_TABS = [
  { id: 'service', label: 'Service & SKU', icon: <Server24Regular />, itemRoutes: false },
  { id: 'apis', label: 'APIs', icon: <Apps24Regular />, itemRoutes: true },
  { id: 'products', label: 'Products', icon: <Box24Regular />, itemRoutes: true },
  { id: 'subscriptions', label: 'Subscriptions', icon: <Key24Regular />, itemRoutes: false },
  { id: 'named-values', label: 'Named values', icon: <Tag24Regular />, itemRoutes: true },
  { id: 'backends', label: 'Backends', icon: <Server24Regular />, itemRoutes: false },
  { id: 'policies', label: 'Policies', icon: <ShieldTask24Regular />, itemRoutes: true },
  { id: 'developer-portal', label: 'Developer portal', icon: <PersonBoard24Regular />, itemRoutes: false },
] as const;
type ManageTab = (typeof MANAGE_TABS)[number]['id'];

/** The eight panes, scoped to one gateway. Exported for the render tests. */
export function ManagePanes({ gatewayId, tab }: { gatewayId?: string; tab: ManageTab }) {
  const key = gatewayId ?? 'default';
  switch (tab) {
    case 'service': return <ApimServicePane key={key} gatewayId={gatewayId} />;
    case 'apis': return <ApimApisPane key={key} gatewayId={gatewayId} />;
    case 'products': return <ApimProductsPane key={key} gatewayId={gatewayId} />;
    case 'subscriptions': return <ApimSubscriptionsPane key={key} gatewayId={gatewayId} />;
    case 'named-values': return <ApimNamedValuesPane key={key} />;
    case 'backends': return <ApimBackendsPane key={key} gatewayId={gatewayId} />;
    case 'policies': return <ApimPoliciesPane key={key} gatewayId={gatewayId} />;
    case 'developer-portal': return <ApimDeveloperPortalPane key={key} gatewayId={gatewayId} />;
  }
}

function Count({ label, value, hint }: { label: string; value: number | undefined; hint?: string }) {
  const s = useStyles();
  return (
    <div className={s.tile}>
      <Caption1 className={s.muted}>{label}</Caption1>
      <span className={s.tileValue}>{value === undefined ? '-' : value}</span>
      {hint && <Caption1 className={s.muted}>{hint}</Caption1>}
    </div>
  );
}

export function GatewayDetail({ gateway, onChanged, onRemove }: {
  gateway: GatewayDoc;
  onChanged: () => void;
  onRemove?: (g: GatewayDoc) => void;
}) {
  const s = useStyles();
  const [view, setView] = useState<'overview' | 'manage'>('overview');
  const [manageTab, setManageTab] = useState<ManageTab>('service');
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<SyncData | null>(null);

  const inv = gateway.inventory;
  const neverSynced = !inv.lastSyncAt;
  const paneId = paneGatewayId(gateway);
  const active = MANAGE_TABS.find((t) => t.id === manageTab)!;

  const doSync = async () => {
    setSyncing(true);
    setSyncErr(null);
    const r = await syncGateway(gateway.id);
    setSyncing(false);
    if (!r.ok) { setSyncErr(r.error ?? `Sync failed (HTTP ${r.status}).`); return; }
    setLastSync(r.data ?? null);
    onChanged();
  };

  return (
    <div className={s.root} data-testid="gateway-detail">
      <div className={s.head}>
        <div className={s.headText}>
          <Title3 className={s.name}>{gateway.displayName}</Title3>
          <Caption1 className={s.muted}>{gateway.resourceId}</Caption1>
          <div className={s.badges}>
            <Badge appearance="tint">{gateway.cloud}</Badge>
            <Badge appearance="outline">{gateway.ownedBy === 'deploy' ? 'deploy-owned' : 'registered'}</Badge>
            <Badge appearance="outline">{gateway.managementMode}</Badge>
            <Badge appearance="outline">{gateway.environmentKey ?? 'unclassified'}</Badge>
          </div>
        </div>
        <Button
          appearance="primary"
          icon={syncing ? <Spinner size="tiny" /> : <ArrowSync16Regular />}
          disabled={syncing || !gateway.access.canRead}
          onClick={doSync}
        >
          {syncing ? 'Syncing...' : neverSynced ? 'Sync inventory' : 'Re-sync inventory'}
        </Button>
        {onRemove && gateway.ownedBy !== 'deploy' && (
          <Button appearance="subtle" onClick={() => onRemove(gateway)}>Remove</Button>
        )}
      </div>

      {syncErr && (
        <MessageBar intent="warning"><MessageBarBody>{syncErr}</MessageBarBody></MessageBar>
      )}

      <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as 'overview' | 'manage')}>
        <Tab value="overview">Overview</Tab>
        <Tab value="manage">Manage</Tab>
      </TabList>

      {view === 'overview' && (
        <>
          <div>
            <div className={s.section}>
              <Subtitle2>Observed inventory</Subtitle2>
              <LearnPopover
                title="Observed inventory"
                content="Counts come from the last inventory sync of this gateway, read from the API Management control plane. They are observations, not edits: nothing here changes the gateway."
                tips={['Endpoints are API operations, counted during a sync', 'A gateway that has never synced shows dashes, not zeros', 'Policy text and keys are never stored']}
                learnMoreHref="https://learn.microsoft.com/azure/api-management/api-management-key-concepts"
              />
            </div>
            <TileGrid minTileWidth={140}>
              <Count label="APIs" value={neverSynced ? undefined : inv.apis} />
              <Count label="Endpoints" value={lastSync?.counts.operation} hint={lastSync ? undefined : 'counted on sync'} />
              <Count label="Products" value={neverSynced ? undefined : inv.products} />
              <Count label="Subscriptions" value={neverSynced ? undefined : inv.subscriptions} />
              <Count label="Backends" value={neverSynced ? undefined : inv.backends} />
              <Count label="MCP servers" value={neverSynced ? undefined : inv.mcpServers} />
            </TileGrid>
            <Caption1 className={s.muted}>
              {neverSynced
                ? 'Not synced yet. Use Sync inventory to read this gateway.'
                : `Last sync ${inv.lastSyncAt}${inv.partialTypes.length ? ` - partial: ${inv.partialTypes.join(', ')}` : ''}`}
            </Caption1>
          </div>

          <div className={s.card} data-testid="telemetry-card">
            <div className={s.section}>
              <Subtitle2>Telemetry</Subtitle2>
              <LearnPopover
                title="Telemetry checks"
                content="Only checks that run today are listed. Logger and diagnostic-routing checks are not implemented yet and are deliberately not shown as passing."
                tips={['Read access comes from the registration preflight', 'Usage and cost telemetry arrive with the rollup worker']}
                learnMoreHref="https://learn.microsoft.com/azure/api-management/api-management-howto-use-azure-monitor"
              />
            </div>
            {telemetryChecks(gateway).map((c) => (
              <div key={c.id} className={s.checkRow}>
                <span className={c.state === 'pass' ? s.pass : s.fail}>
                  {c.state === 'pass' ? <CheckmarkCircle16Regular /> : <DismissCircle16Regular />}
                </span>
                <Body1>{c.label}</Body1>
                <Caption1 className={s.muted}>{c.detail}</Caption1>
              </div>
            ))}
          </div>

          <div>
            <div className={s.section}>
              <Subtitle2>Gates</Subtitle2>
              <LearnPopover
                title="Gateway gates"
                content="A gate is something that limits what Loom can do with this gateway. Each one with an action has a Fix it button that shows the exact role, scope and command."
                tips={['Declared gaps have no button: there is nothing to fix, only a substitute and an owner']}
                learnMoreHref="https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal"
              />
            </div>
            <GatewayGates gateway={gateway} />
          </div>
        </>
      )}

      {view === 'manage' && (
        <div>
          <TabList selectedValue={manageTab} onTabSelect={(_, d) => setManageTab(d.value as ManageTab)}>
            {MANAGE_TABS.map((t) => <Tab key={t.id} value={t.id} icon={t.icon}>{t.label}</Tab>)}
          </TabList>
          <div className={s.panes}>
            {paneId && active.itemRoutes ? (
              <MessageBar intent="info" data-testid="manage-unscoped">
                <MessageBarBody>
                  {active.label} for a registered gateway is not available yet: this pane is not
                  gateway-scoped, so it would show the deploy-owned gateway&apos;s data. Service &amp; SKU,
                  Subscriptions, Backends and Developer portal are scoped.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <ManagePanes gatewayId={paneId} tab={manageTab} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

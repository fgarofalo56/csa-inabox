'use client';

/**
 * API Gateway hub body (W1-5): Overview, Gateways (list + detail in a SplitPane) and MCP servers.
 * Settings (Environments / Findings / Runtime) lives at /admin/api-gateway/settings (W1-4) and is linked.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, MessageBar, MessageBarBody, Spinner, Subtitle2, Tab, TabList,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Add16Regular, BotSparkle16Regular, Globe24Regular, Settings16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { SplitPane } from '@/lib/components/shared/split-pane';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { McpServersPanel } from '@/lib/components/admin/mcp-servers-panel';
import { IqMcpPanel } from '@/lib/components/admin/iq-mcp-panel';
import type { GatewayDoc } from '@/lib/api-gateway/registry/types';
import { GatewayDetail } from './gateway-detail';
import { RegisterGatewayDialog } from './register-dialog';
import { listGateways, removeGateway, type GatewayList } from './_lib/hub-api';
import { gatesFor } from './_lib/hub-model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  lede: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalM, minWidth: 0 },
  ledeIcon: {
    flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: tokens.spacingHorizontalXXXL, height: tokens.spacingHorizontalXXXL,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
    boxShadow: tokens.shadow4,
  },
  ledeText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  muted: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
    ':hover': { boxShadow: tokens.shadow16 },
  },
  tileValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, lineHeight: 1.1 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, paddingRight: tokens.spacingHorizontalS },
  row: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, textAlign: 'left',
    padding: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid transparent`,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  rowActive: { backgroundColor: tokens.colorBrandBackground2, borderTopColor: tokens.colorBrandStroke1, borderRightColor: tokens.colorBrandStroke1, borderBottomColor: tokens.colorBrandStroke1, borderLeftColor: tokens.colorBrandStroke1 },
  rowName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, fontWeight: tokens.fontWeightSemibold },
  rowBadges: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  detail: { minWidth: 0, paddingLeft: tokens.spacingHorizontalM },
  loading: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL },
});

type HubTab = 'overview' | 'gateways' | 'mcp';

function openCopilot() {
  window.dispatchEvent(new Event('csaloom:open-copilot'));
}

export function Hub() {
  const s = useStyles();
  const [tab, setTab] = useState<HubTab>('overview');
  const [list, setList] = useState<GatewayList | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'mcp' || t === 'gateways') setTab(t);
  }, []);

  const reload = useCallback(async () => {
    const r = await listGateways();
    if (!r.ok || !r.data) { setLoadErr(r.error ?? `Could not load gateways (HTTP ${r.status}).`); setList({ gateways: [], deployRegistration: { ok: true } }); return; }
    setLoadErr(null);
    setList(r.data);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const gateways = useMemo(() => list?.gateways ?? [], [list]);
  const current = gateways.find((g) => g.id === selected) ?? gateways[0] ?? null;

  const stats = useMemo(() => ({
    total: gateways.length,
    withGates: gateways.filter((g) => gatesFor(g).some((i) => i.fixit)).length,
    unsynced: gateways.filter((g) => !g.inventory.lastSyncAt).length,
  }), [gateways]);

  const onRemove = async (g: GatewayDoc) => {
    const r = await removeGateway(g.id);
    if (!r.ok) { setLoadErr(r.error ?? `Could not remove ${g.displayName}.`); return; }
    setSelected(null);
    await reload();
  };

  return (
    <div className={s.root}>
      <div className={s.lede}>
        <span className={s.ledeIcon}><Globe24Regular /></span>
        <div className={s.ledeText}>
          <Subtitle2>API Gateway</Subtitle2>
          <Body1 className={s.muted}>
            Register the API Management gateways Loom fronts, see what each one holds, and manage them from one place.
          </Body1>
        </div>
        <div className={s.toolbar}>
          <Button appearance="primary" icon={<Add16Regular />} onClick={() => setRegisterOpen(true)}>Register gateway</Button>
          <Button as="a" href="/admin/api-gateway/settings" icon={<Settings16Regular />}>Settings</Button>
          <Button appearance="subtle" icon={<BotSparkle16Regular />} onClick={openCopilot}>Ask Copilot</Button>
        </div>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as HubTab)}>
        <Tab value="overview">Overview</Tab>
        <Tab value="gateways">Gateways</Tab>
        <Tab value="mcp">MCP servers</Tab>
      </TabList>

      {loadErr && <MessageBar intent="warning"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
      {list && !list.deployRegistration.ok && (
        <MessageBar intent="warning" data-testid="deploy-registration-error">
          <MessageBarBody>
            The deploy-owned gateway could not be registered: {list.deployRegistration.error ?? list.deployRegistration.code}
          </MessageBarBody>
        </MessageBar>
      )}

      {tab !== 'mcp' && list === null && <div className={s.loading}><Spinner label="Loading gateways..." /></div>}

      {tab === 'overview' && list && (
        <>
          <div>
            <Subtitle2>Fleet</Subtitle2>
            <LearnPopover
              title="API Gateway fleet"
              content="Every API Management service Loom knows about. The deploy-owned gateway registers itself; others are registered by resource id after an access check."
              tips={['Open a gateway to see its inventory, gates and Manage panes', 'Settings holds environment classification and findings']}
              learnMoreHref="https://learn.microsoft.com/azure/api-management/api-management-key-concepts"
            />
          </div>
          <TileGrid minTileWidth={180}>
            <div className={s.tile}><Caption1 className={s.muted}>Gateways</Caption1><span className={s.tileValue}>{stats.total}</span></div>
            <div className={s.tile}><Caption1 className={s.muted}>With an open gate</Caption1><span className={s.tileValue}>{stats.withGates}</span></div>
            <div className={s.tile}><Caption1 className={s.muted}>Not synced yet</Caption1><span className={s.tileValue}>{stats.unsynced}</span></div>
          </TileGrid>
          {stats.total === 0 && (
            <EmptyState
              icon={<Globe24Regular />}
              title="No gateways registered"
              body="Register an API Management service by its resource id. Loom checks access, then reads its inventory for you."
              primaryAction={{ label: 'Register gateway', onClick: () => setRegisterOpen(true) }}
            />
          )}
        </>
      )}

      {tab === 'gateways' && list && (
        gateways.length === 0 ? (
          <EmptyState
            icon={<Globe24Regular />}
            title="No gateways registered"
            body="Register an API Management service by its resource id. Loom checks access, then reads its inventory for you."
            primaryAction={{ label: 'Register gateway', onClick: () => setRegisterOpen(true) }}
          />
        ) : (
          <SplitPane direction="horizontal" defaultSize={280} minSize={200} storageKey="api-gateway-hub-list" dividerLabel="Resize gateway list">
            <div className={s.list} role="list" aria-label="Gateways">
              {gateways.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="listitem"
                  className={mergeClasses(s.row, current?.id === g.id && s.rowActive)}
                  onClick={() => setSelected(g.id)}
                >
                  <span className={s.rowName}>{g.displayName}</span>
                  <span className={s.rowBadges}>
                    <Badge size="small" appearance="tint">{g.cloud}</Badge>
                    {g.ownedBy === 'deploy' && <Badge size="small" appearance="outline">deploy-owned</Badge>}
                  </span>
                </button>
              ))}
            </div>
            <div className={s.detail}>
              {current && <GatewayDetail key={current.id} gateway={current} onChanged={reload} onRemove={onRemove} />}
            </div>
          </SplitPane>
        )
      )}

      {tab === 'mcp' && (
        <>
          <Body1 className={s.muted}>
            Browse, deploy and connect Model Context Protocol servers Loom Copilot can call. (Previously /admin/mcp-servers.)
          </Body1>
          <McpServersPanel />
          <IqMcpPanel />
        </>
      )}

      <RegisterGatewayDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onRegistered={(gw) => {
          setRegisterOpen(false);
          setSelected(gw.id);
          setTab('gateways');
          void reload();
        }}
      />
    </div>
  );
}

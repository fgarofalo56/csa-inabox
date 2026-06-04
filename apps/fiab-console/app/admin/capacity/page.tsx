'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Badge, Spinner, Dropdown, Option,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { ScaleManagePanel } from '@/lib/components/admin/scale-manage-panel';

function portalUrl(id: string): string {
  // Azure portal deep-link to the resource Overview blade.
  return `https://portal.azure.com/#@/resource${id}/overview`;
}

/**
 * /admin/capacity — Live inventory of Azure resources Loom orchestrates.
 *
 * Reads /api/admin/azure-resources, which calls ARM with the BFF's UAMI
 * token. No hardcoded names, costs, or "Healthy" badges — every row is
 * an actual resource in your Loom resource groups. Cost + utilization are
 * deliberately omitted (those need Cost Management + Azure Monitor, a
 * separate piece of work) and the page surfaces that honestly.
 */

interface AzureRes {
  id: string;
  name: string;
  type: string;
  location: string;
  resourceGroup: string;
  sku?: string;
  kind?: string;
  provisioningState?: string;
}

interface Response {
  ok: boolean;
  subscription?: string;
  resourceGroups?: string[];
  totalResources?: number;
  byProvider?: Record<string, number>;
  resources?: AzureRes[];
  errors?: string[];
  error?: string;
  hint?: string;
}

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: tokens.spacingVerticalL },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  stat: {
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  statLabel: {
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600,
  },
  statValue: { fontSize: '22px', fontWeight: 700, marginTop: '4px', lineHeight: 1.1 },
  resName: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  resIcon: {
    flexShrink: 0, width: '28px', height: '28px', borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  portalLink: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px' },
});

/** Map an ARM resource type to an item-type slug we have a visual for. */
function resourceTypeToSlug(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('sql/servers/databases')) return 'azure-sql-database';
  if (t.includes('sql/servers')) return 'azure-sql-server';
  if (t.includes('documentdb') || t.includes('cosmos')) return 'azure-cosmos-account';
  if (t.includes('eventhub')) return 'azure-eventhub';
  if (t.includes('datafactory')) return 'adf-pipeline';
  if (t.includes('databricks')) return 'databricks-cluster';
  if (t.includes('synapse')) return 'synapse-pipeline';
  if (t.includes('kusto')) return 'kql-database';
  if (t.includes('search')) return 'ai-search-index';
  if (t.includes('apimanagement')) return 'apim-api';
  if (t.includes('streamanalytics')) return 'stream-analytics-job';
  return 'environment';
}

export default function CapacityPage() {
  const styles = useStyles();
  const [data, setData] = useState<Response | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => {
    // Timeout so a slow/hung ARM enumeration can't leave the page spinning
    // forever (data===null). Every path resolves data or unauth.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    fetch('/api/admin/azure-resources', { signal: ctrl.signal, cache: 'no-store' }).then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); return null; }
      return r.json();
    }).then(d => { if (d) setData(d); })
      .catch((e) => setData({ ok: false, error: e?.name === 'AbortError' ? 'Azure resource query timed out (15s). Reload to retry.' : String(e) }))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  const visibleResources = useMemo(() => {
    const all = data?.resources || [];
    const f = q.toLowerCase().trim();
    return all.filter((r) => {
      if (provider && !r.type.toLowerCase().includes(provider.toLowerCase())) return false;
      if (!f) return true;
      return (
        r.name.toLowerCase().includes(f) ||
        r.type.toLowerCase().includes(f) ||
        r.resourceGroup.toLowerCase().includes(f) ||
        (r.sku || '').toLowerCase().includes(f) ||
        (r.kind || '').toLowerCase().includes(f)
      );
    });
  }, [data, q, provider]);

  const columns: LoomColumn<AzureRes>[] = useMemo(() => [
    {
      key: 'name', label: 'Name', width: 260,
      render: (r) => {
        const v = itemVisual(resourceTypeToSlug(r.type));
        const Icon = v.icon;
        return (
          <span className={styles.resName}>
            <span className={styles.resIcon} style={{ backgroundColor: `${v.color}1f`, color: v.color }} aria-hidden>
              <Icon style={{ width: 18, height: 18, color: v.color }} />
            </span>
            <strong title={r.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</strong>
          </span>
        );
      },
    },
    { key: 'type', label: 'Type', width: 220, getValue: (r) => r.type.replace('Microsoft.', ''),
      render: (r) => <Caption1>{r.type.replace('Microsoft.', '')}</Caption1> },
    { key: 'location', label: 'Region', width: 130, render: (r) => <Caption1>{r.location}</Caption1> },
    { key: 'resourceGroup', label: 'Resource group', width: 200, render: (r) => <Caption1>{r.resourceGroup}</Caption1> },
    { key: 'sku', label: 'SKU / Kind', width: 160, getValue: (r) => r.sku || r.kind || '',
      render: (r) => <Caption1>{r.sku || r.kind || '—'}</Caption1> },
    {
      key: 'provisioningState', label: 'State', width: 130,
      getValue: (r) => r.provisioningState || '',
      render: (r) => r.provisioningState
        ? <Badge appearance="outline" color={r.provisioningState === 'Succeeded' ? 'success' : 'warning'}>{r.provisioningState}</Badge>
        : <Caption1>—</Caption1>,
    },
    {
      key: 'portal', label: 'Portal', width: 130, sortable: false, filterable: false,
      render: (r) => (
        <a href={portalUrl(r.id)} target="_blank" rel="noreferrer" className={styles.portalLink}
           onClick={(e) => e.stopPropagation()}>
          Azure portal <Open16Regular />
        </a>
      ),
    },
  ], [styles]);

  return (
    <AdminShell sectionTitle="Capacity & compute">
      <Body1 className={styles.intro}>
        Underlying Azure services Loom orchestrates. Live inventory pulled from
        Azure Resource Manager — no hardcoded counts. Cost + utilization
        require Cost Management and Azure Monitor integration; flagged as
        backlog below.
      </Body1>

      {unauth && <SignInRequired subject="Azure resource inventory" />}

      {!unauth && data === null && (
        <Section><Spinner label="Querying ARM…" /></Section>
      )}

      {data && !data.ok && (
        <MessageBar intent="warning">
          <MessageBarTitle>Inventory unavailable</MessageBarTitle>
          <MessageBarBody>
            {data.error}{data.hint ? ` — ${data.hint}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {data && data.ok && (
        <>
          <Section title="Inventory summary">
            <div className={styles.stats}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Total resources</div>
                <div className={styles.statValue}>{data.totalResources}</div>
              </div>
              {Object.entries(data.byProvider || {}).slice(0, 5).map(([p, n]) => (
                <div className={styles.stat} key={p}>
                  <div className={styles.statLabel}>{p}</div>
                  <div className={styles.statValue}>{n}</div>
                </div>
              ))}
            </div>
          </Section>

          {data.errors && data.errors.length > 0 && (
            <MessageBar intent="warning" style={{ marginBottom: 16 }}>
              <MessageBarBody>
                Partial result — could not list some RGs: {data.errors.join(' · ')}
              </MessageBarBody>
            </MessageBar>
          )}

          <Section
            title="Scale & manage"
            actions={
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Change SKUs, pause / resume, scale — live Azure-native compute
              </Caption1>
            }
          >
            <ScaleManagePanel />
          </Section>

          <Section
            title="Resources"
            actions={
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                {visibleResources.length} of {data.totalResources}
              </Caption1>
            }
          >
            <Toolbar
              search={q}
              onSearch={setQ}
              searchPlaceholder="Filter by name, type, RG, SKU…"
              actions={
                <Dropdown
                  value={provider || 'All providers'}
                  selectedOptions={[provider]}
                  onOptionSelect={(_, d) => setProvider(d.optionValue ?? '')}
                  style={{ minWidth: 200 }}
                >
                  <Option value="">All providers</Option>
                  {Object.keys(data.byProvider || {}).map((p) => <Option key={p} value={p}>{p}</Option>)}
                </Dropdown>
              }
            />
            <LoomDataTable
              columns={columns}
              rows={visibleResources}
              getRowId={(r) => r.id}
              empty="No resources match the current filters."
              ariaLabel="Azure resources"
            />
          </Section>

          <MessageBar intent="info">
            <MessageBarTitle>Cost &amp; utilization deferred</MessageBarTitle>
            <MessageBarBody>
              Monthly cost requires Azure Cost Management API
              (Microsoft.CostManagement). DBU / CPU / req-rate utilization
              requires Azure Monitor metrics per resource. Both are tracked
              for v3.5 — not surfaced here today to avoid showing fake
              numbers (per .claude/rules/no-vaporware.md).
            </MessageBarBody>
          </MessageBar>
        </>
      )}
    </AdminShell>
  );
}

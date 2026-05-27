'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Badge, Spinner, Input, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Open16Regular, Search24Regular } from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';

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
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55, marginBottom: '16px' },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '12px',
    marginBottom: '20px',
  },
  stat: {
    paddingTop: '14px', paddingRight: '14px', paddingBottom: '14px', paddingLeft: '14px',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statLabel: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600 },
  statValue: { fontSize: '22px', fontWeight: 700, marginTop: '4px', lineHeight: 1.1 },
});

export default function CapacityPage() {
  const styles = useStyles();
  const [data, setData] = useState<Response | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => {
    fetch('/api/admin/azure-resources').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); return null; }
      return r.json();
    }).then(d => { if (d) setData(d); }).catch(e => setData({ ok: false, error: String(e) }));
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

  return (
    <AdminShell sectionTitle="Capacity & compute">
      <Body1 className={styles.intro}>
        Underlying Azure services Loom orchestrates. Live inventory pulled from
        Azure Resource Manager — no hardcoded counts. Cost + utilization
        require Cost Management and Azure Monitor integration; flagged as
        backlog below.
      </Body1>

      {unauth && <SignInRequired subject="Azure resource inventory" />}

      {!unauth && data === null && <Spinner label="Querying ARM…" />}

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

          {data.errors && data.errors.length > 0 && (
            <MessageBar intent="warning" style={{ marginBottom: 12 }}>
              <MessageBarBody>
                Partial result — could not list some RGs: {data.errors.join(' · ')}
              </MessageBarBody>
            </MessageBar>
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <Input
              contentBefore={<Search24Regular />}
              placeholder="Filter by name, type, RG, SKU…"
              value={q}
              onChange={(_, d) => setQ(d.value)}
              style={{ flex: 1, maxWidth: 360 }}
            />
            <Dropdown
              value={provider || 'All providers'}
              selectedOptions={[provider]}
              onOptionSelect={(_, d) => setProvider(d.optionValue ?? '')}
              style={{ minWidth: 200 }}
            >
              <Option value="">All providers</Option>
              {Object.keys(data.byProvider || {}).map((p) => <Option key={p} value={p}>{p}</Option>)}
            </Dropdown>
            <Caption1 style={{ marginLeft: 'auto', color: tokens.colorNeutralForeground3 }}>
              {visibleResources.length} of {data.totalResources}
            </Caption1>
          </div>

          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Region</TableHeaderCell>
                <TableHeaderCell>Resource group</TableHeaderCell>
                <TableHeaderCell>SKU / Kind</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleResources.map(r => (
                <TableRow key={r.id}>
                  <TableCell><strong>{r.name}</strong></TableCell>
                  <TableCell><Caption1>{r.type.replace('Microsoft.', '')}</Caption1></TableCell>
                  <TableCell><Caption1>{r.location}</Caption1></TableCell>
                  <TableCell><Caption1>{r.resourceGroup}</Caption1></TableCell>
                  <TableCell><Caption1>{r.sku || r.kind || '—'}</Caption1></TableCell>
                  <TableCell>
                    {r.provisioningState
                      ? <Badge appearance="outline"
                          color={r.provisioningState === 'Succeeded' ? 'success' : 'warning'}>
                          {r.provisioningState}
                        </Badge>
                      : <Caption1>—</Caption1>}
                  </TableCell>
                  <TableCell>
                    <a
                      href={portalUrl(r.id)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                    >
                      Azure portal <Open16Regular />
                    </a>
                  </TableCell>
                </TableRow>
              ))}
              {visibleResources.length === 0 && (
                <TableRow><TableCell colSpan={7}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No resources match the current filters.</Caption1>
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>

          <MessageBar intent="info" style={{ marginTop: 16 }}>
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

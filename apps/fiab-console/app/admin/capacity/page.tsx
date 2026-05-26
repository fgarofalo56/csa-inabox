'use client';

import { useEffect, useState } from 'react';
import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { SignInRequired } from '@/lib/components/sign-in-required';

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

  useEffect(() => {
    fetch('/api/admin/azure-resources').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); return null; }
      return r.json();
    }).then(d => { if (d) setData(d); }).catch(e => setData({ ok: false, error: String(e) }));
  }, []);

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

          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Region</TableHeaderCell>
                <TableHeaderCell>Resource group</TableHeaderCell>
                <TableHeaderCell>SKU / Kind</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.resources || []).map(r => (
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
                </TableRow>
              ))}
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

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, Button, Badge,
  Caption1, Dialog, DialogTrigger, DialogSurface, DialogContent, DialogBody, DialogTitle,
} from '@fluentui/react-components';
import { CheckmarkCircle24Regular, DismissCircle24Regular } from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ApimSubscriptionSummary } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

export function ApimSubscriptionsPane() {
  const [subscriptions, setSubscriptions] = useState<ApimSubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selectedSub, setSelectedSub] = useState<ApimSubscriptionSummary | null>(null);
  const [showKeysDialog, setShowKeysDialog] = useState(false);
  const [keys, setKeys] = useState<{ primaryKey?: string; secondaryKey?: string } | null>(null);

  useEffect(() => {
    apimFetchJson('/api/apim/subscriptions')
      .then((d) => {
        if (d.ok && Array.isArray(d.subscriptions)) {
          setSubscriptions(d.subscriptions as ApimSubscriptionSummary[]);
        } else {
          setError((d.error as string) || 'Failed to load subscriptions');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  const visibleSubs = useMemo(() => {
    if (!q.trim()) return subscriptions;
    const f = q.toLowerCase();
    return subscriptions.filter((s) =>
      (s.displayName || '').toLowerCase().includes(f) ||
      (s.scope || '').toLowerCase().includes(f)
    );
  }, [subscriptions, q]);

  async function handleApprove(sub: ApimSubscriptionSummary) {
    try {
      const d = await apimFetchJson(`/api/apim/subscriptions/${encodeURIComponent(sub.name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'active' }),
      });
      if (d.ok) {
        setSubscriptions((prev) =>
          prev.map((s) => (s.name === sub.name ? { ...s, state: 'active' } : s))
        );
      } else {
        setError((d.error as string) || 'Approve failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRejectOrSuspend(sub: ApimSubscriptionSummary) {
    try {
      const d = await apimFetchJson(`/api/apim/subscriptions/${encodeURIComponent(sub.name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'suspended' }),
      });
      if (d.ok) {
        setSubscriptions((prev) =>
          prev.map((s) => (s.name === sub.name ? { ...s, state: 'suspended' } : s))
        );
      } else {
        setError((d.error as string) || 'Suspend failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleShowKeys(sub: ApimSubscriptionSummary) {
    setSelectedSub(sub);
    setShowKeysDialog(true);
    setKeys(null);
    try {
      const d = await apimFetchJson(`/api/apim/subscriptions/${encodeURIComponent(sub.name)}/keys`);
      if (d.ok) {
        setKeys({ primaryKey: d.primaryKey as string | undefined, secondaryKey: d.secondaryKey as string | undefined });
      } else {
        setKeys({ primaryKey: undefined, secondaryKey: undefined });
      }
    } catch (e) {
      console.error('Load keys failed:', e);
      setKeys({ primaryKey: undefined, secondaryKey: undefined });
    }
  }

  const columns: LoomColumn<ApimSubscriptionSummary>[] = useMemo(() => [
    {
      key: 'displayName',
      label: 'Subscription',
      width: 200,
      render: (s) => (
        <div>
          <strong>{s.displayName}</strong>
          <Caption1 style={{ display: 'block', marginTop: '2px', color: tokens.colorNeutralForeground3 }}>{s.name}</Caption1>
        </div>
      ),
    },
    {
      key: 'scope',
      label: 'Scope',
      width: 200,
      render: (s) => <Caption1>{s.scope?.split('/').pop() || '—'}</Caption1>,
    },
    {
      key: 'state',
      label: 'State',
      width: 120,
      render: (s) => {
        const color = s.state === 'active' ? 'success' : s.state === 'submitted' ? 'warning' : 'subtle';
        return <Badge appearance="outline" color={color}>{s.state}</Badge>;
      },
    },
    {
      key: 'createdDate',
      label: 'Created',
      width: 140,
      render: (s) => <Caption1>{s.createdDate ? new Date(s.createdDate).toLocaleDateString() : '—'}</Caption1>,
    },
    {
      key: 'actions',
      label: 'Actions',
      width: 200,
      sortable: false,
      render: (s) => (
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
          {s.state === 'submitted' && (
            <Button
              size="small"
              icon={<CheckmarkCircle24Regular />}
              onClick={() => handleApprove(s)}
              title="Approve subscription"
            />
          )}
          {(s.state === 'submitted' || s.state === 'active') && (
            <Button
              size="small"
              icon={<DismissCircle24Regular />}
              onClick={() => handleRejectOrSuspend(s)}
              title={s.state === 'submitted' ? 'Reject' : 'Suspend'}
            />
          )}
          <Button size="small" onClick={() => handleShowKeys(s)}>
            Keys
          </Button>
        </div>
      ),
    },
  ], []);

  if (loading) return <Section><Spinner label="Loading subscriptions..." /></Section>;
  if (error) {
    return (
      <Section>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </Section>
    );
  }

  return (
    <>
      <Section title="Subscriptions">
        <Toolbar
          search={q}
          onSearch={setQ}
          searchPlaceholder="Filter by name, scope..."
        />
        <LoomDataTable
          columns={columns}
          rows={visibleSubs}
          getRowId={(s) => s.name}
          empty="No subscriptions."
          ariaLabel="Consumer subscriptions"
        />
      </Section>

      {showKeysDialog && selectedSub && (
        <Dialog open={showKeysDialog} onOpenChange={(_, d) => setShowKeysDialog(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>{selectedSub.displayName} — API Keys</DialogTitle>
              <DialogContent>
              {keys ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                  <div>
                    <Caption1 style={{ fontWeight: 600 }}>Primary key</Caption1>
                    <code style={{
                      display: 'block',
                      marginTop: '8px',
                      padding: '8px',
                      backgroundColor: tokens.colorNeutralBackground2,
                      borderRadius: tokens.borderRadiusMedium,
                      overflow: 'auto',
                      maxWidth: '400px',
                    }}>
                      {keys.primaryKey || '(not set)'}
                    </code>
                  </div>
                  <div>
                    <Caption1 style={{ fontWeight: 600 }}>Secondary key</Caption1>
                    <code style={{
                      display: 'block',
                      marginTop: '8px',
                      padding: '8px',
                      backgroundColor: tokens.colorNeutralBackground2,
                      borderRadius: tokens.borderRadiusMedium,
                      overflow: 'auto',
                      maxWidth: '400px',
                    }}>
                      {keys.secondaryKey || '(not set)'}
                    </code>
                  </div>
                </div>
              ) : (
                <Spinner label="Loading keys..." />
              )}
              </DialogContent>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}

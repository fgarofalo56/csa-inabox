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

export function ApimSubscriptionsPane() {
  const [subscriptions, setSubscriptions] = useState<ApimSubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [selectedSub, setSelectedSub] = useState<ApimSubscriptionSummary | null>(null);
  const [showKeysDialog, setShowKeysDialog] = useState(false);
  const [keys, setKeys] = useState<{ primaryKey?: string; secondaryKey?: string } | null>(null);

  useEffect(() => {
    fetch('/api/items/apim-subscriptions')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Array.isArray(d.subscriptions)) {
          setSubscriptions(d.subscriptions);
        } else {
          setError(d.error || 'Failed to load subscriptions');
        }
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
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
      const res = await fetch(`/api/items/apim-subscriptions/${sub.name}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'active' }),
      });
      const d = await res.json();
      if (d.ok) {
        setSubscriptions((prev) =>
          prev.map((s) => (s.name === sub.name ? { ...s, state: 'active' } : s))
        );
      }
    } catch (e) {
      console.error('Approve failed:', e);
    }
  }

  async function handleRejectOrSuspend(sub: ApimSubscriptionSummary) {
    try {
      const res = await fetch(`/api/items/apim-subscriptions/${sub.name}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'suspended' }),
      });
      const d = await res.json();
      if (d.ok) {
        setSubscriptions((prev) =>
          prev.map((s) => (s.name === sub.name ? { ...s, state: 'suspended' } : s))
        );
      }
    } catch (e) {
      console.error('Suspend failed:', e);
    }
  }

  async function handleShowKeys(sub: ApimSubscriptionSummary) {
    setSelectedSub(sub);
    setShowKeysDialog(true);
    try {
      const res = await fetch(`/api/items/apim-subscriptions/${sub.name}/keys`);
      const d = await res.json();
      if (d.ok) {
        setKeys({ primaryKey: d.primaryKey, secondaryKey: d.secondaryKey });
      }
    } catch (e) {
      console.error('Load keys failed:', e);
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

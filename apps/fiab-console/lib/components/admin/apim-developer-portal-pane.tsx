'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Spinner, MessageBar, MessageBarBody, MessageBarTitle, Button,
  Badge, Caption1, Body1, Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions, Field, Input,
} from '@fluentui/react-components';
import { Open24Regular, ArrowSync24Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import type { ApimPortalRevision } from '@/lib/azure/apim-client';
import { apimFetchJson } from './apim-pane-fetch';

const useStyles = makeStyles({
  urls: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  urlCard: {
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  urlLabel: { fontSize: tokens.fontSizeBase100, textTransform: 'uppercase', letterSpacing: '0.06em', color: tokens.colorNeutralForeground3, fontWeight: 600 },
  urlValue: { wordBreak: 'break-all' },
});

interface PortalData {
  developerPortalUrl?: string;
  portalUrl?: string;
  managementApiUrl?: string;
  developerPortalStatus?: string;
  provisioningState?: string;
  revisions: ApimPortalRevision[];
}

function statusColor(s?: string): 'success' | 'warning' | 'danger' | 'subtle' {
  const v = (s || '').toLowerCase();
  if (v === 'completed' || v === 'enabled') return 'success';
  if (v === 'publishing' || v === 'pending') return 'warning';
  if (v === 'failed') return 'danger';
  return 'subtle';
}

export function ApimDeveloperPortalPane() {
  const styles = useStyles();
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishDesc, setPublishDesc] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    apimFetchJson('/api/apim/developer-portal')
      .then((d) => {
        if (d.ok) {
          setData({
            developerPortalUrl: d.developerPortalUrl as string | undefined,
            portalUrl: d.portalUrl as string | undefined,
            managementApiUrl: d.managementApiUrl as string | undefined,
            developerPortalStatus: d.developerPortalStatus as string | undefined,
            provisioningState: d.provisioningState as string | undefined,
            revisions: Array.isArray(d.revisions) ? (d.revisions as ApimPortalRevision[]) : [],
          });
        } else {
          setError((d.error as string) || 'Failed to load developer portal info.');
        }
        setLoading(false);
      })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setLoading(false); });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function handlePublish() {
    setPublishing(true);
    setError(null);
    setNote(null);
    try {
      const d = await apimFetchJson('/api/apim/developer-portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: publishDesc.trim() || undefined, isCurrent: true }),
      });
      if (d.ok) {
        setPublishOpen(false);
        setPublishDesc('');
        setNote('Publish started. The developer portal pipeline runs asynchronously — refresh in a minute to see the revision complete.');
        reload();
      } else {
        setError((d.error as string) || 'Publish failed.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  }

  const columns: LoomColumn<ApimPortalRevision>[] = [
    {
      key: 'name',
      label: 'Revision',
      width: 220,
      render: (r) => (
        <div>
          <strong>{r.name}</strong>
          {r.description && <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS }}>{r.description}</Caption1>}
        </div>
      ),
    },
    {
      key: 'isCurrent',
      label: 'Current',
      width: 100,
      render: (r) => r.isCurrent
        ? <Badge appearance="filled" color="success">Current</Badge>
        : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 130,
      render: (r) => <Badge appearance="outline" color={statusColor(r.status)}>{r.status || 'unknown'}</Badge>,
    },
    {
      key: 'createdDateTime',
      label: 'Created',
      width: 180,
      render: (r) => <Caption1>{r.createdDateTime ? new Date(r.createdDateTime).toLocaleString() : '—'}</Caption1>,
    },
  ];

  if (loading) return <Section><Spinner label="Loading developer portal..." /></Section>;
  if (error) {
    return (
      <Section>
        <MessageBar intent="error">
          <MessageBarTitle>Developer portal error</MessageBarTitle>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </Section>
    );
  }
  if (!data) {
    return (
      <Section>
        <MessageBar intent="warning"><MessageBarBody>Developer portal info not available.</MessageBarBody></MessageBar>
      </Section>
    );
  }

  const devUrl = data.developerPortalUrl;

  return (
    <>
      <Section
        title="Developer portal"
        actions={
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
            <Button icon={<ArrowSync24Regular />} appearance="secondary" onClick={reload}>Refresh</Button>
            <Button appearance="primary" onClick={() => setPublishOpen(true)}>Publish portal</Button>
          </div>
        }
      >
        <Body1 style={{ color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalM }}>
          The APIM developer portal is the auto-generated, customizable website where consumers discover APIs,
          read documentation, try operations interactively, and request subscription keys. Open it to customize
          or browse, and publish to expose your latest API/portal changes to visitors.
        </Body1>

        {note && (
          <MessageBar intent="success" style={{ marginBottom: tokens.spacingVerticalM }}>
            <MessageBarBody>{note}</MessageBarBody>
          </MessageBar>
        )}

        <div className={styles.urls}>
          <div className={styles.urlCard}>
            <div className={styles.urlLabel}>Developer portal</div>
            {devUrl ? (
              <>
                <Caption1 className={styles.urlValue}>{devUrl}</Caption1>
                <Button
                  as="a"
                  href={devUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  icon={<Open24Regular />}
                  appearance="primary"
                >
                  Open developer portal
                </Button>
              </>
            ) : (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Not available (the developer portal endpoint is not yet provisioned for this service).
              </Caption1>
            )}
          </div>

          <div className={styles.urlCard}>
            <div className={styles.urlLabel}>Admin / publisher portal</div>
            {data.portalUrl ? (
              <>
                <Caption1 className={styles.urlValue}>{data.portalUrl}</Caption1>
                <Button
                  as="a"
                  href={data.portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="small"
                  icon={<Open24Regular />}
                  appearance="secondary"
                >
                  Open admin portal
                </Button>
              </>
            ) : (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Not available.</Caption1>
            )}
          </div>

          <div className={styles.urlCard}>
            <div className={styles.urlLabel}>Portal status</div>
            <Badge appearance="outline" color={statusColor(data.developerPortalStatus)}>
              {data.developerPortalStatus || data.provisioningState || 'Unknown'}
            </Badge>
            {data.managementApiUrl && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalXS }}>
                Management API: {data.managementApiUrl}
              </Caption1>
            )}
          </div>
        </div>
      </Section>

      <Section title="Publish history">
        <Caption1 style={{ color: tokens.colorNeutralForeground2, display: 'block', marginBottom: tokens.spacingVerticalM }}>
          Each publish creates a portal revision. The revision marked Current is the one served to visitors;
          you can republish at any time to roll forward your latest changes.
        </Caption1>
        <LoomDataTable
          columns={columns}
          rows={data.revisions}
          getRowId={(r) => r.id || r.name}
          empty="No portal revisions yet. Publish the portal to create the first revision."
          ariaLabel="APIM developer portal revisions"
        />
      </Section>

      {/* Publish dialog — real ARM PUT /portalRevisions via the BFF. */}
      <Dialog open={publishOpen} onOpenChange={(_, d) => setPublishOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Publish developer portal</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                <Body1>
                  Run the developer-portal publishing pipeline. This creates a new revision and makes it the
                  current (publicly-served) version. The operation runs asynchronously and may take a few minutes.
                </Body1>
                <Field label="Description" hint="Optional note shown in the revision history.">
                  <Input
                    value={publishDesc}
                    placeholder="e.g. Added new orders API to the portal"
                    onChange={(_, d) => setPublishDesc(d.value)}
                  />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPublishOpen(false)} disabled={publishing}>Cancel</Button>
              <Button appearance="primary" onClick={handlePublish} disabled={publishing}>
                {publishing ? 'Publishing...' : 'Publish'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

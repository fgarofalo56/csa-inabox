'use client';

/**
 * /apps/[id] — App detail page. Reads /api/apps-catalog and finds the
 * matching app, then renders its description + bundled item templates.
 *
 * **Install** button: picks a workspace and POSTs /api/apps/[id]/install
 * which creates every bundled item in the chosen workspace via the
 * shared createOwnedItem helper. Idempotent — items with the same
 * displayName + itemType already in the workspace are skipped.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Spinner, makeStyles, tokens, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Dropdown, Option, Field,
} from '@fluentui/react-components';
import { ArrowLeft24Regular, Add24Regular, AppGeneric24Regular } from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';

interface AppItemRef { type: string; template?: string; displayName?: string; }
interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
  items?: AppItemRef[];
}
interface WorkspaceLite { id: string; name: string; }
interface InstallResult { itemType: string; id?: string; displayName: string; status: string; error?: string; }

const useStyles = makeStyles({
  meta: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' },
  desc: { fontSize: '14px', lineHeight: 1.6, marginBottom: '20px', color: tokens.colorNeutralForeground2 },
  toolbar: { display: 'flex', gap: '12px', marginBottom: '20px', alignItems: 'center', flexWrap: 'wrap' },
  items: { display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' },
  itemCard: {
    paddingTop: '14px', paddingRight: '14px', paddingBottom: '14px', paddingLeft: '14px',
    borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    display: 'flex', flexDirection: 'column', gap: '4px',
    ':hover': { borderColor: tokens.colorBrandStroke1 },
  },
  itemType: { fontSize: '13px', fontWeight: 600 },
  itemTpl: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  installResult: {
    paddingTop: '12px', paddingRight: '12px', paddingBottom: '12px', paddingLeft: '12px',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: '16px',
  },
});

export default function AppDetailPage() {
  const styles = useStyles();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [app, setApp] = useState<AppDoc | null | 'notfound'>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[]>([]);
  const [pickedWs, setPickedWs] = useState<string>('');
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<InstallResult[] | null>(null);
  const [installErr, setInstallErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/apps-catalog').then(r => r.json()).then(d => {
      const a = (d?.apps ?? []).find((x: AppDoc) => x.id === params.id);
      setApp(a ?? 'notfound');
    }).catch(() => setApp('notfound'));
  }, [params.id]);

  // Load workspaces when install dialog opens.
  useEffect(() => {
    if (!installOpen || workspaces.length) return;
    fetch('/api/workspaces').then(r => r.json()).then((d: any) => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list);
      if (list.length === 1) setPickedWs(list[0].id);
    }).catch(() => {});
  }, [installOpen, workspaces.length]);

  const install = async () => {
    if (!pickedWs) return;
    setInstalling(true); setInstallErr(null); setInstallResult(null);
    try {
      const r = await fetch(`/api/apps/${params.id}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: pickedWs }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setInstallErr(j?.error || `HTTP ${r.status}`);
      } else {
        setInstallResult(j.installed || []);
        setInstallOpen(false);
      }
    } catch (e: any) {
      setInstallErr(e?.message || String(e));
    } finally { setInstalling(false); }
  };

  if (app === null) return <Spinner label="Loading…" />;
  if (app === 'notfound') {
    return (
      <PageShell title="App not found">
        <MessageBar intent="warning">
          <MessageBarBody>No app with id <code>{params.id}</code> in this tenant.</MessageBarBody>
        </MessageBar>
        <div style={{ marginTop: 16 }}>
          <Button icon={<ArrowLeft24Regular />} onClick={() => router.push('/apps')}>
            Back to Apps
          </Button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title={app.name}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ArrowLeft24Regular />} appearance="subtle" onClick={() => router.push('/apps')}>
            All apps
          </Button>
          <Button appearance="primary" icon={<AppGeneric24Regular />}
            onClick={() => setInstallOpen(true)}
            disabled={!app.items?.length}>
            Install into workspace
          </Button>
        </div>}>
      <div className={styles.meta}>
        {app.category && <Badge appearance="outline">{app.category}</Badge>}
        {app.publisher && <Badge appearance="outline" color="brand">by {app.publisher}</Badge>}
      </div>
      {app.description && <div className={styles.desc}>{app.description}</div>}

      <h3 style={{ marginBottom: 12 }}>Bundled items ({app.items?.length ?? 0})</h3>
      {(!app.items || app.items.length === 0) ? (
        <div style={{ color: tokens.colorNeutralForeground3, fontSize: 13 }}>
          This app doesn't bundle any items yet.
        </div>
      ) : (
        <div className={styles.items}>
          {app.items.map((it, i) => (
            // v2 validator finding: prefetch={false} kills the RSC payload
            // bursts that the validator caught as "URL auto-rotator" —
            // Next 14 Link prefetches every visible item card on mount,
            // which against /items/<type>/new flooded the network panel
            // and made the page look like it was navigating itself.
            <Link
              key={`${it.type}-${i}`}
              href={`/items/${it.type}/new`}
              className={styles.itemCard}
              prefetch={false}
            >
              <div className={styles.itemType}>{it.type.replace(/-/g, ' ')}</div>
              {it.template && <div className={styles.itemTpl}>template: {it.template}</div>}
            </Link>
          ))}
        </div>
      )}

      {installResult && (
        <div className={styles.installResult}>
          <MessageBar intent="success">
            <MessageBarTitle>Installed {installResult.length} items</MessageBarTitle>
            <MessageBarBody>
              {installResult.map((it, i) => (
                <div key={i} style={{ fontSize: 13, marginTop: 4 }}>
                  <Badge appearance={it.status === 'created' ? 'filled' : 'outline'}
                    color={it.status === 'created' ? 'success' : it.status === 'existed' ? 'informative' : 'danger'}>
                    {it.status}
                  </Badge>
                  {' '}
                  {it.id ? (
                    <Link href={`/items/${it.itemType}/${it.id}`}>{it.displayName}</Link>
                  ) : (
                    <span>{it.displayName}</span>
                  )}
                  {it.error && <span style={{ color: tokens.colorPaletteRedForeground1 }}> — {it.error}</span>}
                </div>
              ))}
            </MessageBarBody>
          </MessageBar>
        </div>
      )}

      <Dialog open={installOpen} onOpenChange={(_, d) => setInstallOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Install {app.name}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 13, color: tokens.colorNeutralForeground2 }}>
                  Creates {app.items?.length ?? 0} items in the chosen workspace.
                  Items with matching name + type are skipped (idempotent).
                </div>
                <Field label="Workspace" required>
                  <Dropdown placeholder="Pick a workspace"
                    selectedOptions={pickedWs ? [pickedWs] : []}
                    value={workspaces.find(w => w.id === pickedWs)?.name || ''}
                    onOptionSelect={(_, d) => setPickedWs(d.optionValue || '')}>
                    {workspaces.map(w => (
                      <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
                    ))}
                  </Dropdown>
                </Field>
                {workspaces.length === 0 && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      You don't have any workspaces yet. Create one at <Link href="/workspaces">/workspaces</Link> first.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {installErr && (
                  <MessageBar intent="error"><MessageBarBody>{installErr}</MessageBarBody></MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={install}
                disabled={!pickedWs || installing}>
                {installing ? 'Installing…' : 'Install'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </PageShell>
  );
}

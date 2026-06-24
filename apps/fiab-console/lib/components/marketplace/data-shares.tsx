'use client';

/**
 * DataShares — the "Data shares" surface of the unified Loom Marketplace.
 *
 * Bidirectional Databricks Delta Sharing, all real UC REST (no-vaporware):
 *
 *   Shared with me (inbound / subscribe)
 *     GET  /api/marketplace/sharing/providers?withShares=true
 *     GET  /api/marketplace/sharing/providers/[name]            (provider + shares)
 *     POST /api/marketplace/sharing/providers/[name]  {action:'mount', share_name, catalog_name}
 *     POST /api/marketplace/sharing/providers          (add provider from activation profile)
 *
 *   Shared by me (outbound / publish)
 *     GET/POST   /api/marketplace/sharing/shares
 *     GET/PATCH/DELETE /api/marketplace/sharing/shares/[name]   (objects + recipient grants)
 *     GET/POST   /api/marketplace/sharing/recipients
 *     GET/DELETE /api/marketplace/sharing/recipients/[name]
 *
 * Honest gate: when no Databricks workspace / Unity Catalog metastore is bound
 * (or Delta Sharing is disabled), the BFF returns 501 {gated:true} and a Fluent
 * MessageBar names the exact remediation — the full surface still renders.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Divider, Card, CardHeader,
  Input, Textarea, Field, Select, Tag, Tooltip, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, Add20Regular, Delete20Regular, Share20Regular,
  CloudArrowDown20Regular, Copy20Regular, Database20Regular,
  CloudArrowDown24Regular, Share24Regular, Person24Regular,
  DatabaseSearch20Regular, DatabaseSearch24Regular,
} from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { EmptyState } from '@/lib/components/empty-state';
import { ShareExplorerDialog } from '@/lib/components/marketplace/share-explorer';

const useStyles = makeStyles({
  pad: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minHeight: 0, flex: 1 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  card: {
    padding: tokens.spacingHorizontalL,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    transition: 'box-shadow 0.15s, transform 0.15s',
    ':hover': { boxShadow: tokens.shadow16, transform: 'translateY(-2px)' },
  },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap', alignItems: 'center' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingHorizontalL },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '200px' },
  mono: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    backgroundColor: tokens.colorNeutralBackground2, padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium, maxHeight: '160px', overflow: 'auto',
  },
});

interface Gate { error: string; hint?: string; missing?: string }
interface ShareObj { name: string; data_object_type?: string; shared_as?: string }
interface Share { name: string; comment?: string; owner?: string; objects?: ShareObj[] }
interface Recipient { name: string; authentication_type?: string; comment?: string; tokens?: Array<{ activation_url?: string }> }
interface Provider { name: string; comment?: string; data_provider_global_metastore_id?: string; shares?: Share[] }
interface MountedCatalog { name: string; provider_name?: string; share_name?: string; comment?: string; catalog_type?: string }

async function jget(url: string) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

export function DataShares() {
  const s = useStyles();
  const [tab, setTab] = useState('inbound');
  const [host, setHost] = useState<string | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);

  // inbound
  const [providers, setProviders] = useState<Provider[] | null>(null);
  // outbound
  const [shares, setShares] = useState<Share[] | null>(null);
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Explore/Query dialog — opened from a successful mount OR the mounted-catalogs
  // list, scoped to a single subscribed catalog. Lifted here so both entry points
  // share one dialog instance.
  const [explore, setExplore] = useState<{ open: boolean; catalog: string | null }>({ open: false, catalog: null });
  const openExplore = useCallback((catalog: string) => setExplore({ open: true, catalog }), []);

  const handleGate = (status: number, j: any): boolean => {
    if (status === 501 && j?.gated) { setGate({ error: j.error, hint: j.hint, missing: j.missing }); return true; }
    return false;
  };

  const loadInbound = useCallback(async () => {
    setErr(null);
    const { status, j } = await jget('/api/marketplace/sharing/providers?withShares=true');
    if (handleGate(status, j)) { setProviders([]); return; }
    setGate(null);
    if (!j.ok) { setErr(j.error || `HTTP ${status}`); setProviders([]); return; }
    setHost(j.host || null);
    setProviders(j.providers || []);
  }, []);

  const loadOutbound = useCallback(async () => {
    setErr(null);
    const [sh, rc] = await Promise.all([
      jget('/api/marketplace/sharing/shares'),
      jget('/api/marketplace/sharing/recipients'),
    ]);
    if (handleGate(sh.status, sh.j)) { setShares([]); setRecipients([]); return; }
    setGate(null);
    if (!sh.j.ok) { setErr(sh.j.error || `HTTP ${sh.status}`); setShares([]); }
    else { setHost(sh.j.host || null); setShares(sh.j.shares || []); }
    if (rc.j.ok) setRecipients(rc.j.recipients || []); else setRecipients([]);
  }, []);

  useEffect(() => {
    if (tab === 'inbound' && providers === null) void loadInbound();
    if (tab === 'outbound' && shares === null) void loadOutbound();
  }, [tab, providers, shares, loadInbound, loadOutbound]);

  const refresh = () => { if (tab === 'inbound') void loadInbound(); else void loadOutbound(); };

  return (
    <div className={s.pad}>
      <div className={s.row}>
        <Share20Regular />
        <Subtitle2>Data shares — Delta Sharing</Subtitle2>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} onClick={refresh}>Refresh</Button>
        {host && <Caption1 className={s.hint}>Metastore workspace: {host}</Caption1>}
      </div>
      <Caption1 className={s.hint}>
        Live, no-copy data exchange via Databricks Unity Catalog Delta Sharing. Subscribe to shares others publish
        (including Databricks Marketplace listings), or publish your own tables to recipients inside or outside your tenant.
      </Caption1>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(String(d.value))} className={s.tabs}>
        <Tab value="inbound" icon={<CloudArrowDown20Regular />}>Shared with me</Tab>
        <Tab value="outbound" icon={<Share20Regular />}>Shared by me</Tab>
      </TabList>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Delta Sharing not available</MessageBarTitle>
            {gate.error}{' '}
            {gate.hint}{gate.missing ? ` (set ${gate.missing} on loom-console).` : ''}
          </MessageBarBody>
        </MessageBar>
      )}
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {tab === 'inbound' && !gate && (
        <InboundPanel
          providers={providers} host={host} styles={s} onChange={loadInbound}
          busy={busy} setBusy={setBusy} onExplore={openExplore}
        />
      )}
      {tab === 'outbound' && !gate && (
        <OutboundPanel
          shares={shares} recipients={recipients} host={host} styles={s}
          onChange={loadOutbound} busy={busy} setBusy={setBusy}
        />
      )}

      <ShareExplorerDialog
        open={explore.open}
        setOpen={(o) => setExplore((prev) => ({ ...prev, open: o }))}
        catalog={explore.catalog}
        host={host}
      />
    </div>
  );
}

/* ----------------------------- INBOUND ----------------------------- */

function InboundPanel({
  providers, host, styles, onChange, busy, setBusy, onExplore,
}: {
  providers: Provider[] | null;
  host: string | null;
  styles: ReturnType<typeof useStyles>;
  onChange: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onExplore: (catalog: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <div className={styles.row}>
        <Subtitle2>Providers sharing data with me</Subtitle2>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setAddOpen(true)}>
          Add provider (activation file)
        </Button>
      </div>
      <Caption1 className={styles.hint}>
        A provider is an organization (or Databricks Marketplace listing) sharing live data with you. Mount one of its
        shares to get a read-only catalog — no data is copied.
      </Caption1>

      {providers === null && <Spinner size="tiny" />}
      {providers && providers.length === 0 && (
        <EmptyState
          icon={<CloudArrowDown24Regular />}
          title="No inbound providers yet"
          body="A provider is an organization (or Databricks Marketplace listing) sharing live data with you. Add one from a recipient activation file to mount its shares as read-only catalogs — no data is copied."
          primaryAction={{ label: 'Add provider', onClick: () => setAddOpen(true) }}
        />
      )}
      <TileGrid minTileWidth={280}>
        {(providers || []).map((p) => (
          <Card key={p.name} className={styles.card}>
            <CardHeader
              header={<Body1><b>{p.name}</b></Body1>}
              description={<Caption1 className={styles.hint}>{p.comment || (p.data_provider_global_metastore_id ? 'Databricks-to-Databricks' : 'Open Delta Sharing')}</Caption1>}
            />
            <div className={styles.row}>
              {(p.shares || []).length === 0
                ? <Caption1 className={styles.hint}>No shares exposed to you.</Caption1>
                : (p.shares || []).map((sh) => (
                    <MountShareButton key={sh.name} provider={p.name} share={sh.name} onDone={onChange} busy={busy} setBusy={setBusy} onExplore={onExplore} />
                  ))}
            </div>
            <div className={styles.cardActions}>
              <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                onClick={async () => {
                  setBusy(true);
                  await fetch(`/api/marketplace/sharing/providers/${encodeURIComponent(p.name)}`, { method: 'DELETE' });
                  setBusy(false); onChange();
                }}>Remove</Button>
            </div>
          </Card>
        ))}
      </TileGrid>

      <Divider />

      <MountedCatalogs styles={styles} onExplore={onExplore} reloadKey={providers} />

      <AddProviderDialog open={addOpen} setOpen={setAddOpen} onDone={onChange} />
    </>
  );
}

/**
 * MountedCatalogs — the subscribed shares that are now read-only Unity Catalog
 * catalogs on the bound workspace. This is the "use it" surface: each mounted
 * catalog gets an Explore / Query action that opens the in-Loom catalog explorer.
 */
function MountedCatalogs({
  styles, onExplore, reloadKey,
}: { styles: ReturnType<typeof useStyles>; onExplore: (catalog: string) => void; reloadKey: unknown }) {
  const [catalogs, setCatalogs] = useState<MountedCatalog[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null); setCatalogs(null);
    const { status, j } = await jget('/api/marketplace/sharing/catalogs');
    if (!j.ok) {
      // A gate here is non-fatal for this section — the providers list above
      // already carries the primary gate; just show a short note.
      setErr(j.error || `HTTP ${status}`); setCatalogs([]); return;
    }
    setCatalogs(j.catalogs || []);
  }, []);

  // Reload when the providers list changes (e.g. just after a successful mount).
  useEffect(() => { void load(); }, [load, reloadKey]);

  return (
    <>
      <div className={styles.row}>
        <DatabaseSearch20Regular />
        <Subtitle2>Subscribed shares — explore &amp; query</Subtitle2>
        <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={() => { void load(); }}>Refresh</Button>
      </div>
      <Caption1 className={styles.hint}>
        Each subscribed share is mounted as a read-only catalog. Open one to browse its schemas and tables, preview
        data, and run read-only SQL — live against the Databricks SQL warehouse, no copies.
      </Caption1>

      {catalogs === null && <Spinner size="tiny" />}
      {err && <Caption1 className={styles.hint}>{err}</Caption1>}
      {catalogs && catalogs.length === 0 && !err && (
        <EmptyState
          icon={<DatabaseSearch24Regular />}
          title="No subscribed shares yet"
          body="Subscribe to one of the provider shares above. Once mounted, it appears here as a read-only catalog you can explore and query directly inside Loom."
        />
      )}
      {catalogs && catalogs.length > 0 && (
        <TileGrid minTileWidth={280}>
          {catalogs.map((c) => (
            <Card key={c.name} className={styles.card}>
              <CardHeader
                image={<Database20Regular />}
                header={<Body1><b>{c.name}</b></Body1>}
                description={
                  <Caption1 className={styles.hint}>
                    {c.share_name ? `Share: ${c.provider_name ? `${c.provider_name}.` : ''}${c.share_name}` : (c.comment || 'Delta Sharing catalog')}
                  </Caption1>
                }
              />
              <div className={styles.cardActions}>
                <Button size="small" appearance="primary" icon={<DatabaseSearch20Regular />} onClick={() => onExplore(c.name)}>
                  Explore &amp; query
                </Button>
              </div>
            </Card>
          ))}
        </TileGrid>
      )}
    </>
  );
}

function MountShareButton({
  provider, share, onDone, busy, setBusy, onExplore,
}: { provider: string; share: string; onDone: () => void; busy: boolean; setBusy: (b: boolean) => void; onExplore: (catalog: string) => void }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState(`${provider}_${share}`.replace(/[^a-zA-Z0-9_]/g, '_'));
  const [msg, setMsg] = useState<string | null>(null);
  // Set to the mounted catalog name on success so the success state can offer
  // the in-Loom "Explore / Query" action (the missing "use it" path).
  const [mounted, setMounted] = useState<string | null>(null);
  const reset = () => { setMsg(null); setMounted(null); };
  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button size="small" icon={<Database20Regular />}>Subscribe: {share}</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Subscribe to {provider}.{share}</DialogTitle>
          <DialogContent>
            {msg ? <MessageBar intent={mounted ? 'success' : 'error'}><MessageBarBody>{msg}</MessageBarBody></MessageBar> : (
              <Field label="New catalog name" hint="The share is mounted as a read-only Unity Catalog catalog.">
                <Input value={catalog} onChange={(_, d) => setCatalog(d.value)} />
              </Field>
            )}
          </DialogContent>
          <DialogActions>
            {!msg && (
              <Button appearance="primary" disabled={busy || !catalog} onClick={async () => {
                setBusy(true);
                const r = await fetch(`/api/marketplace/sharing/providers/${encodeURIComponent(provider)}`, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ action: 'mount', share_name: share, catalog_name: catalog }),
                });
                const j = await r.json();
                setBusy(false);
                if (j.ok) {
                  setMounted(catalog);
                  setMsg(`Mounted as read-only catalog "${catalog}". Explore and query it right here in Loom.`);
                  onDone();
                } else {
                  setMounted(null);
                  setMsg(j.error || 'Mount failed');
                }
              }}>Subscribe</Button>
            )}
            {mounted && (
              <Button appearance="primary" icon={<DatabaseSearch20Regular />}
                onClick={() => { const c = mounted; setOpen(false); reset(); onExplore(c); }}>
                Explore &amp; query
              </Button>
            )}
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary" onClick={reset}>Close</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function AddProviderDialog({ open, setOpen, onDone }: { open: boolean; setOpen: (b: boolean) => void; onDone: () => void }) {
  const s = useStyles();
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [bearerToken, setBearerToken] = useState('');
  const [version, setVersion] = useState('1');
  const [comment, setComment] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Convenience: a provider hands you a Delta Sharing activation FILE (JSON).
  // Rather than make the JSON the config surface (no-freeform-config), we parse
  // it into the structured fields so the form stays the source of truth.
  const autofillFromProfile = () => {
    setErr(null);
    try {
      const p = JSON.parse(pasteText);
      if (p.endpoint) setEndpoint(String(p.endpoint));
      if (p.bearerToken) setBearerToken(String(p.bearerToken));
      if (p.shareCredentialsVersion != null) setVersion(String(p.shareCredentialsVersion));
      setShowPaste(false);
      setPasteText('');
    } catch {
      setErr('That doesn’t look like a valid activation profile (expected JSON with endpoint + bearerToken).');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add an inbound provider</DialogTitle>
          <DialogContent>
            <Caption1 className={s.hint}>
              Enter the Delta Sharing connection a provider gave you (e.g. from a Databricks Marketplace listing or a
              third party using open Delta Sharing). Have the activation <em>file</em>? Use “Paste activation file” to fill it in.
            </Caption1>
            <Field label="Provider name" required style={{ marginTop: tokens.spacingVerticalS }}>
              <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="acme-weather-data" />
            </Field>
            <Field label="Sharing endpoint URL" required style={{ marginTop: tokens.spacingVerticalS }}>
              <Input type="url" value={endpoint} onChange={(_, d) => setEndpoint(d.value)}
                placeholder="https://sharing.delta.io/delta-sharing/" />
            </Field>
            <Field label="Bearer token" required style={{ marginTop: tokens.spacingVerticalS }}>
              <Input type="password" value={bearerToken} onChange={(_, d) => setBearerToken(d.value)}
                placeholder="Token from the activation file" />
            </Field>
            <Field label="Credentials version" style={{ marginTop: tokens.spacingVerticalS }}>
              <Select value={version} onChange={(_, d) => setVersion(d.value)}>
                <option value="1">1</option>
              </Select>
            </Field>
            <Field label="Comment" style={{ marginTop: tokens.spacingVerticalS }}>
              <Input value={comment} onChange={(_, d) => setComment(d.value)} />
            </Field>
            <div style={{ marginTop: tokens.spacingVerticalS }}>
              <Button size="small" appearance="subtle" onClick={() => setShowPaste((v) => !v)}>
                {showPaste ? 'Hide activation file paste' : 'Paste activation file (JSON) to auto-fill…'}
              </Button>
            </div>
            {showPaste && (
              <Field label="Activation profile (JSON)" style={{ marginTop: tokens.spacingVerticalS }}>
                <Textarea value={pasteText} onChange={(_, d) => setPasteText(d.value)} rows={4}
                  placeholder='{"shareCredentialsVersion":1,"endpoint":"https://…","bearerToken":"…"}' />
                <div style={{ marginTop: tokens.spacingVerticalXS }}>
                  <Button size="small" appearance="secondary" disabled={!pasteText.trim()} onClick={autofillFromProfile}>
                    Auto-fill from file
                  </Button>
                </div>
              </Field>
            )}
            {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy || !name || !endpoint || !bearerToken} onClick={async () => {
              setBusy(true); setErr(null);
              const profile = JSON.stringify({
                shareCredentialsVersion: Number(version) || 1,
                endpoint: endpoint.trim(),
                bearerToken: bearerToken.trim(),
              });
              const r = await fetch('/api/marketplace/sharing/providers', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, recipient_profile_str: profile, comment }),
              });
              const j = await r.json(); setBusy(false);
              if (!j.ok) { setErr(j.error || 'Failed'); return; }
              setOpen(false); setName(''); setEndpoint(''); setBearerToken(''); setVersion('1'); setComment(''); onDone();
            }}>{busy ? 'Adding…' : 'Add provider'}</Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/* ----------------------------- OUTBOUND ----------------------------- */

function OutboundPanel({
  shares, recipients, host, styles, onChange, busy, setBusy,
}: {
  shares: Share[] | null;
  recipients: Recipient[] | null;
  host: string | null;
  styles: ReturnType<typeof useStyles>;
  onChange: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [recipOpen, setRecipOpen] = useState(false);

  return (
    <>
      <div className={styles.row}>
        <Subtitle2>Shares I publish</Subtitle2>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setShareOpen(true)}>New share</Button>
      </div>
      {shares === null && <Spinner size="tiny" />}
      {shares && shares.length === 0 && (
        <EmptyState
          icon={<Share24Regular />}
          title="No shares published yet"
          body="A share is a read-only collection of tables you expose to recipients inside or outside your tenant via Delta Sharing. Create one, add tables, then grant a recipient."
          primaryAction={{ label: 'New share', onClick: () => setShareOpen(true) }}
        />
      )}
      <TileGrid minTileWidth={280}>
        {(shares || []).map((sh) => (
          <ShareCard key={sh.name} share={sh} recipients={recipients || []} host={host} styles={styles}
            onChange={onChange} busy={busy} setBusy={setBusy} />
        ))}
      </TileGrid>

      <Divider />

      <div className={styles.row}>
        <Subtitle2>Recipients</Subtitle2>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setRecipOpen(true)}>New recipient</Button>
      </div>
      <Caption1 className={styles.hint}>
        A recipient is who you share with. TOKEN = open Delta Sharing (any client, via an activation link). DATABRICKS =
        another Unity Catalog metastore (by its sharing identifier).
      </Caption1>
      {recipients === null && <Spinner size="tiny" />}
      {recipients && recipients.length === 0 && (
        <EmptyState
          icon={<Person24Regular />}
          title="No recipients yet"
          body="A recipient is who you share with — TOKEN for open Delta Sharing (any client, via an activation link) or DATABRICKS for another Unity Catalog metastore."
          primaryAction={{ label: 'New recipient', onClick: () => setRecipOpen(true) }}
        />
      )}
      {recipients && recipients.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Auth</TableHeaderCell>
              <TableHeaderCell>Activation</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recipients.map((r) => (
              <TableRow key={r.name}>
                <TableCell>{r.name}</TableCell>
                <TableCell><Badge appearance="outline">{r.authentication_type}</Badge></TableCell>
                <TableCell>
                  {r.tokens?.[0]?.activation_url
                    ? <Tooltip content={r.tokens[0].activation_url!} relationship="label">
                        <Button size="small" icon={<Copy20Regular />}
                          onClick={() => navigator.clipboard?.writeText(r.tokens![0].activation_url!)}>Copy link</Button>
                      </Tooltip>
                    : <Caption1 className={styles.hint}>—</Caption1>}
                </TableCell>
                <TableCell>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Delete recipient"
                    onClick={async () => {
                      setBusy(true);
                      await fetch(`/api/marketplace/sharing/recipients/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
                      setBusy(false); onChange();
                    }} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <NewShareDialog open={shareOpen} setOpen={setShareOpen} onDone={onChange} />
      <NewRecipientDialog open={recipOpen} setOpen={setRecipOpen} onDone={onChange} />
    </>
  );
}

function ShareCard({
  share, recipients, host, styles, onChange, busy, setBusy,
}: {
  share: Share; recipients: Recipient[]; host: string | null;
  styles: ReturnType<typeof useStyles>; onChange: () => void; busy: boolean; setBusy: (b: boolean) => void;
}) {
  const [addObjOpen, setAddObjOpen] = useState(false);
  const [grant, setGrant] = useState('');
  return (
    <Card className={styles.card}>
      <CardHeader header={<Body1><b>{share.name}</b></Body1>}
        description={<Caption1 className={styles.hint}>{share.comment || `${(share.objects || []).length} object(s)`}</Caption1>} />
      <div className={styles.row}>
        {(share.objects || []).length === 0
          ? <Caption1 className={styles.hint}>No tables added yet.</Caption1>
          : (share.objects || []).map((o) => <Tag key={o.name} size="small">{o.shared_as || o.name}</Tag>)}
      </div>
      <div className={styles.cardActions}>
        <Button size="small" icon={<Add20Regular />} onClick={() => setAddObjOpen(true)}>Add table</Button>
        <div className={styles.row}>
          <Select value={grant} onChange={(_, d) => setGrant(d.value)} aria-label="Recipient to grant">
            <option value="">Grant recipient…</option>
            {recipients.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </Select>
          <Button size="small" disabled={!grant || busy} onClick={async () => {
            setBusy(true);
            await fetch(`/api/marketplace/sharing/shares/${encodeURIComponent(share.name)}`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ grant: [grant] }),
            });
            setBusy(false); setGrant(''); onChange();
          }}>Grant</Button>
        </div>
        <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Delete share"
          onClick={async () => {
            setBusy(true);
            await fetch(`/api/marketplace/sharing/shares/${encodeURIComponent(share.name)}`, { method: 'DELETE' });
            setBusy(false); onChange();
          }} />
      </div>
      <AddObjectDialog open={addObjOpen} setOpen={setAddObjOpen} shareName={share.name} host={host} onDone={onChange} />
    </Card>
  );
}

/** Cascading Catalog → Schema → Table picker over /api/catalog/browse (UC). */
function AddObjectDialog({
  open, setOpen, shareName, host, onDone,
}: { open: boolean; setOpen: (b: boolean) => void; shareName: string; host: string | null; onDone: () => void }) {
  const s = useStyles();
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<Array<{ full: string; name: string }>>([]);
  const [cat, setCat] = useState(''); const [sch, setSch] = useState(''); const [tbl, setTbl] = useState('');
  const [sharedAs, setSharedAs] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  const browse = useCallback(async (path: string[]) => {
    if (!host) return [];
    const { j } = await jget(`/api/catalog/browse?source=unity-catalog&path=${encodeURIComponent([host, ...path].join('|'))}`);
    return j.ok ? (j.nodes || []) : [];
  }, [host]);

  useEffect(() => { if (open && host) void browse([]).then((n) => setCatalogs(n.map((x: any) => x.id))); }, [open, host, browse]);
  useEffect(() => { setSch(''); setTbl(''); setSchemas([]); setTables([]); if (cat) void browse([cat]).then((n) => setSchemas(n.map((x: any) => x.id))); }, [cat, browse]);
  useEffect(() => { setTbl(''); setTables([]); if (cat && sch) void browse([cat, sch]).then((n) => setTables(n.filter((x: any) => x.kind === 'table').map((x: any) => ({ full: x.meta?.full_name || `${cat}.${sch}.${x.id}`, name: x.id })))); }, [cat, sch, browse]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add a table to {shareName}</DialogTitle>
          <DialogContent>
            <div className={s.formGrid}>
              <Field label="Catalog" required className={s.field}>
                <Select value={cat} onChange={(_, d) => setCat(d.value)}>
                  <option value="">Select…</option>{catalogs.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Schema" required className={s.field}>
                <Select value={sch} onChange={(_, d) => setSch(d.value)} disabled={!cat}>
                  <option value="">Select…</option>{schemas.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Table" required className={s.field}>
                <Select value={tbl} onChange={(_, d) => setTbl(d.value)} disabled={!sch}>
                  <option value="">Select…</option>{tables.map((t) => <option key={t.full} value={t.full}>{t.name}</option>)}
                </Select>
              </Field>
              <Field label="Shared as (alias)" className={s.field} hint="Optional name the recipient sees.">
                <Input value={sharedAs} onChange={(_, d) => setSharedAs(d.value)} placeholder={tbl.split('.').pop() || ''} />
              </Field>
            </div>
            {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy || !tbl} onClick={async () => {
              setBusy(true); setErr(null);
              const r = await fetch(`/api/marketplace/sharing/shares/${encodeURIComponent(shareName)}`, {
                method: 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ addObjects: [{ name: tbl, data_object_type: 'TABLE', ...(sharedAs ? { shared_as: sharedAs } : {}) }] }),
              });
              const j = await r.json(); setBusy(false);
              if (!j.ok) { setErr(j.error || 'Failed'); return; }
              setOpen(false); setCat(''); setSch(''); setTbl(''); setSharedAs(''); onDone();
            }}>{busy ? 'Adding…' : 'Add table'}</Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function NewShareDialog({ open, setOpen, onDone }: { open: boolean; setOpen: (b: boolean) => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New share</DialogTitle>
          <DialogContent>
            <Field label="Share name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="sales_2026" /></Field>
            <Field label="Comment" style={{ marginTop: 8 }}><Input value={comment} onChange={(_, d) => setComment(d.value)} /></Field>
            {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy || !name} onClick={async () => {
              setBusy(true); setErr(null);
              const r = await fetch('/api/marketplace/sharing/shares', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, comment }),
              });
              const j = await r.json(); setBusy(false);
              if (!j.ok) { setErr([j.error, j.hint].filter(Boolean).join(' — ') || 'Failed'); return; }
              setOpen(false); setName(''); setComment(''); onDone();
            }}>{busy ? 'Creating…' : 'Create'}</Button>
            <DialogTrigger disableButtonEnhancement><Button appearance="secondary">Cancel</Button></DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function NewRecipientDialog({ open, setOpen, onDone }: { open: boolean; setOpen: (b: boolean) => void; onDone: () => void }) {
  const s = useStyles();
  const [name, setName] = useState(''); const [auth, setAuth] = useState('TOKEN');
  const [gmid, setGmid] = useState(''); const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [activation, setActivation] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) { setActivation(null); } }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New recipient</DialogTitle>
          <DialogContent>
            {activation ? (
              <>
                <MessageBar intent="success"><MessageBarBody>Recipient created. Send this activation link to the recipient — it is shown once.</MessageBarBody></MessageBar>
                <div className={s.mono} style={{ marginTop: 8 }}>{activation}</div>
                <Button size="small" icon={<Copy20Regular />} style={{ marginTop: 8 }}
                  onClick={() => navigator.clipboard?.writeText(activation)}>Copy activation link</Button>
              </>
            ) : (
              <>
                <Field label="Recipient name" required><Input value={name} onChange={(_, d) => setName(d.value)} placeholder="partner-acme" /></Field>
                <Field label="Authentication" style={{ marginTop: 8 }}>
                  <Select value={auth} onChange={(_, d) => setAuth(d.value)}>
                    <option value="TOKEN">TOKEN — open Delta Sharing (any client)</option>
                    <option value="DATABRICKS">DATABRICKS — another Unity Catalog metastore</option>
                  </Select>
                </Field>
                {auth === 'DATABRICKS' && (
                  <Field label="Consumer sharing identifier" required style={{ marginTop: 8 }}
                    hint="The recipient metastore's global sharing id (cloud:region:uuid).">
                    <Input value={gmid} onChange={(_, d) => setGmid(d.value)} placeholder="azure:eastus2:…" />
                  </Field>
                )}
                <Field label="Comment" style={{ marginTop: 8 }}><Input value={comment} onChange={(_, d) => setComment(d.value)} /></Field>
                {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
              </>
            )}
          </DialogContent>
          <DialogActions>
            {!activation && (
              <Button appearance="primary" disabled={busy || !name || (auth === 'DATABRICKS' && !gmid)} onClick={async () => {
                setBusy(true); setErr(null);
                const r = await fetch('/api/marketplace/sharing/recipients', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name, authentication_type: auth, comment, ...(auth === 'DATABRICKS' ? { data_recipient_global_metastore_id: gmid } : {}) }),
                });
                const j = await r.json(); setBusy(false);
                if (!j.ok) { setErr([j.error, j.hint].filter(Boolean).join(' — ') || 'Failed'); return; }
                onDone();
                const url = j.recipient?.tokens?.[0]?.activation_url;
                if (url) setActivation(url); else { setOpen(false); setName(''); }
              }}>{busy ? 'Creating…' : 'Create'}</Button>
            )}
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary" onClick={() => { setName(''); setComment(''); setGmid(''); }}>Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

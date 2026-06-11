'use client';

/**
 * Catalog → Domains (UNIFIED).
 *
 * A Loom "domain" is one governance concept written through to BOTH Azure-native
 * back-ends by /api/admin/domains (lib/azure/unified-domain-mapper):
 *   • Microsoft Purview classic Data Map — domain ⇄ COLLECTION, subdomain ⇄
 *     child collection.
 *   • Databricks Unity Catalog — root domain ⇄ CATALOG, subdomain ⇄ SCHEMA.
 * Cosmos is authoritative, so this surface is FULLY editable and never empty
 * (a fresh tenant is seeded with a starter set). Full CRUD + reparent (MOVE)
 * live here:
 *   • Add domain / New subdomain   → POST   /api/admin/domains
 *   • Edit (name / description)    → PATCH  /api/admin/domains?id=
 *   • Move (reparent)              → PATCH  /api/admin/domains?id=  { parentId }
 *   • Delete                       → DELETE /api/admin/domains?id=
 *
 * Below the unified list, the classic Purview Data Map catalog (collections +
 * glossary, read live via /api/catalog/domains) stays visible when a Purview
 * account is configured. No Fabric dependency anywhere — both mirrors are
 * Azure-native and independently optional.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';
import {
  Spinner, Button, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Caption1, Body1, Subtitle2, Badge, Input, Textarea, Dropdown, Option,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import {
  ArrowSync20Regular, Open16Regular, FolderOpen24Regular, BookOpen24Regular,
  Add24Regular, BranchFork20Regular, Edit20Regular, ArrowMove20Regular,
  Delete20Regular, MoreHorizontal20Regular, Organization24Regular,
} from '@fluentui/react-icons';

interface LoomDomain {
  id: string;
  name: string;
  description?: string;
  parentId?: string;
  workspaceCount?: number;
  purviewLinked?: boolean;
  unityLinked?: boolean;
}
interface UnityStatus { configured: boolean; hint?: string }
interface AdminDomainsResponse {
  ok: boolean;
  domains?: LoomDomain[];
  unity?: UnityStatus;
  isTenantAdmin?: boolean;
  error?: string;
}
interface Collection {
  name: string;
  friendlyName?: string;
  description?: string;
  parentCollection?: string;
}
interface GlossaryTerm { guid: string; name?: string; longDescription?: string; status?: string }
interface UnifiedNote { available: boolean; title: string; detail: string; portal: string; doc: string }
interface ClassicResponse {
  ok: boolean;
  collections?: Collection[];
  glossaryTerms?: GlossaryTerm[];
  unifiedCatalog?: UnifiedNote;
  error?: string;
}

const useStyles = makeStyles({
  intro: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: '16px', maxWidth: '760px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' },
  grow: { flex: 1 },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: '20px',
    marginBottom: '20px',
    boxShadow: tokens.shadow2,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' },
  cardIcon: { color: tokens.colorBrandForeground1 },
  cardDesc: { display: 'block', color: tokens.colorNeutralForeground3, marginBottom: '16px', maxWidth: '720px' },
  nameCell: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
  termDesc: {
    color: tokens.colorNeutralForeground3,
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
  },
  count: { color: tokens.colorNeutralForeground3, fontWeight: 400 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 },
  linkBadges: { display: 'flex', gap: 6 },
});

type EditMode = 'create' | 'subdomain' | 'edit' | 'move';

export default function CatalogDomainsPage() {
  const s = useStyles();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const live = purview.configured && purview.reason === 'live';

  const [domains, setDomains] = useState<LoomDomain[] | null>(null);
  const [unity, setUnity] = useState<UnityStatus | null>(null);
  const [isTenantAdmin, setIsTenantAdmin] = useState(true);
  const [classic, setClassic] = useState<ClassicResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Edit / create / move dialog state.
  const [dlg, setDlg] = useState<{ mode: EditMode; target?: LoomDomain; parentId?: string } | null>(null);
  const [fId, setFId] = useState('');
  const [fName, setFName] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fParent, setFParent] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const loadDomains = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/domains');
      const j: AdminDomainsResponse = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); return; }
      setDomains(j.domains || []);
      setUnity(j.unity || null);
      setIsTenantAdmin(j.isTenantAdmin !== false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadClassic = useCallback(async () => {
    if (!live) { setClassic(null); return; }
    try {
      const r = await fetch('/api/catalog/domains');
      const j: ClassicResponse = await r.json();
      setClassic(j.ok ? j : null);
    } catch { setClassic(null); }
  }, [live]);

  useEffect(() => { loadDomains(); }, [loadDomains]);
  useEffect(() => { loadClassic(); }, [loadClassic]);

  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of domains || []) m[d.id] = d.name;
    return m;
  }, [domains]);

  const rootDomains = useMemo(() => (domains || []).filter((d) => !d.parentId), [domains]);

  function openCreate() { setDlg({ mode: 'create' }); setFId(''); setFName(''); setFDesc(''); setFParent(''); setActionErr(null); }
  function openSubdomain(parent: LoomDomain) { setDlg({ mode: 'subdomain', parentId: parent.id }); setFId(''); setFName(''); setFDesc(''); setFParent(parent.id); setActionErr(null); }
  function openEdit(d: LoomDomain) { setDlg({ mode: 'edit', target: d }); setFId(d.id); setFName(d.name); setFDesc(d.description || ''); setFParent(d.parentId || ''); setActionErr(null); }
  function openMove(d: LoomDomain) { setDlg({ mode: 'move', target: d }); setFParent(d.parentId || ''); setActionErr(null); }

  async function submit() {
    if (!dlg) return;
    setBusy(true); setActionErr(null);
    try {
      let r: Response;
      if (dlg.mode === 'create' || dlg.mode === 'subdomain') {
        if (!fId.trim() || !fName.trim()) { setActionErr('id and name are required'); setBusy(false); return; }
        r = await fetch('/api/admin/domains', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: fId.trim(), name: fName.trim(),
            description: fDesc.trim() || undefined,
            parentId: dlg.mode === 'subdomain' ? dlg.parentId : undefined,
          }),
        });
      } else if (dlg.mode === 'edit') {
        r = await fetch(`/api/admin/domains?id=${encodeURIComponent(dlg.target!.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: fName.trim(), description: fDesc.trim() }),
        });
      } else {
        // move
        r = await fetch(`/api/admin/domains?id=${encodeURIComponent(dlg.target!.id)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parentId: fParent || null }),
        });
      }
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      setDlg(null);
      await loadDomains();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  async function remove(d: LoomDomain) {
    if (!confirm(`Delete domain "${d.name}"? Its Purview collection and Unity Catalog mirror are removed too.`)) return;
    setActionErr(null);
    try {
      const r = await fetch(`/api/admin/domains?id=${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setActionErr(j.error || `HTTP ${r.status}`); return; }
      await loadDomains();
    } catch (e: any) { setActionErr(e?.message || String(e)); }
  }

  const domainColumns: LoomColumn<LoomDomain>[] = [
    {
      key: 'name', label: 'Name', sortable: true, filterable: true, width: 240,
      getValue: (d) => d.name,
      render: (d) => (
        <span className={s.nameCell}>
          {d.parentId ? <BranchFork20Regular style={{ color: tokens.colorNeutralForeground3 }} /> : <Organization24Regular className={s.cardIcon} />}
          <Body1><strong>{d.name}</strong></Body1>
          {d.parentId && <Badge appearance="outline" size="small">subdomain</Badge>}
        </span>
      ),
    },
    { key: 'id', label: 'ID', width: 130, sortable: true, filterable: true, getValue: (d) => d.id, render: (d) => <code style={{ fontSize: 11 }}>{d.id}</code> },
    {
      key: 'parent', label: 'Parent', width: 150, sortable: true, filterable: true,
      getValue: (d) => d.parentId ? (nameById[d.parentId] || d.parentId) : 'Root',
      render: (d) => d.parentId ? <Caption1>{nameById[d.parentId] || d.parentId}</Caption1> : <Badge appearance="tint" size="small">root</Badge>,
    },
    {
      key: 'governance', label: 'Mirrors', width: 170, sortable: false, filterable: false,
      getValue: (d) => `${d.purviewLinked ? 'purview ' : ''}${d.unityLinked ? 'unity' : ''}`,
      render: (d) => (
        <span className={s.linkBadges}>
          <Badge appearance={d.purviewLinked ? 'filled' : 'outline'} color={d.purviewLinked ? 'brand' : undefined} size="small">Purview</Badge>
          <Badge appearance={d.unityLinked ? 'filled' : 'outline'} color={d.unityLinked ? 'success' : undefined} size="small">Unity</Badge>
        </span>
      ),
    },
    {
      key: 'description', label: 'Description', sortable: false, filterable: true,
      getValue: (d) => d.description || '—',
      render: (d) => <span className={s.termDesc}>{d.description || '—'}</span>,
    },
    {
      key: 'actions', label: '', width: 56, sortable: false, filterable: false,
      render: (d) => (
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} onClick={(e) => e.stopPropagation()} aria-label={`Actions for ${d.name}`} />
          </MenuTrigger>
          <MenuPopover onClick={(e) => e.stopPropagation()}>
            <MenuList>
              <MenuItem icon={<Edit20Regular />} onClick={() => openEdit(d)}>Edit</MenuItem>
              <MenuItem icon={<ArrowMove20Regular />} disabled={!isTenantAdmin} onClick={() => openMove(d)}>Move…</MenuItem>
              {!d.parentId && <MenuItem icon={<BranchFork20Regular />} onClick={() => openSubdomain(d)}>New subdomain</MenuItem>}
              <MenuItem icon={<Delete20Regular />} onClick={() => remove(d)}>Delete</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      ),
    },
  ];

  const collectionColumns: LoomColumn<Collection>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (c) => c.name, render: (c) => <Body1><strong>{c.name}</strong></Body1> },
    { key: 'friendlyName', label: 'Friendly name', sortable: true, filterable: true, getValue: (c) => c.friendlyName || '—', render: (c) => c.friendlyName || '—' },
    { key: 'parentCollection', label: 'Parent', sortable: true, filterable: true, getValue: (c) => c.parentCollection || 'root', render: (c) => c.parentCollection || <Badge appearance="tint" size="small">root</Badge> },
    { key: 'description', label: 'Description', sortable: false, filterable: true, getValue: (c) => c.description || '—', render: (c) => c.description || '—' },
  ];
  const termColumns: LoomColumn<GlossaryTerm>[] = [
    { key: 'name', label: 'Term', sortable: true, filterable: true, getValue: (t) => t.name || t.guid, render: (t) => <Body1><strong>{t.name || t.guid}</strong></Body1> },
    { key: 'status', label: 'Status', sortable: true, filterable: true, width: 130, getValue: (t) => t.status || '—', render: (t) => t.status ? <Badge appearance="tint" size="small" color={t.status === 'Approved' ? 'success' : 'brand'}>{t.status}</Badge> : '—' },
    { key: 'longDescription', label: 'Description', sortable: false, filterable: true, getValue: (t) => t.longDescription || '—', render: (t) => <span className={s.termDesc}>{t.longDescription || '—'}</span> },
  ];

  const collections = classic?.collections ?? [];
  const terms = classic?.glossaryTerms ?? [];
  const unified = classic?.unifiedCatalog;

  return (
    <CatalogShell sectionTitle="Domains" sectionBadge="Unified governance">
      <Caption1 className={s.intro}>
        A <strong>domain</strong> is a governance-scoped grouping of data products and workspaces. Each Loom
        domain is written through to <strong>Microsoft Purview</strong> (as a collection) and{' '}
        <strong>Databricks Unity Catalog</strong> (as a catalog, with subdomains as schemas) — one concept,
        two Azure-native back-ends, no Microsoft Fabric required. Add, edit, create subdomains, and move
        domains here; the Purview Data Map catalog below is read live when a Purview account is configured.
      </Caption1>

      <PurviewGate status={purview} surface="Domains" reload={reloadStatus} />

      {unity && !unity.configured && (
        <MessageBar intent="info" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Unity Catalog mirror inactive</MessageBarTitle>
            {unity.hint || 'Set LOOM_DATABRICKS_HOSTNAME and grant the console UAMI CREATE CATALOG on the metastore to mirror domains as Unity Catalog catalogs/schemas. Domains remain fully usable without it.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody><MessageBarTitle>Couldn&apos;t load domains</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {actionErr && (
        <MessageBar intent="error" style={{ marginBottom: 16 }}>
          <MessageBarBody>{actionErr}</MessageBarBody>
        </MessageBar>
      )}

      <div className={s.toolbar}>
        <Subtitle2 className={s.grow}>Domains <span className={s.count}>({domains?.length ?? 0})</span></Subtitle2>
        <Button icon={<ArrowSync20Regular />} onClick={() => { reloadStatus(); loadDomains(); loadClassic(); }} disabled={loading}>Refresh</Button>
        <Button appearance="primary" icon={<Add24Regular />} onClick={openCreate}>Add domain</Button>
      </div>

      {loading && !domains ? (
        <Spinner label="Loading domains…" />
      ) : (
        <section className={s.card}>
          <LoomDataTable<LoomDomain>
            columns={domainColumns}
            rows={domains || []}
            getRowId={(d) => d.id}
            empty="No domains yet. Click “Add domain” to create your first one."
          />
        </section>
      )}

      {/* Classic Purview Data Map catalog (read live when a Purview account exists). */}
      {(unified || !live) && (
        <MessageBar intent="info" style={{ marginBottom: 20 }}>
          <MessageBarBody>
            <MessageBarTitle>{unified?.title || 'Purview Data Map catalog'}</MessageBarTitle>
            {unified?.detail ||
              'Connect a Microsoft Purview account (set LOOM_PURVIEW_ACCOUNT) to read its collections and ' +
              'glossary live here. Loom domains still mirror to Purview collections when an account is configured.'}
          </MessageBarBody>
          <MessageBarActions>
            <Button as="a" size="small" icon={<Open16Regular />} href={unified?.portal || 'https://purview.microsoft.com/'} target="_blank" rel="noreferrer">
              Open Purview
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {live && classic && (
        <>
          <section className={s.card}>
            <div className={s.cardHead}>
              <FolderOpen24Regular className={s.cardIcon} />
              <Subtitle2>Purview collections <span className={s.count}>({collections.length})</span></Subtitle2>
            </div>
            <Caption1 className={s.cardDesc}>
              Collections are the classic Data Map&apos;s organizational and security boundary. Loom domains
              mirror to them 1:1 (subdomains as child collections).
            </Caption1>
            <LoomDataTable<Collection>
              columns={collectionColumns}
              rows={collections}
              getRowId={(c) => c.name}
              empty="No collections returned. Register a data source in the Scan plane to populate the root collection."
            />
          </section>

          <section className={s.card}>
            <div className={s.cardHead}>
              <BookOpen24Regular className={s.cardIcon} />
              <Subtitle2>Business glossary <span className={s.count}>({terms.length})</span></Subtitle2>
            </div>
            <Caption1 className={s.cardDesc}>
              Glossary terms are the shared business vocabulary across the Data Map (Apache Atlas 2.2).
            </Caption1>
            <LoomDataTable<GlossaryTerm>
              columns={termColumns}
              rows={terms}
              getRowId={(t) => t.guid}
              empty="No glossary terms yet."
            />
          </section>
        </>
      )}

      {/* Add / subdomain / edit / move dialog */}
      <Dialog open={!!dlg} onOpenChange={(_, d) => { if (!d.open) setDlg(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {dlg?.mode === 'create' && 'Add domain'}
              {dlg?.mode === 'subdomain' && `New subdomain of ${nameById[dlg.parentId || ''] || dlg?.parentId}`}
              {dlg?.mode === 'edit' && `Edit ${dlg?.target?.name}`}
              {dlg?.mode === 'move' && `Move ${dlg?.target?.name}`}
            </DialogTitle>
            <DialogContent>
              {(dlg?.mode === 'create' || dlg?.mode === 'subdomain') && (
                <>
                  <div className={s.field}>
                    <Caption1>ID (lowercase, hyphens)</Caption1>
                    <Input value={fId} onChange={(_, d) => setFId(d.value)} placeholder="e.g. finance" />
                  </div>
                  <div className={s.field}>
                    <Caption1>Name (required)</Caption1>
                    <Input value={fName} onChange={(_, d) => setFName(d.value)} placeholder="Finance" />
                  </div>
                  <div className={s.field}>
                    <Caption1>Description</Caption1>
                    <Textarea value={fDesc} onChange={(_, d) => setFDesc(d.value)} resize="vertical" />
                  </div>
                </>
              )}
              {dlg?.mode === 'edit' && (
                <>
                  <div className={s.field}>
                    <Caption1>Name</Caption1>
                    <Input value={fName} onChange={(_, d) => setFName(d.value)} />
                  </div>
                  <div className={s.field}>
                    <Caption1>Description</Caption1>
                    <Textarea value={fDesc} onChange={(_, d) => setFDesc(d.value)} resize="vertical" />
                  </div>
                </>
              )}
              {dlg?.mode === 'move' && (
                <div className={s.field}>
                  <Caption1>New parent domain</Caption1>
                  <Dropdown
                    value={fParent ? (nameById[fParent] || fParent) : 'Root (no parent)'}
                    selectedOptions={[fParent]}
                    onOptionSelect={(_, d) => setFParent(d.optionValue || '')}
                  >
                    <Option value="">Root (no parent)</Option>
                    {rootDomains
                      .filter((p) => p.id !== dlg?.target?.id)
                      .map((p) => <Option key={p.id} value={p.id}>{p.name}</Option>)}
                  </Dropdown>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Domains are at most two levels (domain → subdomain). Purview reparents the collection;
                    Unity Catalog has no move operation, so the UC mapping is unchanged.
                  </Caption1>
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDlg(null)}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={submit}
                disabled={busy || ((dlg?.mode === 'create' || dlg?.mode === 'subdomain') && (!fId.trim() || !fName.trim()))}
              >
                {busy ? 'Saving…' : (dlg?.mode === 'move' ? 'Move' : 'Save')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </CatalogShell>
  );
}

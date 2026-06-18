'use client';

/**
 * CreateDomainDialog — the themed "Create new domain" experience for
 * /admin/domains. Two modes:
 *
 *   • "From the Federal agency library" — searchable, category-filtered browse
 *     of the curated Federal Civilian org tree (lib/domains/fedciv-domain-
 *     library). Pick an Enterprise (Department / independent agency) → drill
 *     into its sub-agencies → multi-select. A live preview card shows the
 *     icon-in-colored-chip + name + abbrev + mission. Selecting sub-agencies
 *     creates them as SUBDOMAINS of the Enterprise (parentId set), so the admin
 *     builds the real Enterprise → sub-agency tree.
 *
 *   • "Custom domain" — name + ID + a Fluent icon picker + a color picker +
 *     parent selector + description.
 *
 * On confirm both modes call the REAL create endpoint (POST /api/admin/domains)
 * with { id, name, description, icon, themeColor, parentId }. Multiple library
 * picks are created sequentially (Enterprise first so a child's parent exists).
 * Failures are surfaced honestly in a MessageBar; partial success is reported.
 */

import { useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Button, Input, Textarea, Caption1, Body1, Subtitle2, Badge, Checkbox,
  Dropdown, Option, SearchBox, TabList, Tab,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ChevronLeft20Regular, Checkmark16Filled, Building20Regular, Library20Regular } from '@fluentui/react-icons';
import { DomainGlyph, DOMAIN_ICON_PICKER, DOMAIN_THEME_COLORS } from '@/lib/domains/domain-icons';
import {
  FEDCIV_CATEGORIES, FEDCIV_LIBRARY_STATS,
  fedCivEnterprises, fedCivChildren, fedCivNode,
  type FedCivNode, type FedCivCategory,
} from '@/lib/domains/fedciv-domain-library';

export interface ExistingDomain { id: string; name: string; parentId?: string; }

const useStyles = makeStyles({
  modeTabs: { marginBottom: tokens.spacingVerticalM },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: '360px' },
  filterRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: tokens.spacingHorizontalS, maxHeight: '340px', overflowY: 'auto', paddingRight: '4px',
  },
  card: {
    display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS, textAlign: 'left', cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, border: `1px solid ${tokens.colorNeutralStroke1}` },
  },
  cardSel: { border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  cardText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  cardName: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300, lineHeight: 1.2 },
  cardMission: { color: tokens.colorNeutralForeground3, fontSize: '11px', lineHeight: 1.3 },
  abbrevRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  drillHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalXS },
  preview: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground2,
  },
  previewText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  fullWidth: { width: '100%' },
  iconGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(74px, 1fr))',
    gap: tokens.spacingHorizontalXS, maxHeight: '160px', overflowY: 'auto',
  },
  iconTile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px',
    padding: '6px 4px', cursor: 'pointer', background: 'transparent',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  iconTileSel: { border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  iconLabel: { fontSize: '10px', textAlign: 'center', color: tokens.colorNeutralForeground2 },
  swatchRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  swatch: {
    position: 'relative', width: '32px', height: '32px', borderRadius: '50%',
    cursor: 'pointer', border: '2px solid transparent', padding: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  swatchSel: { border: `2px solid ${tokens.colorBrandStroke1}`, outline: `2px solid ${tokens.colorBrandBackground}` },
  selectionBar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', padding: tokens.spacingVerticalXS,
  },
});

type Mode = 'library' | 'custom';

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function CreateDomainDialog({
  open, onOpenChange, existing, onCreated, initialParentId, initialMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current domains — used to disable already-created library nodes + parent picker. */
  existing: ExistingDomain[];
  /** Called after at least one domain is created so the page can refresh. */
  onCreated: () => void;
  /** Pre-select a parent (the "New subdomain" action opens custom mode here). */
  initialParentId?: string | null;
  /** Force a starting mode (subdomain creation forces 'custom'). */
  initialMode?: Mode;
}) {
  const s = useStyles();
  const [mode, setMode] = useState<Mode>(initialMode || 'library');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Library mode state.
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<FedCivCategory | 'All'>('All');
  const [drillInto, setDrillInto] = useState<string | null>(null); // Enterprise id
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Custom mode state.
  const [cName, setCName] = useState('');
  const [cId, setCId] = useState('');
  const [cIdDirty, setCIdDirty] = useState(false);
  const [cDesc, setCDesc] = useState('');
  const [cIcon, setCIcon] = useState('building');
  const [cColor, setCColor] = useState<string>(DOMAIN_THEME_COLORS[0]);
  const [cParent, setCParent] = useState('');

  const existingIds = useMemo(() => new Set(existing.map((d) => d.id)), [existing]);
  const roots = useMemo(() => existing.filter((d) => !d.parentId), [existing]);

  // When opened as a "New subdomain" action, jump to custom mode with the parent
  // pre-selected. Re-applies each time the dialog opens with new initial props.
  useEffect(() => {
    if (!open) return;
    setMode(initialMode || 'library');
    setCParent(initialParentId || '');
  }, [open, initialMode, initialParentId]);

  function reset() {
    setSearch(''); setCategory('All'); setDrillInto(null); setPicked(new Set());
    setCName(''); setCId(''); setCIdDirty(false); setCDesc('');
    setCIcon('building'); setCColor(DOMAIN_THEME_COLORS[0]); setCParent('');
    setErr(null); setResult(null);
  }

  function close(o: boolean) {
    if (!o) reset();
    onOpenChange(o);
  }

  // Browse list: when drilled into an Enterprise show its children; otherwise
  // show Enterprises filtered by category + search.
  const drillNode = drillInto ? fedCivNode(drillInto) : null;
  const browse: FedCivNode[] = useMemo(() => {
    const f = search.toLowerCase().trim();
    let list: FedCivNode[];
    if (drillInto) {
      list = fedCivChildren(drillInto);
    } else {
      list = fedCivEnterprises().filter((n) => category === 'All' || n.category === category);
    }
    if (!f) return list;
    return list.filter((n) =>
      n.name.toLowerCase().includes(f) ||
      n.abbrev.toLowerCase().includes(f) ||
      n.mission.toLowerCase().includes(f),
    );
  }, [search, category, drillInto]);

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function addAllChildren() {
    if (!drillInto) return;
    setPicked((prev) => {
      const next = new Set(prev);
      next.add(drillInto); // ensure the parent Enterprise is created too
      for (const c of fedCivChildren(drillInto)) if (!existingIds.has(c.id)) next.add(c.id);
      return next;
    });
  }

  // Single-node live preview: the node hovered/selected most recently, or the
  // drilled Enterprise, or the first browse item.
  const previewNode: FedCivNode | null = useMemo(() => {
    const lastPicked = Array.from(picked).pop();
    if (lastPicked) return fedCivNode(lastPicked) || null;
    if (drillNode) return drillNode;
    return browse[0] || null;
  }, [picked, drillNode, browse]);

  /**
   * Create the selected library nodes. Enterprises (no parent) are created
   * first so a sub-agency's parent always exists; if a child is picked without
   * its parent, the parent is auto-included. Already-existing domains are
   * skipped. POST per node against the real endpoint.
   */
  async function createLibrary() {
    const ids = Array.from(picked);
    if (!ids.length) { setErr('Select at least one agency from the library.'); return; }
    // Expand: any picked child pulls in its parent Enterprise.
    const toCreate = new Set<string>(ids);
    for (const id of ids) {
      const node = fedCivNode(id);
      if (node?.parentId) toCreate.add(node.parentId);
    }
    // Order: parents (Enterprises) before children, skipping ones that exist.
    const ordered = Array.from(toCreate)
      .map((id) => fedCivNode(id))
      .filter((n): n is FedCivNode => !!n && !existingIds.has(n.id))
      .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
    if (!ordered.length) { setErr('Everything selected already exists as a domain.'); return; }

    setBusy(true); setErr(null); setResult(null);
    let created = 0;
    const failures: string[] = [];
    const liveIds = new Set(existingIds);
    for (const n of ordered) {
      // A subdomain needs its parent present (existing or just created).
      if (n.parentId && !liveIds.has(n.parentId)) {
        failures.push(`${n.abbrev}: parent ${n.parentId} not available`);
        continue;
      }
      try {
        const r = await clientFetch('/api/admin/domains', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: n.id, name: n.name, description: n.mission,
            icon: n.icon, themeColor: n.color,
            parentId: n.parentId || undefined,
          }),
        });
        const j = await r.json();
        if (!j.ok) { failures.push(`${n.abbrev}: ${j.error || `HTTP ${r.status}`}`); continue; }
        created += 1;
        liveIds.add(n.id);
      } catch (e: any) {
        failures.push(`${n.abbrev}: ${e?.message || String(e)}`);
      }
    }
    setBusy(false);
    if (created > 0) {
      onCreated();
      if (failures.length) {
        setResult(`Created ${created} domain${created === 1 ? '' : 's'}. ${failures.length} skipped.`);
        setErr(failures.join(' · '));
      } else {
        setResult(`Created ${created} domain${created === 1 ? '' : 's'} from the Federal agency library.`);
        setTimeout(() => close(false), 900);
      }
    } else {
      setErr(failures.join(' · ') || 'No domains were created.');
    }
  }

  async function createCustom() {
    const name = cName.trim();
    const id = (cIdDirty ? cId : slugify(name)).trim();
    if (!name) { setErr('Name is required.'); return; }
    if (!id) { setErr('ID is required.'); return; }
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await clientFetch('/api/admin/domains', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id, name, description: cDesc.trim() || undefined,
          icon: cIcon, themeColor: cColor,
          parentId: cParent || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      onCreated();
      setResult(`Created domain “${name}”.`);
      setTimeout(() => close(false), 800);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }

  const customId = cIdDirty ? cId : slugify(cName);

  return (
    <Dialog open={open} onOpenChange={(_, d) => close(d.open)}>
      <DialogSurface style={{ maxWidth: '760px', width: '760px' }}>
        <DialogBody>
          <DialogTitle>Create new domain</DialogTitle>
          <DialogContent>
            <TabList
              className={s.modeTabs}
              selectedValue={mode}
              onTabSelect={(_e, d) => { setMode(d.value as Mode); setErr(null); setResult(null); }}
            >
              <Tab value="library" icon={<Library20Regular />}>From the Federal agency library</Tab>
              <Tab value="custom" icon={<Building20Regular />}>Custom domain</Tab>
            </TabList>

            {err && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{err}</MessageBarBody>
              </MessageBar>
            )}
            {result && (
              <MessageBar intent="success" style={{ marginBottom: 12 }}>
                <MessageBarBody>{result}</MessageBarBody>
              </MessageBar>
            )}

            {mode === 'library' ? (
              <div className={s.body}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Build your organization from {FEDCIV_LIBRARY_STATS.enterprises} departments &amp; independent
                  agencies and {FEDCIV_LIBRARY_STATS.subAgencies} sub-agencies. Pick an enterprise, then drill in
                  to add its bureaus as subdomains.
                </Caption1>

                {!drillInto ? (
                  <div className={s.filterRow}>
                    <SearchBox
                      placeholder="Search agencies…"
                      value={search}
                      onChange={(_e, d) => setSearch(d.value)}
                      style={{ flex: 1, minWidth: '220px' }}
                    />
                    <Dropdown
                      value={category}
                      selectedOptions={[category]}
                      onOptionSelect={(_e, d) => setCategory((d.optionValue as FedCivCategory | 'All') || 'All')}
                      style={{ minWidth: '200px' }}
                    >
                      <Option value="All">All categories</Option>
                      {FEDCIV_CATEGORIES.map((c) => <Option key={c} value={c}>{c}</Option>)}
                    </Dropdown>
                  </div>
                ) : (
                  <div className={s.drillHead}>
                    <Button
                      size="small" appearance="subtle" icon={<ChevronLeft20Regular />}
                      onClick={() => { setDrillInto(null); setSearch(''); }}
                    >
                      All enterprises
                    </Button>
                    {drillNode && (
                      <>
                        <DomainGlyph icon={drillNode.icon} color={drillNode.color} size={24} />
                        <Subtitle2>{drillNode.name} ({drillNode.abbrev})</Subtitle2>
                        <Button size="small" appearance="primary" onClick={addAllChildren}>
                          Add all sub-agencies
                        </Button>
                      </>
                    )}
                  </div>
                )}

                <div className={s.grid}>
                  {browse.map((n) => {
                    const exists = existingIds.has(n.id);
                    const sel = picked.has(n.id);
                    const hasChildren = !n.parentId && fedCivChildren(n.id).length > 0;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        className={`${s.card} ${sel ? s.cardSel : ''}`}
                        disabled={exists}
                        style={exists ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                        onClick={() => togglePick(n.id)}
                        onDoubleClick={() => { if (hasChildren) setDrillInto(n.id); }}
                        title={exists ? 'Already a domain' : n.mission}
                      >
                        <DomainGlyph icon={n.icon} color={n.color} size={34} />
                        <span className={s.cardText}>
                          <span className={s.abbrevRow}>
                            <span className={s.cardName}>{n.abbrev}</span>
                            {sel && <Checkmark16Filled style={{ color: tokens.colorBrandForeground1 }} />}
                            {exists && <Badge size="small" appearance="outline">added</Badge>}
                          </span>
                          <span className={s.cardMission}>{n.name}</span>
                          {hasChildren && (
                            <Badge
                              size="small" appearance="tint" color="informative"
                              onClick={(e) => { e.stopPropagation(); setDrillInto(n.id); }}
                              style={{ alignSelf: 'flex-start', cursor: 'pointer', marginTop: '2px' }}
                            >
                              {fedCivChildren(n.id).length} sub-agencies →
                            </Badge>
                          )}
                        </span>
                      </button>
                    );
                  })}
                  {browse.length === 0 && (
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No agencies match your search.</Caption1>
                  )}
                </div>

                {/* Live preview card */}
                {previewNode && (
                  <div className={s.preview}>
                    <DomainGlyph icon={previewNode.icon} color={previewNode.color} size={48} />
                    <div className={s.previewText}>
                      <span className={s.abbrevRow}>
                        <Subtitle2>{previewNode.name}</Subtitle2>
                        <Badge size="small" appearance="tint">{previewNode.abbrev}</Badge>
                        {previewNode.parentId && (
                          <Badge size="small" appearance="outline">
                            subdomain of {fedCivNode(previewNode.parentId)?.abbrev || previewNode.parentId}
                          </Badge>
                        )}
                      </span>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{previewNode.mission}</Caption1>
                    </div>
                  </div>
                )}

                {picked.size > 0 && (
                  <div className={s.selectionBar}>
                    <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>{picked.size} selected:</Caption1>
                    {Array.from(picked).map((id) => {
                      const n = fedCivNode(id);
                      if (!n) return null;
                      return (
                        <Badge key={id} appearance="tint" size="small">
                          {n.abbrev}
                        </Badge>
                      );
                    })}
                    <Button size="small" appearance="subtle" onClick={() => setPicked(new Set())}>Clear</Button>
                  </div>
                )}
              </div>
            ) : (
              <div className={s.body}>
                {/* Custom domain live preview */}
                <div className={s.preview}>
                  <DomainGlyph icon={cIcon} color={cColor} size={48} />
                  <div className={s.previewText}>
                    <Subtitle2>{cName.trim() || 'New domain'}</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      {cParent ? `Subdomain of ${roots.find((r) => r.id === cParent)?.name || cParent}` : 'Root domain'}
                      {customId ? ` · ${customId}` : ''}
                    </Caption1>
                  </div>
                </div>

                <div className={s.field}>
                  <Caption1>Name (required)</Caption1>
                  <Input
                    className={s.fullWidth}
                    value={cName}
                    placeholder="e.g. Mission Operations"
                    onChange={(_e, d) => setCName(d.value)}
                  />
                </div>
                <div className={s.field}>
                  <Caption1>ID (lowercase, hyphens)</Caption1>
                  <Input
                    className={s.fullWidth}
                    value={customId}
                    placeholder="mission-operations"
                    onChange={(_e, d) => { setCIdDirty(true); setCId(slugify(d.value)); }}
                  />
                </div>
                <div className={s.field}>
                  <Caption1>Parent domain (optional)</Caption1>
                  <Dropdown
                    className={s.fullWidth}
                    value={cParent ? (roots.find((r) => r.id === cParent)?.name || cParent) : 'Root (no parent)'}
                    selectedOptions={[cParent]}
                    onOptionSelect={(_e, d) => setCParent(d.optionValue || '')}
                  >
                    <Option value="">Root (no parent)</Option>
                    {roots.map((r) => <Option key={r.id} value={r.id}>{r.name}</Option>)}
                  </Dropdown>
                </div>
                <div className={s.field}>
                  <Caption1>Icon</Caption1>
                  <div className={s.iconGrid} role="radiogroup" aria-label="Domain icon">
                    {DOMAIN_ICON_PICKER.map((opt) => {
                      const sel = cIcon === opt.name;
                      return (
                        <button
                          key={opt.name}
                          type="button"
                          role="radio"
                          aria-checked={sel}
                          aria-label={opt.label}
                          className={`${s.iconTile} ${sel ? s.iconTileSel : ''}`}
                          onClick={() => setCIcon(opt.name)}
                        >
                          <DomainGlyph icon={opt.name} color={cColor} size={30} />
                          <span className={s.iconLabel}>{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className={s.field}>
                  <Caption1>Color</Caption1>
                  <div className={s.swatchRow} role="radiogroup" aria-label="Domain color">
                    {DOMAIN_THEME_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={cColor === c}
                        aria-label={`Color ${c}`}
                        className={`${s.swatch} ${cColor === c ? s.swatchSel : ''}`}
                        style={{ backgroundColor: c }}
                        onClick={() => setCColor(c)}
                      >
                        {cColor === c && <Checkmark16Filled style={{ color: '#fff' }} />}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={s.field}>
                  <Caption1>Description</Caption1>
                  <Textarea
                    className={s.fullWidth}
                    value={cDesc}
                    resize="vertical"
                    onChange={(_e, d) => setCDesc(d.value)}
                  />
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => close(false)}>Cancel</Button>
            {mode === 'library' ? (
              <Button appearance="primary" onClick={createLibrary} disabled={busy || picked.size === 0}>
                {busy ? 'Creating…' : `Create ${picked.size || ''} domain${picked.size === 1 ? '' : 's'}`.replace('  ', ' ').trim()}
              </Button>
            ) : (
              <Button appearance="primary" onClick={createCustom} disabled={busy || !cName.trim()}>
                {busy ? 'Creating…' : 'Create domain'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default CreateDomainDialog;

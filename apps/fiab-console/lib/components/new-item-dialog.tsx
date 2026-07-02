'use client';

/**
 * NewItemDialog — Fabric `+ New item` modal. Two-pane layout:
 *  - left: workload category list
 *  - right: item type grid for the selected category
 *
 * On select we ALWAYS create a real Cosmos item first, then redirect to
 * /items/[slug]/[realId]. When opened with a `workspaceId` we scope to it.
 * When opened from home (no prop) we resolve the caller's default (newest)
 * workspace and scope creation to that — so the home path never lands on the
 * literal /items/[slug]/new route with a non-existent id (which made the
 * per-item editor drive its bind route with the id "new" and 404). Only if no
 * workspace can be resolved do we fall back to pushing /items/[slug]/new, where
 * the per-item editor renders a create-gate (a safe, non-error landing).
 */

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Input,
  Field,
  Badge,
  MessageBar,
  MessageBarBody,
  RadioGroup,
  Radio,
  Switch,
  makeStyles,
  tokens,
  Subtitle2,
  Body1,
  Caption1,
} from '@fluentui/react-components';
import { Add24Regular, Search20Regular, ArrowLeft20Regular } from '@fluentui/react-icons';
import { createItem, getWorkspace, listWorkspaces } from '@/lib/api/workspaces';
import { CustomAttributesForm, type AttributeValues } from '@/lib/components/wizard/custom-attributes-form';
import {
  type AttributeGroup,
  missingRequiredAttributes,
} from '@/lib/types/attribute-groups';
import {
  FABRIC_ITEM_TYPES,
  WORKLOAD_CATEGORIES,
  findItemType,
  type FabricItemType,
  type WorkloadCategory,
} from '@/lib/catalog/fabric-item-types';
import { isAppTemplate } from '@/lib/catalog/app-templates';

/**
 * WAVE C — unified create-step contract. These mirror the optional
 * `createConfig` / `searchOnly` fields the catalog (lib/catalog/fabric-item-types.ts)
 * carries on consolidated head items. They are declared here so the dialog
 * compiles ahead of / independently of the catalog wave; once the catalog adds
 * the fields to `FabricItemType` these widen to the same shape (structurally
 * identical), and items WITHOUT createConfig keep the name-only inline create
 * (no regression). Azure-native option is `default:true`; Fabric is opt-in only
 * per no-fabric-dependency.md.
 */
interface CreateConfigChoice {
  /** stable value persisted/forwarded; runtimes => PipelineRuntime ('adf'|'synapse'|'fabric'),
   *  templates => templateId (or 'blank'). */
  value: string;
  label: string;
  desc: string;
  /** exactly one per axis — the Azure-native one. */
  default?: boolean;
  /** Wave-D hook (unused this wave): route this choice to a DIFFERENT head slug/editor. */
  slug?: string;
}
interface CreateConfig {
  /** forwarded as ?runtime= */
  runtimes?: CreateConfigChoice[];
  /** forwarded as &templateId= */
  templates?: CreateConfigChoice[];
}

/** Read the optional Wave-C catalog flags off a catalog entry without depending
 *  on the catalog wave having landed (structural, fully back-compatible). */
function getCreateConfig(i: FabricItemType | null | undefined): CreateConfig | undefined {
  return (i as unknown as { createConfig?: CreateConfig } | null | undefined)?.createConfig;
}
function isSearchOnly(i: FabricItemType): boolean {
  return Boolean((i as unknown as { searchOnly?: boolean }).searchOnly);
}
/** Labs / low-usage novelty items are hidden from the default gallery until the
 *  "Show Labs items" toggle is on. Read structurally so the dialog compiles
 *  independently of the catalog wave that adds the flag (fully back-compatible). */
function isLabs(i: FabricItemType): boolean {
  return Boolean((i as unknown as { labs?: boolean }).labs);
}
/** Resolve a picked entry (possibly a searchOnly alias/template) to its head
 *  catalog entry, where the createConfig lives. Falls back to the entry itself. */
function resolveHead(i: FabricItemType): FabricItemType {
  const headSlug = i.aliasOf ?? i.templateOf ?? i.slug;
  return findItemType(headSlug) ?? i;
}
/** Pre-selection seed so a searchOnly click pre-selects the matching radio. */
function seedFor(i: FabricItemType): { runtime?: string; templateId?: string } | undefined {
  if (i.runtimePreset && i.templateId) return { runtime: i.runtimePreset, templateId: i.templateId };
  if (i.templateId) return { templateId: i.templateId };
  if (i.runtimePreset) return { runtime: i.runtimePreset };
  return undefined;
}
/** Pick the default value for an axis (the choice flagged default:true). */
function defaultChoiceValue(choices?: CreateConfigChoice[]): string {
  if (!choices || choices.length === 0) return '';
  return (choices.find((c) => c.default) ?? choices[0]).value;
}

const useStyles = makeStyles({
  surface: { maxWidth: '960px', width: '90vw' },
  layout: { display: 'grid', gridTemplateColumns: '200px 1fr', gap: '16px', minHeight: '480px' },
  catList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: '8px',
  },
  catItem: {
    textAlign: 'left',
    padding: '8px 12px',
    borderRadius: '4px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
    fontSize: '14px',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  catItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
  },
  rightCol: { display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalS,
    flexWrap: 'wrap',
  },
  search: { flex: 1, minWidth: '200px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '12px',
    overflowY: 'auto',
    paddingRight: '4px',
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px',
    padding: '12px',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow4,
    },
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: '6px' },
  badges: { display: 'flex', gap: '4px', marginTop: '4px' },
  // WAVE C — configure step (Name + per-axis RadioGroup). Loom tokens only.
  configPane: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalM,
  },
  axisGroup: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXS,
  },
  radioLabel: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
  },
  radioDesc: { color: tokens.colorNeutralForeground3 },
});

interface Props {
  /** Optional pre-selected category */
  defaultCategory?: WorkloadCategory;
  /** Workspace to scope the new item to; forwarded as ?workspaceId=… */
  workspaceId?: string;
  /** Controlled open state (optional). When provided the caller owns open/close. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in "+ New item" trigger button (for controlled callers with their own CTA). */
  hideTrigger?: boolean;
}

export function NewItemDialog({ defaultCategory, workspaceId, open: openProp, onOpenChange, hideTrigger }: Props = {}) {
  const styles = useStyles();
  const router = useRouter();
  // Support both uncontrolled (internal state) and controlled (caller-owned)
  // open. `setOpen(bool)` notifies the caller when controlled and updates the
  // internal state otherwise — every call site passes a plain boolean.
  const [openU, setOpenU] = useState(false);
  const open = openProp ?? openU;
  const setOpen = (v: boolean) => { onOpenChange?.(v); if (openProp === undefined) setOpenU(v); };
  const [category, setCategory] = useState<WorkloadCategory>(defaultCategory ?? 'Data Engineering');
  const [query, setQuery] = useState('');
  // Labs / novelty items (rayfin-app, tapestry, …) are hidden from the gallery
  // until the user flips this on. They stay fully functional either way.
  const [showLabs, setShowLabs] = useState(false);
  // Two-step flow when workspaceId is known: pick type → name it inline.
  const [picked, setPicked] = useState<FabricItemType | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WAVE C — unified create-step selections. Seeded from picked.createConfig
  // defaults (or a searchOnly seed) in onPick; forwarded as ?runtime/&templateId
  // into the editor. Items WITHOUT createConfig leave these unused.
  const [createRuntime, setCreateRuntime] = useState('');
  const [createTemplate, setCreateTemplate] = useState('');
  // F17: domain-scoped custom attributes for the inline create step. The
  // workspace's domain drives which admin-defined attribute groups apply.
  const [wsDomain, setWsDomain] = useState<string | null>(null);
  const [customAttrs, setCustomAttrs] = useState<AttributeValues>({});
  const [attrGroups, setAttrGroups] = useState<AttributeGroup[]>([]);
  const [showAttrValidation, setShowAttrValidation] = useState(false);
  // Home/no-workspace entry: the caller's default (newest) workspace, resolved
  // best-effort on open so the same create-then-redirect flow can run against a
  // REAL workspace. null until resolved (or when the tenant has none — then
  // onPick falls back to the editor's /new create-gate).
  const [resolvedWorkspaceId, setResolvedWorkspaceId] = useState<string | null>(null);

  // The workspace creation scopes to: the explicit prop when present, else the
  // resolved default. undefined => not yet known (loading) or none exists.
  const effectiveWorkspaceId: string | undefined = workspaceId ?? resolvedWorkspaceId ?? undefined;

  // When opened from home (no workspaceId prop), resolve the caller's default
  // workspace (newest first). Tenant-scoped + credentialed via the shared API
  // client, so the create flow can scope to a real workspace instead of the
  // literal /new route. Best-effort — failure/empty leaves it unresolved.
  useEffect(() => {
    if (workspaceId || !open) return;
    let cancelled = false;
    listWorkspaces()
      .then((ws) => { if (!cancelled) setResolvedWorkspaceId(ws[0]?.id ?? null); })
      .catch(() => { if (!cancelled) setResolvedWorkspaceId(null); });
    return () => { cancelled = true; };
  }, [workspaceId, open]);

  // Resolve the workspace's domain once, so the Custom attributes step knows
  // which schema to render. Best-effort — failure just means no custom attrs.
  useEffect(() => {
    if (!effectiveWorkspaceId || !open) return;
    let cancelled = false;
    getWorkspace(effectiveWorkspaceId)
      .then((ws) => { if (!cancelled) setWsDomain(ws.domain || null); })
      .catch(() => { if (!cancelled) setWsDomain(null); });
    return () => { cancelled = true; };
  }, [effectiveWorkspaceId, open]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FABRIC_ITEM_TYPES.filter((i) => {
      // Deprecated item types (e.g. datamart) have no create path — never offer
      // them in the New item dialog, whether browsing or searching.
      if (i.deprecated) return false;
      // Core surfaces (e.g. data-marketplace) are reached from a top-level nav
      // destination, not "created" per workspace — never offer them here.
      if (i.coreSurface) return false;
      // Wave-B dedup duplicates are consolidated into a canonical sibling — the
      // gallery hides them (you create the canonical one) but the slug stays
      // fully resolvable so ALREADY-CREATED instances still open their editor +
      // BFF routes. Azure-native default per no-fabric-dependency.md.
      if (i.hiddenFromGallery) return false;
      // Labs / novelty items stay hidden (browse AND search) until the user
      // opts in via the "Show Labs items" toggle — they remain fully functional.
      if (isLabs(i) && !showLabs) return false;
      if (q) {
        // WAVE C — searchOnly items (consolidated presets/templates folded into a
        // single head item in browse) MUST still be findable by keyword. So in
        // the SEARCH branch we do NOT exclude them; ignore the category filter
        // so the user finds results across all workloads.
        return (
          i.displayName.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
        );
      }
      // WAVE C — browse mode (empty query): hide searchOnly items; the user
      // creates the single head item, then picks the preset/template in the
      // configure step.
      return i.category === category && !isSearchOnly(i);
    });
  }, [category, query, showLabs]);

  function reset() {
    setPicked(null); setDisplayName(''); setError(null); setCreating(false);
    setCustomAttrs({}); setAttrGroups([]); setShowAttrValidation(false);
    setCreateRuntime(''); setCreateTemplate('');
  }

  /**
   * WAVE C — onPick may receive an optional `seed` so a searchOnly click
   * pre-selects the matching radio (adf-pipeline -> {runtime:'adf'},
   * synapse-pipeline -> {runtime:'synapse'}, geo-pipeline -> {templateId:'geo-enrich'}).
   * When the picked entry is a searchOnly alias/template, we resolve to its HEAD
   * catalog entry so the configure pane reads head.createConfig.
   */
  function onPick(item: FabricItemType, seed?: { runtime?: string; templateId?: string }) {
    if (effectiveWorkspaceId) {
      // When the click came from a searchOnly result, derive the seed from the
      // item itself (its runtimePreset/templateId) unless one was passed.
      const effectiveSeed = seed ?? (isSearchOnly(item) ? seedFor(item) : undefined);
      // The configure pane reads createConfig off the HEAD entry. A searchOnly
      // alias/template folds into its head (e.g. adf-pipeline -> data-pipeline).
      const head = isSearchOnly(item) ? resolveHead(item) : item;
      const cfg = getCreateConfig(head);
      setPicked(head);
      setDisplayName('');
      setError(null);
      setCustomAttrs({}); setShowAttrValidation(false);
      // Seed the radios: explicit seed wins; otherwise the createConfig default.
      setCreateRuntime(effectiveSeed?.runtime ?? defaultChoiceValue(cfg?.runtimes));
      setCreateTemplate(effectiveSeed?.templateId ?? defaultChoiceValue(cfg?.templates));
      return;
    }
    // No workspace could be resolved (tenant has none, or the list is still
    // loading). Fall back to the per-item /new route, where the editor renders
    // a create-gate — a safe, non-error landing rather than a bind 404.
    setOpen(false);
    router.push(`/items/${item.slug}/new`);
  }

  const missingRequired = useMemo(
    () => missingRequiredAttributes(attrGroups, customAttrs),
    [attrGroups, customAttrs],
  );

  async function createInline() {
    if (!effectiveWorkspaceId || !picked || !displayName.trim()) return;
    // F17: block creation when a required custom attribute has no value.
    if (missingRequired.length > 0) {
      setShowAttrValidation(true);
      setError(`Provide a value for required attribute(s): ${missingRequired.join(', ')}`);
      return;
    }
    setCreating(true); setError(null);
    try {
      const cfg = getCreateConfig(picked);
      // WAVE C — the head item to create. The selected choice's `slug` (Wave-D
      // hook; undefined for the pipeline family) wins; otherwise the resolved
      // head: aliasOf ?? templateOf ?? slug. For the pipeline family every
      // choice has no slug, so this falls to picked's own slug = 'data-pipeline'.
      const runtimeChoice = cfg?.runtimes?.find((c) => c.value === createRuntime);
      const templateChoice = cfg?.templates?.find((c) => c.value === createTemplate);
      const headSlug =
        runtimeChoice?.slug ?? templateChoice?.slug ??
        picked.aliasOf ?? picked.templateOf ?? picked.slug;

      // DEMOTE-TO-TEMPLATE — fully-backed app templates (slate-workshop-app,
      // rayfin-azure-stack). Unlike a pipeline template (which seeds ONE head
      // item via createItem + ?templateId=), an app template must scaffold
      // SEVERAL real Azure-native items (primary + backing) wired together. So
      // when the picked entry's templateId resolves to an app-template id, we
      // bypass the single-item createItem path and POST the instantiation route,
      // which creates ALL items atomically server-side (real Cosmos writes +
      // search/governance/Purview mirroring, no Fabric/Power BI host on the
      // default path per no-fabric-dependency.md) and returns the primary item.
      // We then route to the primary's REAL id so the user lands in a working,
      // editable Loom item — never a /new create-gate, never an empty shell.
      // Every other path (pipeline family, plain items) is unchanged.
      const appTplId =
        picked.templateId && isAppTemplate(picked.templateId) ? picked.templateId : undefined;
      if (appTplId) {
        setCreating(true);
        setError(null);
        try {
          const r = await fetch(
            `/api/app-templates/${encodeURIComponent(appTplId)}/instantiate`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId: effectiveWorkspaceId,
                displayName: displayName.trim(),
              }),
            },
          );
          const j = await r.json();
          if (!j.ok || !j.primaryItemId) throw new Error(j.error || `HTTP ${r.status}`);
          setOpen(false);
          reset();
          router.push(
            `/items/${encodeURIComponent(j.primarySlug)}/${encodeURIComponent(j.primaryItemId)}`,
          );
        } catch (e) {
          setError((e as Error).message);
          setCreating(false);
        }
        return;
      }

      const item = await createItem(effectiveWorkspaceId, {
        itemType: headSlug,
        displayName: displayName.trim(),
        customAttributes: Object.keys(customAttrs).length ? customAttrs : undefined,
      });
      setOpen(false);

      // WAVE C — carry the configure-step choices into the editor as query
      // overrides. Items WITHOUT createConfig append nothing (no regression).
      //
      // Runtime is a SEED, not a lock, for a plain head create: page.tsx maps
      // any ?runtime= into runtimePreset, which the unified pipeline editor
      // treats as a LOCK (runtimeLocked = !!runtimePreset). So only forward
      // ?runtime= when the user picked a runtime AWAY FROM the createConfig
      // default — i.e. an explicit, intentional choice (e.g. Synapse/Fabric, or
      // the synapse-pipeline searchOnly seed). Leaving the Azure-native default
      // (ADF) selected appends nothing, so the editor's runtime switcher stays
      // user-changeable per its documented contract (data-pipeline-editor.tsx
      // §229-235). Alias slugs (adf-/synapse-pipeline) keep their lock via their
      // own catalog runtimePreset in page.tsx — that path is unaffected.
      let qs = '';
      const runtimeDefault = defaultChoiceValue(cfg?.runtimes);
      // `runtimeChoice` is already resolved above (headSlug computation). Reuse it.
      // Forward ?runtime= ONLY for a same-head runtime LOCK (the pipeline family,
      // where the choice has no slug and stays on the head editor). When the choice
      // routes to its OWN slug (engine reroute — notebook/SQL families), the target
      // editor is the engine's own editor and ignores runtimePreset, so a ?runtime=
      // param would be meaningless query noise — skip it.
      if (cfg?.runtimes && createRuntime && createRuntime !== runtimeDefault && !runtimeChoice?.slug) {
        qs += `${qs ? '&' : '?'}runtime=${encodeURIComponent(createRuntime)}`;
      }
      if (createTemplate && createTemplate !== 'blank') {
        qs += `${qs ? '&' : '?'}templateId=${encodeURIComponent(createTemplate)}`;
      }
      reset();
      router.push(`/items/${item.itemType}/${item.id}${qs}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      {!hideTrigger && (
        <DialogTrigger disableButtonEnhancement>
          <Button appearance="primary" icon={<Add24Regular />}>New item</Button>
        </DialogTrigger>
      )}
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            {picked
              // WAVE C — with a createConfig present, prefer the head display
              // name (e.g. 'Data pipeline') since the picked entry IS the head.
              ? `Name your ${picked.displayName.toLowerCase()}`
              : 'New item'}
          </DialogTitle>
          <DialogContent>
            {picked && effectiveWorkspaceId ? (
              <div className={styles.configPane}>
                <Button appearance="subtle" icon={<ArrowLeft20Regular />}
                  onClick={() => { setPicked(null); setError(null); }}>
                  Back to types
                </Button>
                <Field label="Name" required>
                  <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)}
                         placeholder={`My ${picked.displayName.toLowerCase()}`}
                         onKeyDown={(e) => { if (e.key === 'Enter') createInline(); }} />
                </Field>
                {/* WAVE C — unified create step. When the head item carries a
                    createConfig, render one RadioGroup per axis (no-freeform-config).
                    The Azure-native option is the default; Fabric is opt-in only.
                    Items WITHOUT createConfig skip this and keep the name-only
                    pane (no regression). */}
                {(() => {
                  const cfg = getCreateConfig(picked);
                  if (!cfg) return null;
                  return (
                    <>
                      {cfg.runtimes && cfg.runtimes.length > 0 && (
                        <Field label="Runtime" className={styles.axisGroup}>
                          <RadioGroup
                            value={createRuntime}
                            onChange={(_, d) => setCreateRuntime(d.value)}
                          >
                            {cfg.runtimes.map((c) => (
                              <Radio
                                key={c.value}
                                value={c.value}
                                label={{
                                  children: (
                                    <span className={styles.radioLabel}>
                                      <Body1>{c.label}</Body1>
                                      <Caption1 className={styles.radioDesc}>{c.desc}</Caption1>
                                    </span>
                                  ),
                                }}
                              />
                            ))}
                          </RadioGroup>
                        </Field>
                      )}
                      {cfg.templates && cfg.templates.length > 0 && (
                        <Field label="Template" className={styles.axisGroup}>
                          <RadioGroup
                            value={createTemplate}
                            onChange={(_, d) => setCreateTemplate(d.value)}
                          >
                            {cfg.templates.map((c) => (
                              <Radio
                                key={c.value}
                                value={c.value}
                                label={{
                                  children: (
                                    <span className={styles.radioLabel}>
                                      <Body1>{c.label}</Body1>
                                      <Caption1 className={styles.radioDesc}>{c.desc}</Caption1>
                                    </span>
                                  ),
                                }}
                              />
                            ))}
                          </RadioGroup>
                        </Field>
                      )}
                    </>
                  );
                })()}
                {/* F17: per-domain custom attributes. Renders nothing when the
                    workspace has no domain or no group applies. */}
                <CustomAttributesForm
                  domainId={wsDomain}
                  value={customAttrs}
                  onChange={setCustomAttrs}
                  showValidation={showAttrValidation}
                  onGroupsLoaded={setAttrGroups}
                />
                {error && (
                  <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
                )}
              </div>
            ) : (
            <div className={styles.layout}>
              <div className={styles.catList} role="tablist" aria-label="Workload category">
                {WORKLOAD_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={category === c}
                    className={`${styles.catItem} ${category === c && !query ? styles.catItemActive : ''}`}
                    onClick={() => { setCategory(c); setQuery(''); }}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div className={styles.rightCol}>
                <div className={styles.searchRow}>
                  <Input
                    className={styles.search}
                    contentBefore={<Search20Regular />}
                    placeholder="Search item types"
                    value={query}
                    onChange={(_, d) => setQuery(d.value)}
                  />
                  <Switch
                    label="Show Labs items"
                    checked={showLabs}
                    onChange={(_, d) => setShowLabs(d.checked)}
                  />
                </div>
                <div className={styles.grid}>
                  {items.map((i) => (
                    <button
                      key={i.slug}
                      type="button"
                      className={styles.card}
                      onClick={() => onPick(i)}
                    >
                      <div className={styles.cardHeader}>
                        <Subtitle2>{i.displayName}</Subtitle2>
                      </div>
                      <Body1>{i.description}</Body1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{i.category}</Caption1>
                      <div className={styles.badges}>
                        {i.preview && <Badge appearance="outline" color="warning">Preview</Badge>}
                        {isLabs(i) && <Badge appearance="tint" color="brand">Labs</Badge>}
                        {i.deprecated && <Badge appearance="outline" color="danger">Deprecated</Badge>}
                        {i.noRestApi && <Badge appearance="outline" color="informative">UI only</Badge>}
                      </div>
                    </button>
                  ))}
                  {items.length === 0 && (
                    <Body1>No matching item types.</Body1>
                  )}
                </div>
              </div>
            </div>
            )}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            {picked && effectiveWorkspaceId && (
              <Button appearance="primary"
                disabled={!displayName.trim() || creating}
                onClick={createInline}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

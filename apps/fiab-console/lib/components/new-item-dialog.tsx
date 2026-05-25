'use client';

/**
 * NewItemDialog — Fabric `+ New item` modal. Two-pane layout:
 *  - left: workload category list
 *  - right: item type grid for the selected category
 *
 * On select, navigates to /items/[slug]/new where the per-item-type
 * editor handles the create + redirect to /items/[slug]/[id].
 */

import { useState, useMemo } from 'react';
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
  makeStyles,
  tokens,
  Subtitle2,
  Body1,
  Caption1,
} from '@fluentui/react-components';
import { Add24Regular, Search20Regular, ArrowLeft20Regular } from '@fluentui/react-icons';
import { createItem } from '@/lib/api/workspaces';
import {
  FABRIC_ITEM_TYPES,
  WORKLOAD_CATEGORIES,
  type FabricItemType,
  type WorkloadCategory,
} from '@/lib/catalog/fabric-item-types';

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
  search: { marginBottom: '8px' },
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
});

interface Props {
  /** Optional pre-selected category */
  defaultCategory?: WorkloadCategory;
  /** Workspace to scope the new item to; forwarded as ?workspaceId=… */
  workspaceId?: string;
}

export function NewItemDialog({ defaultCategory, workspaceId }: Props = {}) {
  const styles = useStyles();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<WorkloadCategory>(defaultCategory ?? 'Data Engineering');
  const [query, setQuery] = useState('');
  // Two-step flow when workspaceId is known: pick type → name it inline.
  const [picked, setPicked] = useState<FabricItemType | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FABRIC_ITEM_TYPES.filter((i) => {
      if (q) {
        // when searching, ignore the category filter so the user finds
        // results across all workloads
        return (
          i.displayName.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
        );
      }
      return i.category === category;
    });
  }, [category, query]);

  function reset() {
    setPicked(null); setDisplayName(''); setError(null); setCreating(false);
  }

  function onPick(item: FabricItemType) {
    if (workspaceId) {
      // Two-step: prompt for name, then create directly.
      setPicked(item);
      setDisplayName('');
      setError(null);
      return;
    }
    setOpen(false);
    router.push(`/items/${item.slug}/new`);
  }

  async function createInline() {
    if (!workspaceId || !picked || !displayName.trim()) return;
    setCreating(true); setError(null);
    try {
      const item = await createItem(workspaceId, {
        itemType: picked.slug,
        displayName: displayName.trim(),
      });
      setOpen(false);
      reset();
      router.push(`/items/${item.itemType}/${item.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { setOpen(d.open); if (!d.open) reset(); }}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add24Regular />}>New item</Button>
      </DialogTrigger>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            {picked ? `Name your ${picked.displayName.toLowerCase()}` : 'New item'}
          </DialogTitle>
          <DialogContent>
            {picked && workspaceId ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Button appearance="subtle" icon={<ArrowLeft20Regular />}
                  onClick={() => { setPicked(null); setError(null); }}>
                  Back to types
                </Button>
                <Field label="Name" required>
                  <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)}
                         placeholder={`My ${picked.displayName.toLowerCase()}`}
                         onKeyDown={(e) => { if (e.key === 'Enter') createInline(); }} />
                </Field>
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
                <Input
                  className={styles.search}
                  contentBefore={<Search20Regular />}
                  placeholder="Search item types"
                  value={query}
                  onChange={(_, d) => setQuery(d.value)}
                />
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
            {picked && workspaceId && (
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

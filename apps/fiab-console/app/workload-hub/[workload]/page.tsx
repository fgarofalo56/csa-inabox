'use client';

/**
 * /workload-hub/[workload] — a workload's landing page.
 *
 * Fabric parity (learn.microsoft.com/fabric/fundamentals/fabric-home): opening
 * a workload shows a list of the item types it can create. This page renders
 * one ItemTile per creatable item type in the workload (icon + name + one-line
 * description), derived 100% from the item-type registry
 * (lib/catalog/workload-hub.ts → creatableItemTypes()).
 *
 * Two real actions per item type — no dead-ends:
 *   • Primary (tile click / "Create new") → /items/[slug]/new, the real create
 *     wizard dispatched by lib/editors/registry → Azure-native provisioner.
 *   • "View existing" (kebab) → /workload-hub/[workload]/[slug], the existing-
 *     items view backed by the real /api/items/by-type store, with a + New CTA.
 */

import { use, useMemo, useState } from 'react';
import { notFound, useRouter } from 'next/navigation';
import {
  makeStyles, tokens, Badge, Text,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, Button,
} from '@fluentui/react-components';
import {
  MoreHorizontal20Regular, Add20Regular, Open20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { findWorkloadGroup, creatableItemTypes } from '@/lib/catalog/workload-hub';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  intro: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase400,
    maxWidth: '760px',
    marginBottom: tokens.spacingVerticalL,
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  empty: { color: tokens.colorNeutralForeground3, overflowWrap: 'anywhere', wordBreak: 'break-word' },
  badgeRow: { display: 'inline-flex', gap: tokens.spacingHorizontalXS },
});

interface Props {
  params: Promise<{ workload: string }>;
}

export default function WorkloadLandingPage(props: Props) {
  const { workload } = use(props.params);
  const s = useStyles();
  const router = useRouter();
  const [q, setQ] = useState('');

  const group = findWorkloadGroup(workload);
  if (!group) notFound();

  const allItems = useMemo(() => creatableItemTypes(group), [group]);

  const filter = q.trim().toLowerCase();
  const items = useMemo(
    () => allItems.filter((t) =>
      !filter ||
      t.displayName.toLowerCase().includes(filter) ||
      t.description.toLowerCase().includes(filter)),
    [allItems, filter],
  );

  function create(item: FabricItemType) {
    router.push(`/items/${item.slug}/new`);
  }
  function viewExisting(item: FabricItemType) {
    router.push(`/workload-hub/${group!.key}/${item.slug}`);
  }

  return (
    <PageShell
      title={group.name}
      subtitle={`${allItems.length} item type${allItems.length === 1 ? '' : 's'} you can create in this workload`}
      breadcrumbs={[
        { label: 'Home', href: '/' },
        { label: 'Workload hub', href: '/workload-hub' },
        { label: group.name },
      ]}
    >
      <div className={s.intro}>{group.description}</div>

      <Toolbar
        search={q}
        onSearch={setQ}
        searchPlaceholder="Filter item types…"
      />

      <Section title="Item types">
        {items.length === 0 ? (
          <Text className={s.empty}>
            {allItems.length === 0
              ? 'No item types are registered for this workload yet.'
              : `No item types match "${q}".`}
          </Text>
        ) : (
          <TileGrid minTileWidth={300}>
            {items.map((t) => (
              <ItemTile
                key={t.slug}
                type={t.slug}
                size="lg"
                title={t.displayName}
                subtitle={t.description}
                meta={`Create a ${t.displayName.toLowerCase()}`}
                badge={
                  <span className={s.badgeRow}>
                    {t.preview && <Badge appearance="outline" color="warning" size="small">Preview</Badge>}
                    {t.noRestApi && <Badge appearance="outline" color="informative" size="small">UI only</Badge>}
                  </span>
                }
                overflowMenu={
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<MoreHorizontal20Regular />}
                        aria-label={`${t.displayName} actions`}
                      />
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        <MenuItem icon={<Add20Regular />} onClick={() => create(t)}>
                          Create new
                        </MenuItem>
                        <MenuItem icon={<Open20Regular />} onClick={() => viewExisting(t)}>
                          View existing
                        </MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                }
                onClick={() => create(t)}
              />
            ))}
          </TileGrid>
        )}
      </Section>
    </PageShell>
  );
}

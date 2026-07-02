'use client';

import { useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { TreeBrowser } from '@/lib/components/catalog/tree-browser';
import { TabList, Tab, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalM },
});

export default function CatalogBrowsePage() {
  const s = useStyles();
  // Default to the Azure-native Loom workspaces (the customer's own data); real
  // Fabric OneLake is opt-in. Unity Catalog + Purview stay as additional sources.
  const [source, setSource] = useState<'purview' | 'unity-catalog' | 'onelake'>('onelake');
  return (
    <CatalogShell sectionTitle="Browse">
      <TabList
        className={s.tabs}
        selectedValue={source}
        onTabSelect={(_, d) => setSource(d.value as any)}
      >
        <Tab value="onelake">Loom workspaces</Tab>
        <Tab value="unity-catalog">Unity Catalog</Tab>
        <Tab value="purview">Purview domains</Tab>
      </TabList>
      <TreeBrowser source={source} onSelect={(n, path) => {
        // Open detail page in new tab.
        if (source === 'unity-catalog' && path.length >= 1) {
          window.open(`/catalog/unity-catalog/${encodeURIComponent([...path.slice(1), n.id].join('.'))}?host=${encodeURIComponent(path[0])}`, '_blank');
        } else if (source === 'onelake') {
          // Azure-native Loom item → its native editor (node.kind === itemType slug).
          if (n.kind && n.kind !== 'workspace') window.open(`/items/${encodeURIComponent(n.kind)}/${encodeURIComponent(n.id)}`, '_blank');
        } else if (source === 'purview') {
          window.open(`/catalog/purview/${encodeURIComponent(n.id)}`, '_blank');
        }
      }} />
    </CatalogShell>
  );
}

'use client';

import { useState } from 'react';
import { CatalogShell } from '@/lib/components/catalog/catalog-shell';
import { TreeBrowser } from '@/lib/components/catalog/tree-browser';
import { TabList, Tab, makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  tabs: { marginBottom: 12 },
});

export default function CatalogBrowsePage() {
  const s = useStyles();
  const [source, setSource] = useState<'purview' | 'unity-catalog' | 'onelake'>('unity-catalog');
  return (
    <CatalogShell sectionTitle="Browse">
      <TabList
        className={s.tabs}
        selectedValue={source}
        onTabSelect={(_, d) => setSource(d.value as any)}
      >
        <Tab value="unity-catalog">Unity Catalog</Tab>
        <Tab value="onelake">OneLake (Fabric)</Tab>
        <Tab value="purview">Purview domains</Tab>
      </TabList>
      <TreeBrowser source={source} onSelect={(n, path) => {
        // Open detail page in new tab.
        if (source === 'unity-catalog' && path.length >= 1) {
          window.open(`/catalog/unity-catalog/${encodeURIComponent([...path.slice(1), n.id].join('.'))}?host=${encodeURIComponent(path[0])}`, '_blank');
        } else if (source === 'onelake' && path.length >= 1) {
          window.open(`/catalog/onelake/${encodeURIComponent(n.id)}?workspace=${encodeURIComponent(path[0])}`, '_blank');
        } else if (source === 'purview') {
          window.open(`/catalog/purview/${encodeURIComponent(n.id)}`, '_blank');
        }
      }} />
    </CatalogShell>
  );
}

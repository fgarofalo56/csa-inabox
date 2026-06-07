'use client';

/**
 * DataScienceHomeEditor — registered under the `data-science-home` slug.
 *
 * Renders the Data Science landing surface inside the standard item-editor
 * chrome (ribbon + main panel), so a `data-science-home` workspace item opens
 * to the same real recent-items view as the top-level experience page. The
 * ribbon's "Open full Data Science home" jumps to /experience/data-science/home,
 * and the Create group routes to the real notebook / experiment / model
 * wizards. No dead controls — every ribbon action navigates somewhere real.
 */

import { useRouter } from 'next/navigation';
import { ItemEditorChrome } from './item-editor-chrome';
import { DataScienceHomeContent } from '@/lib/components/data-science/home-content';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

export function DataScienceHomeEditor({ item, id }: { item: FabricItemType; id: string }) {
  const router = useRouter();

  const ribbon: RibbonTab[] = [
    {
      id: 'home',
      label: 'Home',
      groups: [
        {
          label: 'Navigate',
          actions: [
            {
              label: 'Open full Data Science home',
              onClick: () => router.push('/experience/data-science/home'),
            },
            {
              label: 'Refresh',
              onClick: () => router.refresh(),
            },
          ],
        },
        {
          label: 'Create',
          actions: [
            { label: 'New notebook', onClick: () => router.push('/items/notebook/new') },
            { label: 'New experiment', onClick: () => router.push('/items/ml-experiment/new') },
            { label: 'Register model', onClick: () => router.push('/items/ml-model/new') },
          ],
        },
      ],
    },
  ];

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={<DataScienceHomeContent />}
    />
  );
}

export default DataScienceHomeEditor;

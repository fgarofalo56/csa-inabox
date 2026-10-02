'use client';
/**
 * What the dataset editor shows when the dataset routes answer for want of item
 * access. Kept out of `foundry-sub-editors.tsx`, which is ratchet-frozen by
 * `scripts/ci/check-file-size.mjs`.
 */
import { MessageBar, MessageBarBody, MessageBarTitle, Link } from '@fluentui/react-components';

/**
 * The `code` the dataset routes answer when the caller cannot read a dataset
 * item with this id (`app/api/items/dataset/_lib/dataset-item-scope.ts`, which
 * a client module cannot import because it builds a server response).
 */
export const DATASET_ITEM_NOT_FOUND = 'dataset_item_not_found';
export const DATASET_ITEM_MAPPING_ISSUE_URL = 'https://github.com/fgarofalo56/csa-inabox/issues/4826';

/**
 * Shown instead of the asset when the dataset routes refuse for want of item
 * access. Dataset items are not yet linked to the Foundry data asset they stand
 * for, so a caller who is not a tenant admin reaches this for every asset until
 * #4826 lands; a bare 404 would read as a broken editor.
 */
export function DatasetItemMappingNotice() {
  return (
    <MessageBar intent="warning" layout="multiline">
      <MessageBarBody>
        <MessageBarTitle>This data asset opens through a Loom dataset item</MessageBarTitle>
        The dataset editor opens a Foundry data asset through a Loom dataset item you can read. Loom does not
        yet link dataset items to the Foundry data assets they stand for, so for now a tenant admin opens data
        assets by name. Progress is tracked in{' '}
        <Link href={DATASET_ITEM_MAPPING_ISSUE_URL} target="_blank" rel="noopener noreferrer">issue #4826</Link>.
      </MessageBarBody>
    </MessageBar>
  );
}

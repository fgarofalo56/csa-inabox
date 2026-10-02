/**
 * Item scope for the dataset editor's routes (`dataset/[id]`, `/preview`,
 * `/lineage`), matching the lakehouse routes: the caller needs read access to
 * the Loom `dataset` item `[id]` (`resolveItemAccessByOid`, called in each
 * route), and a tenant admin may open a Foundry data asset by name.
 *
 * `[id]` is passed to Foundry as the data-asset NAME, and no dataset item
 * records which asset it stands for yet (#4826). Until it does, a caller who is
 * not a tenant admin gets the 404 below, whose `code` the dataset editor turns
 * into an explanation instead of a bare error.
 */
import { NextResponse } from 'next/server';

/** The `code` the dataset editor recognises for this refusal. */
export const DATASET_ITEM_NOT_FOUND = 'dataset_item_not_found';

export const DATASET_ITEM_MAPPING_ISSUE = 'https://github.com/fgarofalo56/csa-inabox/issues/4826';

/** 404 for a caller who cannot read a dataset item with this id. */
export function datasetItemNotFound(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: 'No dataset item you can read has this id.',
      code: DATASET_ITEM_NOT_FOUND,
      remediation:
        'Open the data asset from a Loom dataset item you can read. Loom does not yet link dataset items to '
        + `Foundry data assets (${DATASET_ITEM_MAPPING_ISSUE}); until it does, a tenant admin opens data assets by name.`,
    },
    { status: 404 },
  );
}

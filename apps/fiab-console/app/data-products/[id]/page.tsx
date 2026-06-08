'use client';

import { use } from 'react';
import { DataProductDetails } from '@/lib/data-products/data-product-details';

/**
 * /data-products/[id] — data-product details / creation receipt. The static
 * /data-products/new route takes precedence for "new", so this only renders for
 * real Cosmos ids.
 */
interface Props { params: Promise<{ id: string }> }

export default function DataProductDetailsPage(props: Props) {
  const { id } = use(props.params);
  return <DataProductDetails id={id} />;
}

'use client';

import { use } from 'react';
import { DataProductDetailEditor } from '@/lib/editors/data-product-detail';

/**
 * F15 — consumer (read-only) data-product details page.
 *
 * The discoverable, non-owner-facing surface for a Published data product.
 * Reachable from the governance catalog (Open data product). Renders the
 * read-only details view + the purpose-bound "Request access" flow. Unlike
 * /items/data-product/[id] (the owner editor, gated on workspace ownership),
 * this page is open to any authenticated catalog reader.
 */
export default function DataProductConsumerPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  return <DataProductDetailEditor id={id} />;
}

/**
 * Access Requests page — Manage data access requests.
 * Stub page to prevent 404 from sidebar link.
 */

import { useRouter } from 'next/router';
import PageHeader from '@/components/PageHeader';

export default function AccessPage() {
  const router = useRouter();
  const { product_id } = router.query;

  return (
    <div>
      <PageHeader title="Access Requests" description="Manage data access requests" />
      {product_id ? (
        <div className="text-center py-12">
          <p className="text-gray-700 font-medium">
            Requesting access for product: <code className="bg-gray-100 px-2 py-1 rounded text-sm">{product_id}</code>
          </p>
          <p className="mt-2 text-sm text-gray-500">
            Access request form coming soon.
          </p>
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          Access request management coming soon.
        </div>
      )}
    </div>
  );
}

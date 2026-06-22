import { redirect } from 'next/navigation';

/**
 * Legacy /api-marketplace → the APIs tab of the unified Loom Marketplace.
 * The standalone "API marketplace" merged into /marketplace (data products +
 * APIs + Delta Sharing data shares in one surface).
 */
export default function ApiMarketplaceRedirect() {
  redirect('/marketplace?tab=apis');
}

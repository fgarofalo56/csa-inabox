import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * /admin/add-landing-zone — kept as a stable deep-link, now consolidated into
 * the Setup & landing-zones surface. The attach FORM and the new DLZ overview
 * live together as tabs under /admin/landing-zones (item-1/item-3); this route
 * redirects to the Attach tab so existing links / the admin nav keep working
 * without dropping the operator into a context-free form.
 */
export default function AddLandingZonePage() {
  redirect('/admin/landing-zones?tab=attach');
}

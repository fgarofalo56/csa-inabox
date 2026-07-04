import { redirect } from 'next/navigation';

/**
 * /rti-hub — consolidated into the Real-Time Intelligence hub.
 *
 * Source discovery (<RtiHubView>) now renders as the "Discover sources" tab of
 * /realtime-hub. This page preserves old bookmarks / links by bouncing to the
 * tab so the full surface always renders.
 */
export default function RtiHubRedirect() {
  redirect('/realtime-hub?tab=sources');
}

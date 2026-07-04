import { redirect } from 'next/navigation';

/**
 * /business-events — consolidated into the Real-Time Intelligence hub.
 *
 * Business events (<BusinessEventsView>) now renders as the "Business events"
 * tab of /realtime-hub. This page preserves old bookmarks / links by bouncing
 * to the tab so the full surface always renders.
 */
export default function BusinessEventsRedirect() {
  redirect('/realtime-hub?tab=events');
}

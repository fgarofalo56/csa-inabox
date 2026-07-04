import { redirect } from 'next/navigation';

/**
 * /activator-hub — consolidated into the Real-Time Intelligence hub.
 *
 * The workspace-level Activator overview (<ActivatorPane>) now renders as the
 * "Activator" tab of /realtime-hub. This page preserves old bookmarks / links
 * by bouncing to the tab so the full surface always renders. (Previously this
 * and /activator both titled "Activator"; that duplicate is now removed —
 * both are redirects into the single hub tab.)
 */
export default function ActivatorHubRedirect() {
  redirect('/realtime-hub?tab=activator');
}

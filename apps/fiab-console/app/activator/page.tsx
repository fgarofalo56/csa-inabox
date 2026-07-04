import { redirect } from 'next/navigation';

/**
 * /activator — consolidated into the Real-Time Intelligence hub.
 *
 * Activator now lives as the "Activator" tab of /realtime-hub (rendered by
 * <RealTimeIntelligenceHub>). This page preserves old bookmarks / links by
 * bouncing to the tab so the full Activator surface always renders.
 */
export default function ActivatorRedirect() {
  redirect('/realtime-hub?tab=activator');
}

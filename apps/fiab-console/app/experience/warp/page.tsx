import { redirect } from 'next/navigation';

/**
 * /experience/warp — the bare Warp experience segment.
 *
 * The Warp surface lives at /experience/warp/home (rendered by
 * <WarpHubContent>). Without this page, hitting the bare /experience/warp
 * segment (an old bookmark, a truncated link, or the nav root) renders a blank
 * Next.js 404 with no visual surface — the "Wrap/Warp page is blank" report.
 * Bounce to the real home so the segment always shows the full Warp build.
 */
export default function WarpLanding() {
  redirect('/experience/warp/home');
}

import { redirect } from 'next/navigation';

/**
 * /experience — the bare experience segment.
 *
 * Individual experiences live under /experience/<name>/home (e.g.
 * /experience/data-science/home, /experience/warp/home). Without this page,
 * hitting the bare /experience segment (an old bookmark, a truncated link, or
 * the nav root) renders a blank Next.js 404 with no visual surface. Bounce to
 * the primary Data Science experience so the segment always shows a full build.
 */
export default function ExperienceLanding() {
  redirect('/experience/data-science/home');
}

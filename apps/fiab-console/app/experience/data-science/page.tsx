import { redirect } from 'next/navigation';

/**
 * /experience/data-science — the bare Data Science experience segment.
 *
 * The Data Science surface lives at /experience/data-science/home. Without
 * this page, hitting the bare /experience/data-science segment (an old
 * bookmark, a truncated link, or the nav root) renders a blank Next.js 404
 * with no visual surface. Bounce to the real home so the segment always shows
 * the full build.
 */
export default function DataScienceLanding() {
  redirect('/experience/data-science/home');
}

/**
 * /estate — WS-8 Estate builder (NL-to-Full-Estate + One-Canvas authoring).
 *
 * A thin server page that renders the client console. Both surfaces (describe /
 * draw) plan a reviewable estate plan-model and build it via the real Weave
 * bridges — see lib/estate/estate-console.tsx.
 */
import { EstateConsole } from '@/lib/estate/estate-console';

export const dynamic = 'force-dynamic';

export default function EstatePage() {
  return <EstateConsole />;
}

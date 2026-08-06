// Root App Router loading state (FINISHLINE C14).
//
// `app/` shipped `error.tsx` + `global-error.tsx` but no ROOT `loading.tsx` —
// only 40 segment-level ones. Any route segment without its own loading.tsx
// (and any future segment added without one) therefore streamed in against a
// blank body instead of the designed placeholder, which is the exact defect
// apex A2 fixed per-segment. This is the catch-all: Next.js walks UP the
// segment tree for the nearest loading boundary, so a root file covers every
// segment that does not define its own, permanently.
//
// Uses the shared RouteLoading primitive (Fluent v9 Spinner + Loom spacing
// tokens, role="status"/aria-live) — never a hand-rolled div (web3-ui.md §2).
import { RouteLoading } from '@/lib/components/route-loading';

export default function RootLoading() {
  return <RouteLoading />;
}

/**
 * Admin -> Loom Brain (the Visualizer).
 *
 * Server component wrapper, matching the pattern every other admin page uses
 * (`AdminShell` + a `learn` popover + a client pane) so this surface reads as
 * the same product rather than as a new one (`web3-ui.md` §4).
 */

import { AdminShell } from '@/lib/components/admin-shell';
import { BrainPane } from './brain-pane';

export const metadata = { title: 'Loom Brain' };

export default function AdminBrainPage() {
  return (
    <AdminShell
      sectionTitle="Loom Brain"
      learn={{
        title: 'Loom Brain — the estate graph',
        content:
          'Loom reads every Container App, job and environment it can see across your subscriptions, ' +
          'builds a graph of how they are wired, and looks for services nothing points at. A service ' +
          'can be perfectly healthy and still be waste: if no running configuration names it, nothing ' +
          'can call it, and if it also runs always-on replicas it bills every second for nobody. ' +
          'That is a question only reachability answers — a health check clears these services.',
        tips: [
          'Red, dashed edges are wires that exist and point at nothing — the evidence that something tried to connect a service and shipped a broken value.',
          'The Synapses tab paints the same graph with four layers: what to prune, what is risky, which paths carry real traffic, and what formed since the last version. A layer that could not be evaluated says so instead of showing a zero.',
          'The Brain recommends and never acts. Approving a recommendation records your decision; the change itself is a repository edit you make.',
          'Read the Coverage tab before reading a clean result as a clean estate: a detector whose data was never collected also reports zero findings, and it says so there.',
          'Cost figures are DERIVED — measured SKU multiplied by a published retail rate — never a bill.',
          'Cleanup proposals are withheld for any resource whose ownership is not established, because most Container App environments in these subscriptions are not Loom’s.',
        ],
      }}
    >
      <BrainPane />
    </AdminShell>
  );
}

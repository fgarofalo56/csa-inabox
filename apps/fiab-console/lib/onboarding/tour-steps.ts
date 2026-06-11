/**
 * Declarative step registry for the first-run guided tour.
 *
 * Each step spotlights a REAL, already-shipped anchor in the AppShell (tagged
 * with a stable `data-tour="…"` attribute) — the tour invents no new UI, it
 * teaches the surfaces that exist. This mirrors Microsoft Fabric Home's
 * "key areas" onboarding (numbered nav / switcher / create / top bar /
 * learning resources / your content) rather than a blocking modal.
 *
 * The registry is a fixed, typed array (no freeform/JSON config) per the Loom
 * no-freeform-config rule. To change the tour, edit this file and bump
 * {@link TOUR_VERSION} so returning users see the refreshed flow once.
 */

export interface TourStep {
  /** Stable id (used for analytics / step keys). */
  id: string;
  /**
   * Route to navigate to before showing this step. Omit for steps whose anchor
   * is present on every route (e.g. the topbar). Cross-surface steps push this
   * route then wait for the anchor to mount.
   */
  route?: string;
  /**
   * CSS selector resolving the anchor element to spotlight. Anchors are stable
   * `[data-tour="…"]` attributes added to real shell elements.
   */
  anchorSelector: string;
  /** Heading shown in the teaching bubble. */
  title: string;
  /** Body copy — one or two short sentences. */
  body: string;
  /** Optional "Learn more" deep-link to a real Loom route. */
  docHref?: string;
  /** Bubble placement relative to the anchor. */
  position?: 'above' | 'below' | 'before' | 'after';
}

/**
 * Bump when the tour content/flow materially changes. Persistence keys are
 * namespaced by version, so a bump re-offers the tour to everyone exactly once
 * (their prior "completed" flag is for the old version).
 */
export const TOUR_VERSION = 1;

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    anchorSelector: '[data-tour="brand"]',
    title: 'Welcome to CSA Loom',
    body:
      'CSA Loom weaves every Azure data service into one experience — lakehouses, ' +
      'warehouses, real-time intelligence, pipelines, and governance. This 60-second ' +
      'tour shows you the core surfaces. You can skip it and replay it anytime from Help.',
    position: 'below',
  },
  {
    id: 'nav',
    anchorSelector: '[data-tour="nav"]',
    title: 'Navigate your platform',
    body:
      'The left rail is your map: Workspaces, the OneLake & Unified catalogs, Lineage, ' +
      'Governance, Monitor, and the Real-Time hub. Everything you build lives in a ' +
      'workspace — start there.',
    docHref: '/workspaces',
    position: 'after',
  },
  {
    id: 'search',
    anchorSelector: '[data-tour="search"]',
    title: 'Find anything fast',
    body:
      'Search items, settings, and item types — or press Ctrl+K from anywhere to open ' +
      'the command palette and jump straight to an action.',
    position: 'below',
  },
  {
    id: 'copilot',
    anchorSelector: '[data-tour="copilot"]',
    title: 'Ask the Help Copilot',
    body:
      'Stuck on a concept or a control? The Help Copilot answers questions about CSA ' +
      'Loom in context. Open it anytime with Ctrl+/.',
    position: 'below',
  },
  {
    id: 'help',
    anchorSelector: '[data-tour="help"]',
    title: 'Learn library & guided tutorials',
    body:
      'The Learn library has step-by-step tutorials and use-case walkthroughs you can ' +
      'import with sample data. Open it from this Help button whenever you want depth.',
    docHref: '/learn',
    position: 'below',
  },
  {
    id: 'setup',
    route: '/setup',
    anchorSelector: '[data-tour="setup-intro"]',
    title: 'Provision a Data Landing Zone',
    body:
      'When you are ready to deploy, the Setup wizard provisions a new Data Landing Zone ' +
      'on Azure-native backends — choose a boundary, region, and capacity, then review the ' +
      'generated Bicep before launching. That completes the tour.',
    position: 'after',
  },
];

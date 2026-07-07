/**
 * Label policy library — curated, best-practice Information Protection (MIP)
 * label POLICY presets, Loom-native and Cosmos-backed.
 *
 * Mirrors `dlp-policy-library.ts`. A *label policy* publishes a set of
 * sensitivity labels to a scope of users and sets labelling behaviour (default
 * label, mandatory labelling, justification on downgrade). Per
 * `.claude/rules/no-fabric-dependency.md` + `no-vaporware.md` this requires NO
 * Microsoft Purview / SCC sidecar / Graph AppRole: enabling a preset writes a
 * genuine Loom governance policy (kind: 'Label') to the tenant Cosmos store, and
 * Loom's own item editors honour it. An OPTIONAL live sync to Microsoft
 * Information Protection (via the SCC sidecar) can be layered on top later — it
 * is not required for the library, the default policy, or day-one enforcement.
 *
 * NO freeform: users pick a preset from this library or fill the structured
 * custom wizard (per the no-freeform-config rule).
 */

/** The Loom sensitivity-label taxonomy these policies publish (handling levels). */
export const LABEL_TAXONOMY: { id: string; name: string; color: string; order: number }[] = [
  { id: 'public', name: 'Public', color: '#5B8C51', order: 0 },
  { id: 'internal', name: 'Internal', color: '#0F6CBD', order: 1 },
  { id: 'confidential', name: 'Confidential', color: '#CA5010', order: 2 },
  { id: 'restricted', name: 'Restricted', color: '#C50F1F', order: 3 },
];

export type LabelPresetCategory = 'General' | 'Government' | 'Financial' | 'Healthcare' | 'Regulated';

/** Who a label policy is published to. */
export type LabelPolicyScope = 'all-users' | 'admins' | 'group';

/** A curated, one-click-enable label policy preset. */
export interface LabelPolicyPreset {
  id: string;
  name: string;
  description: string;
  category: LabelPresetCategory;
  /** Icon key mapped to a Fluent icon in the UI (store/route stay icon-free). */
  icon: string;
  /** Regulation / framework this maps to, for the card subtitle. */
  regulation?: string;
  /** Ordered label ids this policy publishes (subset of LABEL_TAXONOMY). */
  labels: string[];
  /** The label applied by default to new/unlabelled content ('' = none). */
  defaultLabelId: string;
  /** Require a label before an item can be saved/shared. */
  mandatory: boolean;
  /** Require a justification when a user lowers or removes a label. */
  justificationOnDowngrade: boolean;
  /** Who the policy is published to. */
  scope: LabelPolicyScope;
  /** Microsoft Learn source for the equivalent MIP policy. */
  learnUrl: string;
}

/**
 * The curated preset catalog. Each entry is a real MIP label-policy shape
 * reduced to its published-label set + behaviour. Enabling one writes a genuine
 * Loom governance policy (kind: 'Label') to the tenant store.
 */
export const LABEL_POLICY_PRESETS: LabelPolicyPreset[] = [
  {
    id: 'loom-baseline',
    name: 'Loom Baseline Labelling',
    description:
      'Best-practice starting point — publishes the four handling levels (Public, Internal, Confidential, Restricted) to everyone, defaults new content to Internal, and asks for a justification when a user lowers a label. Recommended (non-mandatory) so it never blocks work on day one.',
    category: 'General',
    icon: 'shield',
    regulation: 'Loom best practice (extends Microsoft default label policy)',
    labels: ['public', 'internal', 'confidential', 'restricted'],
    defaultLabelId: 'internal',
    mandatory: false,
    justificationOnDowngrade: true,
    scope: 'all-users',
    learnUrl: 'https://learn.microsoft.com/purview/create-sensitivity-labels',
  },
  {
    id: 'mandatory-labelling',
    name: 'Mandatory Labelling',
    description:
      'Every item must carry a sensitivity label before it can be saved or shared, and downgrades require a justification. Use when a compliance program requires 100% labelling coverage.',
    category: 'Regulated',
    icon: 'lock',
    regulation: 'Mandatory labelling (Purview label policy — "Require users to apply a label")',
    labels: ['public', 'internal', 'confidential', 'restricted'],
    defaultLabelId: 'confidential',
    mandatory: true,
    justificationOnDowngrade: true,
    scope: 'all-users',
    learnUrl: 'https://learn.microsoft.com/purview/sensitivity-labels#what-label-policies-can-do',
  },
  {
    id: 'us-gov-cui',
    name: 'U.S. Government (CUI)',
    description:
      'Controlled Unclassified Information handling — defaults to Confidential, mandatory labelling, and justification on downgrade. Aligns label handling with NIST SP 800-171 / CMMC expectations for CUI.',
    category: 'Government',
    icon: 'gov',
    regulation: 'CUI / NIST SP 800-171 / CMMC',
    labels: ['internal', 'confidential', 'restricted'],
    defaultLabelId: 'confidential',
    mandatory: true,
    justificationOnDowngrade: true,
    scope: 'all-users',
    learnUrl: 'https://learn.microsoft.com/purview/sensitivity-labels',
  },
  {
    id: 'financial-pci-sox',
    name: 'Financial (PCI-DSS / SOX)',
    description:
      'Cardholder and financial-reporting data — defaults to Confidential and requires a justification to downgrade, so PCI-DSS / SOX-scoped data cannot be quietly declassified.',
    category: 'Financial',
    icon: 'money',
    regulation: 'PCI-DSS 4.0 / Sarbanes-Oxley',
    labels: ['internal', 'confidential', 'restricted'],
    defaultLabelId: 'confidential',
    mandatory: false,
    justificationOnDowngrade: true,
    scope: 'all-users',
    learnUrl: 'https://learn.microsoft.com/purview/sensitivity-labels',
  },
  {
    id: 'healthcare-hipaa',
    name: 'Healthcare (HIPAA)',
    description:
      'Protected Health Information handling — publishes Confidential + Restricted, defaults to Confidential, and requires justification on downgrade to preserve the HIPAA minimum-necessary principle.',
    category: 'Healthcare',
    icon: 'health',
    regulation: 'HIPAA / HITECH',
    labels: ['internal', 'confidential', 'restricted'],
    defaultLabelId: 'confidential',
    mandatory: false,
    justificationOnDowngrade: true,
    scope: 'all-users',
    learnUrl: 'https://learn.microsoft.com/purview/sensitivity-labels',
  },
  {
    id: 'highly-confidential',
    name: 'Highly Confidential Default',
    description:
      'Conservative posture for high-sensitivity tenants — new content defaults to Restricted and labelling is mandatory, so nothing starts unprotected. Downgrades require justification.',
    category: 'Regulated',
    icon: 'lock',
    regulation: 'Loom best practice (high-sensitivity)',
    labels: ['confidential', 'restricted'],
    defaultLabelId: 'restricted',
    mandatory: true,
    justificationOnDowngrade: true,
    scope: 'all-users',
    learnUrl: 'https://learn.microsoft.com/purview/sensitivity-labels',
  },
];

/** The preset enabled out-of-the-box (default-on, day one). */
export const DEFAULT_LABEL_POLICY_PRESET_ID = 'loom-baseline';

const PRESET_BY_ID = new Map(LABEL_POLICY_PRESETS.map((p) => [p.id, p]));

export function getLabelPreset(id: string): LabelPolicyPreset | undefined {
  return PRESET_BY_ID.get(id);
}

/** Structured label-policy fields persisted on a governance Policy (kind: 'Label'). */
export interface LabelPolicyBody {
  labels: string[];
  defaultLabelId: string;
  mandatory: boolean;
  justificationOnDowngrade: boolean;
  scope: LabelPolicyScope;
}

/** Human-readable one-line rule summary for a label-policy body (table display). */
export function describeLabelPolicy(b: LabelPolicyBody): string {
  const parts = [`Publishes ${b.labels.length} label${b.labels.length === 1 ? '' : 's'}`];
  const def = LABEL_TAXONOMY.find((l) => l.id === b.defaultLabelId);
  if (def) parts.push(`default ${def.name}`);
  if (b.mandatory) parts.push('mandatory');
  if (b.justificationOnDowngrade) parts.push('justify downgrade');
  return parts.join(' · ');
}

/** The persisted-policy body for a preset (source of truth for enable + seed). */
export function labelPolicyBodyFromPreset(preset: LabelPolicyPreset) {
  const body: LabelPolicyBody = {
    labels: preset.labels,
    defaultLabelId: preset.defaultLabelId,
    mandatory: preset.mandatory,
    justificationOnDowngrade: preset.justificationOnDowngrade,
    scope: preset.scope,
  };
  return {
    name: preset.name,
    kind: 'Label' as const,
    scope: preset.scope === 'all-users' ? 'All users' : preset.scope,
    rule: describeLabelPolicy(body),
    enabled: true,
    label: body,
    source: `preset:${preset.id}`,
    builtin: preset.id === DEFAULT_LABEL_POLICY_PRESET_ID,
    category: preset.category,
  };
}

/** The seeded best-practice default label policy (default-on, day one). */
export function defaultLabelPolicyBody() {
  return labelPolicyBodyFromPreset(getLabelPreset(DEFAULT_LABEL_POLICY_PRESET_ID)!);
}

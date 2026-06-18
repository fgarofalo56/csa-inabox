/**
 * loom-subscriptions — the single source of truth for "which subscription does
 * each Loom resource group live in?" and "which subscriptions does the whole
 * Loom deployment span?".
 *
 * WHY THIS EXISTS (the multi-sub RG/subscription bug)
 * ---------------------------------------------------
 * In the multi-sub topology the DLZ resource group lives in a DIFFERENT
 * subscription (`LOOM_DLZ_SUBSCRIPTION_ID`) than the admin/hub RG
 * (`LOOM_SUBSCRIPTION_ID`). Code that paired the DLZ RG with the admin sub when
 * building an ARM URL hit `ResourceGroupNotFound` (404) — the live symptom
 * "Resource group 'rg-csa-loom-dlz-default-centralus' could not be found".
 *
 * The canonical fix (first landed in app/api/admin/azure-resources/route.ts,
 * PR #1462) pairs EACH resource group with its OWN subscription: the admin RG
 * with LOOM_SUBSCRIPTION_ID, the DLZ RG(s) with
 * LOOM_DLZ_SUBSCRIPTION_ID || LOOM_SUBSCRIPTION_ID. This module generalises that
 * pairing so every Monitor / Cost / Connections / Network surface resolves the
 * same way instead of each re-deriving (often incorrectly) from a single
 * LOOM_SUBSCRIPTION_ID.
 *
 * Cloud-invariant: no hosts here, only env-derived subscription/RG strings.
 */

/** The DLZ subscription id, or null when single-sub (DLZ RG lives in the admin sub). */
export function dlzSubscriptionId(): string | null {
  // LOOM_DLZ_SUBSCRIPTION_ID is the canonical name emitted by the dlz-attach
  // env module (hub-console-dlz-env.bicep). LOOM_DLZ_SUB is a legacy alias some
  // older clients read — honour both so a partially-migrated deployment works.
  const v = (process.env.LOOM_DLZ_SUBSCRIPTION_ID || process.env.LOOM_DLZ_SUB || '').trim();
  return v || null;
}

/** The admin/hub subscription id (the sub the console container app runs in). */
export function adminSubscriptionId(): string | null {
  const v = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  return v || null;
}

/**
 * Every subscription the Loom deployment spans, de-duplicated, order preserved
 * (admin first). Unions the admin sub, the DLZ sub, the comma-separated
 * LOOM_EXTRA_SUBSCRIPTIONS / LOOM_COST_SUBSCRIPTIONS, and the legacy per-service
 * sub overrides (Event Hubs / Stream Analytics / AI Search / Foundry / Kusto).
 *
 * Used by surfaces that must enumerate ACROSS subscriptions (cost aggregation,
 * resource health, Defender, connection-source pickers, network topology).
 */
export function loomSubscriptionScope(): string[] {
  const subs = new Set<string>();
  const add = (v?: string | null) => { if (v && v.trim()) subs.add(v.trim()); };
  add(adminSubscriptionId());
  add(dlzSubscriptionId());
  // Per-service sub overrides — a BYO/attached resource may live in its own sub.
  add(process.env.LOOM_ASA_SUB);
  add(process.env.LOOM_EVENTHUB_SUB);
  add(process.env.LOOM_AI_SEARCH_SUB);
  add(process.env.LOOM_FOUNDRY_SUB);
  add(process.env.LOOM_KUSTO_SUB);
  for (const s of (process.env.LOOM_EXTRA_SUBSCRIPTIONS || '').split(',')) add(s);
  for (const s of (process.env.LOOM_COST_SUBSCRIPTIONS || '').split(',')) add(s);
  return Array.from(subs);
}

export interface ResourceGroupScope {
  /** The resource group name. */
  rg: string;
  /** The subscription the resource group actually lives in. */
  sub: string;
}

/**
 * Pair each distinct Loom resource group with the subscription it actually
 * lives in. The DLZ resource group (LOOM_DLZ_RG) is paired with the DLZ sub
 * (LOOM_DLZ_SUBSCRIPTION_ID, falling back to the admin sub for single-sub
 * deploys); every other Loom RG is paired with the admin sub.
 *
 * `adminSub` is required (caller has already validated LOOM_SUBSCRIPTION_ID).
 * Returns one entry per (rg, sub) pair, de-duplicated.
 */
export function loomResourceGroupScopes(adminSub: string): ResourceGroupScope[] {
  const dlzSub = dlzSubscriptionId() || adminSub;
  const dlzRg = (process.env.LOOM_DLZ_RG || '').trim().toLowerCase();

  // Admin-plane RGs live in the admin sub; the DLZ RG lives in the DLZ sub.
  const adminRgEnvs = [
    process.env.LOOM_ADMIN_RG,
    process.env.LOOM_ACA_RG,
    process.env.LOOM_AI_SEARCH_RG,
    process.env.LOOM_KUSTO_RG,
    process.env.LOOM_APIM_RG,
    process.env.LOOM_FOUNDRY_RG,
    process.env.LOOM_AOAI_RG,
  ];

  const seen = new Set<string>();
  const out: ResourceGroupScope[] = [];
  const push = (rg: string | undefined, sub: string) => {
    const name = (rg || '').trim();
    if (!name) return;
    const key = `${sub}/${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rg: name, sub });
  };

  for (const rg of adminRgEnvs) {
    // A *_RG that happens to equal LOOM_DLZ_RG belongs to the DLZ sub.
    const sub = (rg || '').trim().toLowerCase() === dlzRg && dlzRg ? dlzSub : adminSub;
    push(rg, sub);
  }
  // The DLZ RG itself → DLZ sub.
  push(process.env.LOOM_DLZ_RG, dlzSub);

  return out;
}

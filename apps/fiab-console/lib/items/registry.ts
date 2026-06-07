/**
 * lib/items/registry.ts
 *
 * Item-type PAIRING rules for the install-time provisioning engine.
 *
 * When a parent item provisions successfully (status 'created' | 'exists'), the
 * engine consults this registry and auto-creates each declared paired item — a
 * real Cosmos item + a real provisioner call — so 1:1 pairings are guaranteed
 * without bundle authors having to list the sibling component by hand.
 *
 * Foundation pairing (no-fabric-dependency.md): every `lakehouse` is paired
 * with a `synapse-serverless-sql-pool` so F3 (lakehouse) and F14 (Serverless
 * SQL editor) share one Synapse Serverless built-in endpoint over the same lake
 * root. The pairing is ALWAYS applied on the Azure-native default path — no env
 * gate; deriveContent simply forwards the parent's abfss root and the paired
 * provisioner gates honestly if it (e.g. on the opt-in Fabric path) is absent.
 */
import type { ProvisionResult, ProvisionerInput } from '@/lib/install/provisioners/types';

export interface PairedItemDef {
  /** Item-type slug of the auto-created sibling. */
  pairedType: string;
  /**
   * Build the sibling's state.content from the parent result + input. Return
   * null to skip creating the sibling entirely (no data to pair on); return an
   * object (possibly with null fields) to create it and let the paired
   * provisioner gate on missing data with its own honest remediation.
   */
  deriveContent: (
    parentResult: ProvisionResult,
    parentInput: ProvisionerInput,
  ) => Record<string, unknown> | null;
  /** Derive the sibling's display name. Defaults to `${displayName} SQL Analytics`. */
  deriveName?: (parentInput: ProvisionerInput) => string;
}

/**
 * Maps parent item type → list of auto-paired item definitions. Consumed by
 * provisioning-engine.ts in a post-provision pass.
 */
export const ITEM_PAIRING_RULES: Record<string, PairedItemDef[]> = {
  lakehouse: [
    {
      pairedType: 'synapse-serverless-sql-pool',
      deriveContent: (result, input) => ({
        adlsRoot: result.secondaryIds?.adlsRoot ?? null,
        lakehouseItemId: input.cosmosItemId,
        lakehouseName: input.displayName,
      }),
      deriveName: (input) => `${input.displayName} SQL Analytics`,
    },
  ],
};

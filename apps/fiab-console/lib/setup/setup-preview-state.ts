/**
 * The narrow slice of the Setup Wizard's state that the `.bicepparam` preview
 * reads. Declared separately so `lib/setup/bicep-preview.ts` does not have to
 * import the wizard pane (a client component) to know its input shape.
 */
export interface SetupPreviewState {
  boundary?: 'Commercial' | 'GCC' | 'GCC-High' | 'IL5';
  mode?: 'single-sub' | 'multi-sub';
  subscriptionId?: string;
  subscriptionName?: string;
  dlzSubscriptionId?: string;
  dlzSubscriptionName?: string;
  location?: string;
  domainName?: string;
  capacitySku?: string;
  loomOrgVisualsEnabled?: boolean;
  existingLoomStorageAccount?: string;
}

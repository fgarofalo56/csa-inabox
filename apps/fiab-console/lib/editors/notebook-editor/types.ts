// types.ts — model types/interfaces for the notebook-editor.
// No JSX; no 'use client' needed. Extracted verbatim from notebook-editor.tsx.

import type { FabricItemType } from '@/lib/catalog/fabric-item-types';

export interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
export interface NotebookLite { id: string; displayName: string; description?: string; folderId?: string | null; updatedAt?: string; }
export interface JobLite {
  id: string; status?: string; jobType?: string; invokeType?: string;
  startTimeUtc?: string; endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string } | null;
}
export interface LakehouseLite { id: string; displayName: string; description?: string; }
export interface AttachedSource {
  kind: 'lakehouse' | 'warehouse' | 'kql-database';
  id: string;
  displayName: string;
  isDefault?: boolean;
}

/** Shaped AML schedule row returned by /api/notebook/[id]/schedule (R4-NB-1). */
export interface AmlScheduleRow {
  name: string;
  displayName?: string;
  isEnabled: boolean;
  provisioningState?: string;
  frequency?: string;
  interval?: number;
  startTime?: string;
  timeZone?: string;
}

export interface Props { item: FabricItemType; id: string; }

export interface ComputeTarget {
  id: string;
  name: string;
  kind: 'synapse-spark' | 'databricks-cluster' | 'synapse-dedicated-sql' | 'synapse-serverless-sql' | 'aml-ci';
  state?: string;
  /** AML Compute Instance assigned to the caller (their own single-user CI). */
  mine?: boolean;
}

/** Notebook compute backend: Loom-native Spark/Databricks vs the Azure ML path. */
export type WorkspaceType = 'loom' | 'aml';

/** The caller's OWN per-user Compute Instance state + tenant quota + policy.
 *  AML Compute Instances are single-user, so a shared default CI can't make
 *  notebooks multi-user — every user provisions a CI assigned to THEM. Backs the
 *  "My compute" label + "Create my compute instance" action + honest quota gate. */
export interface MyCiState {
  loading: boolean;
  enabled: boolean;
  myName: string | null;
  mine: { name: string; state?: string; running?: boolean } | null;
  policy: { vmSize?: string; idleTtl?: string; maxPerTenant?: number } | null;
  quota: { used: number; max: number; atLimit: boolean } | null;
}

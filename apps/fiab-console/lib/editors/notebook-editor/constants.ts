// constants.ts — static constants for the notebook-editor.
// No JSX; no 'use client' needed. Extracted verbatim from notebook-editor.tsx.

export const STARTER_PY = `# Fabric Notebook (PySpark)\n# Edit, then click Save. Click Run cell to queue execution.\ndf = spark.range(10)\ndf.show()\n`;

/**
 * Pure, client-safe detection of a leading Synapse language magic. Mirrors
 * synapse-livy-client.parseMagicKind without importing it (that module pulls in
 * the Azure SDK, which must not land in the browser bundle). %%pyspark and its
 * aliases route the cell to the dedicated Spark backend (execute-spark).
 */
export const SPARK_MAGICS = ['%%pyspark', '%%python', '%%spark', '%%scala', '%%sql', '%%sparksql', '%%sparkr', '%%r'];

export const COMPUTE_RUNNING = ['Available', 'Online', 'Running', 'RUNNING', 'idle'];

/** AML Compute Instance states that mean "stopped — needs (auto-)start". */
export const CI_STOPPED = ['Stopped', 'stopped', 'Deallocated'];

/**
 * Idle auto-shutdown TTL options (ISO-8601 duration → label) offered in the
 * Configure / New Compute Instance dialogs. Dropdown only — no freeform input
 * (loom_no_freeform_config). Backs both the create body and the
 * updateIdleShutdownSetting route.
 */
export const IDLE_TTL_OPTIONS: { value: string; label: string }[] = [
  { value: 'PT15M', label: '15 minutes' },
  { value: 'PT30M', label: '30 minutes' },
  { value: 'PT1H', label: '1 hour' },
  { value: 'PT3H', label: '3 hours' },
];
export const TTL_LABEL: Record<string, string> = Object.fromEntries(IDLE_TTL_OPTIONS.map((o) => [o.value, o.label]));

/** Compute Instance VM sizes offered in the New Compute Instance dialog. */
export const AML_CI_VM_SIZES: { value: string; label: string }[] = [
  { value: 'Standard_DS3_v2', label: 'Standard_DS3_v2 · 4 vCPU · 14 GB' },
  { value: 'Standard_DS11_v2', label: 'Standard_DS11_v2 · 2 vCPU · 14 GB' },
  { value: 'Standard_DS12_v2', label: 'Standard_DS12_v2 · 4 vCPU · 28 GB' },
  { value: 'Standard_E4ds_v4', label: 'Standard_E4ds_v4 · 4 vCPU · 32 GB' },
  { value: 'Standard_NC6s_v3', label: 'Standard_NC6s_v3 · 6 vCPU · 112 GB · 1×V100 GPU' },
];

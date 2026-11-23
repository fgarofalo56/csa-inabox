/**
 * The engine reconciles its own partitions (LHDS W2-2b B2e, #5422 decision 11): the control plane renders the
 * desired list into the engine's environment, and this package creates the missing ones in-process at startup.
 * No HTTP call is made and no authentication exemption exists for the partition-management operations.
 */
package ai.loom.health.fhir.partition;

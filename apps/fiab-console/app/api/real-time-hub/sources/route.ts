/**
 * GET /api/real-time-hub/sources
 *
 * Stable alias for `GET /api/rti-hub`. Returns the identical Real-Time hub
 * catalog payload — real streaming sources enumerated across subscriptions via
 * Azure Resource Graph (Event Hub namespaces, IoT Hubs, ADX clusters) merged
 * with the caller's Loom eventstream / KQL / Eventhouse items, grouped into
 * `tabs.dataStreams` / `tabs.azureEvents` / `tabs.fabricEvents`.
 *
 * No new logic lives here: all real Azure calls remain in the canonical route
 * and `lib/azure/eventhubs-client.ts`. This file exists only so callers that
 * expect the hyphenated path get the same data.
 */
export { GET, runtime, dynamic } from '@/app/api/rti-hub/route';

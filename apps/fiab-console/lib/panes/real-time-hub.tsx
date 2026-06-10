'use client';

/**
 * RealTimeHubPane — live Real-Time Intelligence hub catalog.
 *
 * The legacy implementation here rendered a static, hard-coded `SOURCES` array
 * of dead cards (no fetch, no click wiring) and was orphaned — nothing imported
 * it. Per .claude/rules/no-vaporware.md that static surface is removed.
 *
 * This pane now delegates entirely to {@link RtiHubView}, which:
 *   - fetches real streaming sources from `GET /api/rti-hub` (Azure Resource
 *     Graph enumeration of Event Hub namespaces, IoT Hubs, ADX clusters across
 *     subscriptions, plus the caller's Loom eventstream / KQL / Eventhouse
 *     items) — Azure-native by default, no Microsoft Fabric required,
 *   - wires every source row's Subscribe action to the ConnectSourceDialog,
 *     which creates a real Loom eventstream and surfaces an "Open eventstream
 *     editor" link, and
 *   - renders honest empty-search / empty-tab / infra-gate states.
 */
export { RtiHubView as RealTimeHubPane } from '@/lib/components/realtime-hub/rti-hub-view';

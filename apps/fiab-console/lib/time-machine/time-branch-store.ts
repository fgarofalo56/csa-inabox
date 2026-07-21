/**
 * Time-Machine (WS-10.3 / BTB-10) — time-branch store (branch = shadow workspace).
 *
 * A "time-branch" is a NAMED, pinned as-of snapshot over an existing workspace:
 * the sovereign, zero-copy analogue of a git branch for data. It does NOT copy
 * any bytes — it is a lightweight pointer that pins ONE {@link AsOfSpec} so the
 * whole workspace can be queried AS OF that point in time via the shared temporal
 * coordinator (a shadow workspace = the same items, read at time T). Selecting a
 * branch in the global time-bar sets the session `asOf` to the branch's pin, and
 * every surface flows it into the coordinator — the ontology, reports, and
 * pipeline outputs all resolve as of the branch's T.
 *
 * Persisted in the `time-branches` Cosmos container (PK /workspaceId — one
 * physical partition per workspace, so every list is a single-partition query).
 * Real Cosmos I/O, no mocks (no-vaporware.md). Azure-native, Gov-safe — no
 * Fabric / OneLake dependency (no-fabric-dependency.md).
 */
import { randomUUID } from 'crypto';
import { timeBranchesContainer } from '@/lib/azure/cosmos-client';
import {
  parseAsOf, serializeAsOf, asOfLabel, isLive, TimeMachineError, type AsOfSpec,
} from './time-machine';

/** Max branches retained per workspace (guards a runaway partition). */
export const MAX_TIME_BRANCHES_PER_WORKSPACE = 200;

/** Persisted time-branch document (PK /workspaceId). */
export interface TimeBranchDoc {
  id: string;                 // `tb:<workspaceId>:<uuid>`
  docType: 'time-branch';
  workspaceId: string;        // partition key
  name: string;
  description?: string;
  /** The pinned point-in-time (never `live` — a branch must fix a T). */
  asOf: AsOfSpec;
  createdAt: string;          // ISO
  createdBy: string;          // Entra oid
  createdByName?: string;
}

/** The client-facing view (adds the human label + wire form of the pin). */
export interface TimeBranchView {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  asOf: AsOfSpec;
  /** Serialized pin for the `asOf` query param / time-bar (e.g. `v:42` or the ISO). */
  asOfValue: string;
  /** Human label ("as of 2026-07-01T00:00:00.000Z"). */
  asOfLabel: string;
  createdAt: string;
  createdBy: string;
  createdByName?: string;
}

const NAME_MAX = 120;

/** Validated create input. */
export interface TimeBranchInput {
  name: string;
  asOf: AsOfSpec;
  description?: string;
}

/**
 * Validate + normalize a raw create body ({ name, asOf, description }). `asOf`
 * accepts anything {@link parseAsOf} does (ISO / bare date / `v:<n>`), but a
 * branch MUST pin a real point in time — a live/empty asOf is rejected (there is
 * nothing to branch). THROWS {@link TimeMachineError} with an actionable message.
 */
export function normalizeTimeBranchInput(raw: {
  name?: unknown;
  asOf?: unknown;
  description?: unknown;
}): TimeBranchInput {
  const name = String(raw?.name ?? '').trim();
  if (!name) throw new TimeMachineError('A branch name is required.');
  if (name.length > NAME_MAX) throw new TimeMachineError(`Branch name must be ≤ ${NAME_MAX} characters.`);

  const asOfRaw = raw?.asOf;
  const asOf = parseAsOf(
    typeof asOfRaw === 'number' || typeof asOfRaw === 'string' ? asOfRaw : String(asOfRaw ?? ''),
  );
  if (isLive(asOf)) {
    throw new TimeMachineError('A time-branch must pin a specific point in time — provide an asOf timestamp or Delta version (not "live").');
  }

  const description = raw?.description != null ? String(raw.description).trim().slice(0, 500) : undefined;
  return { name, asOf, ...(description ? { description } : {}) };
}

/** Project a stored doc to its client view. */
export function timeBranchView(doc: TimeBranchDoc): TimeBranchView {
  return {
    id: doc.id,
    workspaceId: doc.workspaceId,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    asOf: doc.asOf,
    asOfValue: serializeAsOf(doc.asOf),
    asOfLabel: asOfLabel(doc.asOf),
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    ...(doc.createdByName ? { createdByName: doc.createdByName } : {}),
  };
}

/** Deterministic-ish id for a new branch. */
export function newTimeBranchId(workspaceId: string): string {
  return `tb:${workspaceId}:${randomUUID()}`;
}

// ── Cosmos I/O ───────────────────────────────────────────────────────────────

/** Create a time-branch (shadow-workspace pin) for a workspace. */
export async function createTimeBranch(
  workspaceId: string,
  input: TimeBranchInput,
  actor: { oid: string; name?: string },
): Promise<TimeBranchView> {
  const container = await timeBranchesContainer();
  const doc: TimeBranchDoc = {
    id: newTimeBranchId(workspaceId),
    docType: 'time-branch',
    workspaceId,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    asOf: input.asOf,
    createdAt: new Date().toISOString(),
    createdBy: actor.oid,
    ...(actor.name ? { createdByName: actor.name } : {}),
  };
  const { resource } = await container.items.create(doc);
  return timeBranchView((resource as TimeBranchDoc) ?? doc);
}

/** List a workspace's time-branches, newest first (single-partition query). */
export async function listTimeBranches(workspaceId: string): Promise<TimeBranchView[]> {
  const container = await timeBranchesContainer();
  const { resources } = await container.items
    .query<TimeBranchDoc>(
      {
        query: "SELECT * FROM c WHERE c.workspaceId = @w AND c.docType = 'time-branch' ORDER BY c.createdAt DESC",
        parameters: [{ name: '@w', value: workspaceId }],
      },
      { partitionKey: workspaceId },
    )
    .fetchAll();
  return resources.map(timeBranchView);
}

/** Point-read one branch (owner/workspace scoping is enforced by the route). */
export async function getTimeBranch(workspaceId: string, id: string): Promise<TimeBranchView | null> {
  const container = await timeBranchesContainer();
  try {
    const { resource } = await container.item(id, workspaceId).read<TimeBranchDoc>();
    return resource ? timeBranchView(resource) : null;
  } catch {
    return null;
  }
}

/** Delete a branch. Returns true when a row was removed. */
export async function deleteTimeBranch(workspaceId: string, id: string): Promise<boolean> {
  const container = await timeBranchesContainer();
  try {
    await container.item(id, workspaceId).delete();
    return true;
  } catch {
    return false;
  }
}

/**
 * _content-readback.ts — CONFIRM the bundle content an install just reported is
 * actually readable back off the Cosmos item.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (#3549 / #3551)
 * ---------------------------------------------------------------------------
 * Some provisioners do not author a backing Azure object at all: the Cosmos
 * item's `state.content` IS the artifact, and "provisioning" is a validation
 * pass over the bundle's definition. `semantic-model`'s Loom-native default is
 * the canonical case — its own docstring says the tables/measures "are the
 * source of truth ON THE COSMOS ITEM".
 *
 * That sentence is an ASSUMPTION about a write performed by a DIFFERENT module
 * (`app/api/apps/[id]/install/route.ts`, which stamps `state.content` at item
 * creation). Nothing in the provisioner checked it. So the install could count
 * the bundle's 2 tables and 4 measures, report `status:'created'` with those
 * counts on the receipt, and be completely wrong about whether the editor would
 * ever see them — which is exactly the shape measured live on 2026-08-18: a
 * banner reading "2 tables · 4 measures" over an editor reading "no tables yet".
 *
 * Per `deploy-integrity.md` R6 a step must "never report success on an
 * unverified outcome", and per `no-vaporware.md` a receipt whose counts are
 * backed by nothing the user can reach is the named failure mode. So a
 * validate-only provisioner CONFIRMS the read-back before it may say `created`.
 *
 * ---------------------------------------------------------------------------
 * WHY `remediation` AND NOT `failed` ON A LOST READ-BACK
 * ---------------------------------------------------------------------------
 * `types.ts` reserves `failed` for genuine code defects. A Cosmos read that
 * 403s / 429s / has not replicated yet is infrastructure, and the retry is
 * safe — re-running the install re-stamps the same content. That is the same
 * classification `activator.ts` settled on for its own `state.rules` write
 * (#3693), and reusing it keeps ONE convention across the provisioners instead
 * of a third dialect. `isInfraOrPermissionError` reads the status off the error
 * OBJECT, so the original throw is carried through rather than just its prose.
 *
 * The read is retried with bounded backoff and FAILS CLOSED: on exhaustion it
 * reports what it could not establish, never a green `created`.
 */
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

/** Bounded retry — a freshly created item may still be replicating. */
export const READBACK_ATTEMPTS = 3;
const READBACK_BACKOFF_MS = [150, 400];

export type ContentReadback =
  | { ok: true; attempts: number }
  | {
      ok: false;
      attempts: number;
      /** 'item-not-found' — the read resolved no document (not a throw).
       *  'content-absent' — the item exists but carries no matching content.
       *  'read-failed'    — the read threw. */
      reason: 'item-not-found' | 'content-absent' | 'read-failed';
      /** Message for the receipt / step log. */
      error: string;
      /** The ORIGINAL throw, so the caller's classifier can read its status. */
      cause?: unknown;
    };

export interface ReadbackInput {
  cosmosItemId: string;
  workspaceId: string;
}

/**
 * Confirm `state.content` is present on the item and matches `kind`.
 *
 * `predicate` is the caller's shape assertion — it receives the content the
 * editor would read, so a provisioner can require exactly what its receipt
 * claims (e.g. "the table count I am about to report is the count that is
 * actually there"). A predicate that merely checks truthiness would let a
 * content bag stripped of its tables pass, so callers pass the real assertion.
 */
export async function confirmContentReadable(
  input: ReadbackInput,
  kind: string,
  predicate: (content: any) => boolean,
  steps: string[],
): Promise<ContentReadback> {
  let reason: 'item-not-found' | 'content-absent' | 'read-failed' = 'read-failed';
  let error = '';
  let cause: unknown;

  for (let attempt = 1; attempt <= READBACK_ATTEMPTS; attempt++) {
    try {
      const items = await itemsContainer();
      const { resource: cur } = await items
        .item(input.cosmosItemId, input.workspaceId)
        .read<WorkspaceItem>();
      if (!cur) {
        reason = 'item-not-found';
        cause = undefined;
        error =
          `item '${input.cosmosItemId}' not found in workspace '${input.workspaceId}' ` +
          '(the Cosmos read returned no document)';
      } else {
        const content = (cur.state as any)?.content;
        if (content && content.kind === kind && predicate(content)) {
          if (attempt > 1) {
            steps.push(`Confirmed the installed ${kind} content is readable on the item on attempt ${attempt}/${READBACK_ATTEMPTS}.`);
          }
          return { ok: true, attempts: attempt };
        }
        reason = 'content-absent';
        cause = undefined;
        error = content
          ? `the item's state.content is present but does not match the provisioned ${kind} shape ` +
            `(kind='${String(content.kind)}')`
          : `the item carries no state.content, so the editor has nothing to read`;
      }
    } catch (e: any) {
      reason = 'read-failed';
      cause = e;
      error = e?.message || String(e);
    }
    if (attempt < READBACK_ATTEMPTS) {
      steps.push(`Content read-back attempt ${attempt}/${READBACK_ATTEMPTS} did not confirm (${error}); retrying.`);
      await new Promise((r) => setTimeout(r, READBACK_BACKOFF_MS[attempt - 1] ?? 400));
    }
  }
  return { ok: false, attempts: READBACK_ATTEMPTS, reason, error, cause };
}

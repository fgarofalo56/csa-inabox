/**
 * copilot-eval-floors — SERVER-ONLY loader for content/evals/eval-floors.json
 * (E3's per-surface quality floors) so the E5 admin page can render floor
 * status without re-declaring the thresholds.
 *
 * The floors ship in the console image: stage-copilot-corpus.sh copies
 * content/evals → apps/fiab-console/copilot-corpus/evals (including
 * eval-floors.json) before `az acr build`. This loader resolves the file from
 * the first available location (staged image layout → repo checkout walking up)
 * exactly like the evaluator Function's resolveEvalRoot, and returns null when
 * absent (a dev container without the staged corpus) — the UI then shows floor
 * status as advisory ('—'), never a fabricated threshold.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SurfaceFloor } from '@/lib/admin/copilot-quality';

export interface EvalFloorsFile {
  floors: Record<string, SurfaceFloor>;
  /** Filename order (the surface grid order) derived from the floors keys. */
  order: string[];
}

/** Candidate locations for the staged eval sets (mirrors resolveEvalRoot). */
function resolveEvalRoot(cwd: string): string | null {
  const staged = path.join(cwd, 'copilot-corpus', 'evals');
  if (fs.existsSync(staged)) return staged;
  const direct = path.join(cwd, 'evals');
  if (fs.existsSync(direct)) return direct;
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'content', 'evals');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let _cache: EvalFloorsFile | null | undefined;

/**
 * Load + parse eval-floors.json (memoized). Returns null when the file cannot
 * be found or parsed — callers treat floors as advisory in that case.
 */
export function loadEvalFloors(cwd = process.cwd()): EvalFloorsFile | null {
  if (_cache !== undefined) return _cache;
  try {
    const root = resolveEvalRoot(cwd);
    if (!root) { _cache = null; return null; }
    const file = path.join(root, 'eval-floors.json');
    if (!fs.existsSync(file)) { _cache = null; return null; }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { floors?: Record<string, SurfaceFloor> };
    const floors = parsed?.floors && typeof parsed.floors === 'object' ? parsed.floors : {};
    _cache = { floors, order: Object.keys(floors) };
    return _cache;
  } catch {
    _cache = null;
    return null;
  }
}

/** Test-only cache reset. */
export function __resetEvalFloorsCache(): void {
  _cache = undefined;
}

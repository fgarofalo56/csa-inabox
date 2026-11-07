import { z } from 'zod';
import type { Doc } from '../store/types.js';

/** Telemetry a stamp reports about itself. Counts and percentages only. */
export const SloSampleSchema = z
  .strictObject({
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    totalRequests: z.number().int().min(0).max(1e12),
    goodRequests: z.number().int().min(0).max(1e12),
    p95LatencyMs: z.number().min(0).max(3_600_000),
    capacityUsedPercent: z.number().min(0).max(100),
  })
  .refine((s) => s.goodRequests <= s.totalRequests, {
    message: 'goodRequests cannot exceed totalRequests',
    path: ['goodRequests'],
  })
  .refine((s) => Date.parse(s.windowEnd) > Date.parse(s.windowStart), {
    message: 'windowEnd must be after windowStart',
    path: ['windowEnd'],
  });

export interface SloSampleDoc extends Doc {
  /** id === stampId: only the latest sample per stamp is kept. */
  windowStart: string;
  windowEnd: string;
  totalRequests: number;
  goodRequests: number;
  p95LatencyMs: number;
  capacityUsedPercent: number;
  reportedAt: string;
  reportedBy: string;
}

export type SloState = 'ok' | 'at-risk' | 'breached' | 'no-data';

export interface StampSlo {
  stampId: string;
  stampStatus: string;
  state: SloState;
  stale: boolean;
  availability: number | null;
  errorBudgetRemaining: number | null;
  p95LatencyMs: number | null;
  capacityUsedPercent: number | null;
  reportedAt: string | null;
}

export interface SloReport {
  generatedAt: string;
  availabilityTarget: number;
  fleet: {
    state: SloState;
    availability: number | null;
    stamps: number;
    byState: Record<SloState, number>;
  };
  stamps: StampSlo[];
}

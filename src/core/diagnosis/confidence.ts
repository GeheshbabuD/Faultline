/**
 * CONFIDENCE POLICY.
 *
 * Thresholds are policy, so they live in one file rather than being spread
 * across components and services. `ui/feedback/confidence` renders a band it is
 * *given*; it never derives one.
 *
 * The numbers below are a starting position, not a measured calibration. A
 * model's self-reported confidence is not a probability, and Phase 10's
 * evaluation dataset exists precisely so these can be replaced with thresholds
 * that have evidence behind them.
 */

export type ConfidenceBand = 'high' | 'moderate' | 'low';

export const CONFIDENCE_BANDS = {
  /** At or above this, a reading is presented as a firm one. */
  high: 0.75,
  /** At or above this, a reading is presented with visible reservation. */
  moderate: 0.5,
} as const;

/**
 * Gates for turning a proposal into a state. Set so that a weak divergence
 * signal becomes `suspect` rather than a confident accusation, and a very weak
 * one becomes `inconclusive` rather than a diagnosis nobody should act on.
 */
export const DECISION_THRESHOLDS = {
  /** Below this, a claimed divergence is not reported at all. */
  divergenceFloor: 0.45,
  /** At or above this, a divergence is reported as the faultline. */
  divergenceConfirmed: 0.7,
  /** Below this, a claim that the reasoning is sound is not asserted. */
  soundFloor: 0.6,
} as const;

/** Restricts any number — including NaN and Infinity — to [0,1]. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.min(1, Math.max(0, value));
  // Three decimal places: enough resolution to rank, not enough to imply the
  // number is calibrated to a precision it does not have.
  return Math.round(clamped * 1000) / 1000;
}

export function confidenceBand(value: number): ConfidenceBand {
  const clamped = clampConfidence(value);
  if (clamped >= CONFIDENCE_BANDS.high) {
    return 'high';
  }
  if (clamped >= CONFIDENCE_BANDS.moderate) {
    return 'moderate';
  }
  return 'low';
}

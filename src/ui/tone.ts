/**
 * The semantic vocabulary of the interface.
 *
 * Every coloured element in Faultline resolves to exactly one of these tones,
 * and each tone means one thing. Components take a `tone`; they never take a
 * colour. That is what stops the palette drifting as screens are added.
 */
export type Tone =
  /** Ordinary interface material. Carries no diagnostic meaning. */
  | 'neutral'
  /** Reasoning matched the reference path. */
  | 'valid'
  /** A possible divergence, not yet confirmed. */
  | 'suspect'
  /** A confirmed reasoning divergence. The loudest tone in the product. */
  | 'faultline'
  /** Repair or transfer confirmed. */
  | 'repaired'
  /** Evidence too thin to state a conclusion; may be awaiting review. */
  | 'uncertain'
  /** Destructive system action. Not a reasoning state. */
  | 'danger';

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-secondary',
  valid: 'text-valid',
  suspect: 'text-suspect',
  faultline: 'text-faultline-ink',
  repaired: 'text-repaired',
  uncertain: 'text-uncertain',
  danger: 'text-danger',
};

export const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'bg-surface-sunken border-line',
  valid: 'bg-valid-bg border-valid-border',
  suspect: 'bg-suspect-bg border-suspect-border',
  faultline: 'bg-faultline-bg border-faultline-border',
  repaired: 'bg-repaired-bg border-repaired-border',
  uncertain: 'bg-uncertain-bg border-uncertain-border',
  danger: 'bg-danger-bg border-danger-border',
};

export const TONE_ACCENT: Record<Tone, string> = {
  neutral: 'bg-line-strong',
  valid: 'bg-valid',
  suspect: 'bg-suspect',
  faultline: 'bg-faultline',
  repaired: 'bg-repaired',
  uncertain: 'bg-uncertain',
  danger: 'bg-danger',
};

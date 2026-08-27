import { cn } from '@/lib/cn';

/**
 * How much weight a diagnosis may be given. The band is *supplied*, never
 * computed here: thresholds are policy and live in `core/diagnosis` (Phase 4),
 * so that changing them is one edit rather than a hunt through components.
 */
export type ConfidenceBand = 'high' | 'moderate' | 'low';

const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: 'High confidence',
  moderate: 'Moderate confidence',
  low: 'Low confidence',
};

const BAND_FILL: Record<ConfidenceBand, string> = {
  high: 'bg-ink',
  moderate: 'bg-suspect',
  low: 'bg-uncertain',
};

const BAND_TEXT: Record<ConfidenceBand, string> = {
  high: 'text-ink',
  moderate: 'text-suspect',
  low: 'text-uncertain',
};

const TICK_COUNT = 24;

export interface ConfidenceIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Confidence as a fraction between 0 and 1. */
  value: number;
  band: ConfidenceBand;
  /** Hide the numeric readout where space is tight, e.g. inside a table row. */
  showValue?: boolean;
  /** Hide the band caption; the numeric readout keeps the meaning. */
  showLabel?: boolean;
}

/**
 * Reads as a measuring instrument rather than a progress bar. Progress bars
 * imply something is completing; this is a reading being taken.
 */
export function ConfidenceIndicator({
  className,
  value,
  band,
  showValue = true,
  showLabel = true,
  ...props
}: ConfidenceIndicatorProps) {
  const clamped = Math.min(1, Math.max(0, value));
  const percent = Math.round(clamped * 100);
  const filled = Math.round(clamped * TICK_COUNT);

  return (
    <div className={cn('flex flex-col gap-1.5', className)} {...props}>
      <div className="flex items-center gap-2.5">
        <div
          className="flex items-end gap-px h-3.5"
          role="meter"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${BAND_LABEL[band]}, ${percent} percent`}
        >
          {Array.from({ length: TICK_COUNT }, (_, index) => {
            const isFilled = index < filled;
            // A quarter-scale gradation, only slightly taller, so the row reads
            // as a graduated scale rather than a waveform.
            const isMajor = index % 4 === 0;
            return (
              <span
                key={index}
                aria-hidden="true"
                className={cn(
                  'w-0.5 rounded-full transition-colors duration-200',
                  isMajor ? 'h-3' : 'h-2.5',
                  isFilled ? BAND_FILL[band] : 'bg-line',
                )}
              />
            );
          })}
        </div>
        {showValue ? (
          <span
            className={cn('font-mono text-sm tabular-nums font-medium', BAND_TEXT[band])}
          >
            {percent}%
          </span>
        ) : null}
      </div>
      {showLabel ? (
        <span className="text-2xs text-ink-muted">{BAND_LABEL[band]}</span>
      ) : null}
    </div>
  );
}

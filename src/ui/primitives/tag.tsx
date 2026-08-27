import { cn } from '@/lib/cn';
import { TONE_SURFACE, TONE_TEXT, type Tone } from '@/ui/tone';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Monospace treatment for identifiers such as `SUB_002`. */
  mono?: boolean;
  /** A small filled dot carrying the tone, for use in dense lists. */
  dot?: boolean;
}

/**
 * A compact label. Deliberately squared off rather than pill-shaped — Faultline
 * reads as an instrument, and pills read as marketing.
 */
export function Tag({
  className,
  tone = 'neutral',
  mono = false,
  dot = false,
  children,
  ...props
}: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 border rounded-xs',
        'px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap',
        mono && 'font-mono tracking-[0.02em] tabular-nums',
        TONE_SURFACE[tone],
        TONE_TEXT[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          className={cn('size-1.5 rounded-full', tone === 'neutral' ? 'bg-ink-faint' : 'bg-current')}
          aria-hidden="true"
        />
      ) : null}
      {children}
    </span>
  );
}

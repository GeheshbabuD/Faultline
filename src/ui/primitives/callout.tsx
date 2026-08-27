import { cn } from '@/lib/cn';
import { TONE_ACCENT, TONE_TEXT, type Tone } from '@/ui/tone';

export interface CalloutProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: Tone;
  title?: React.ReactNode;
}

/**
 * A block of consequence. Structure comes from a single accent rule on the
 * leading edge rather than a tinted box, so several callouts can sit on one
 * page without the layout turning into a patchwork of coloured cards.
 */
export function Callout({
  className,
  tone = 'neutral',
  title,
  children,
  ...props
}: CalloutProps) {
  return (
    <div
      className={cn('relative pl-4 py-1', className)}
      {...(tone === 'danger' || tone === 'faultline' ? { role: 'alert' } : {})}
      {...props}
    >
      <span
        className={cn('absolute left-0 top-0 bottom-0 w-0.5 rounded-full', TONE_ACCENT[tone])}
        aria-hidden="true"
      />
      {title ? (
        <p className={cn('text-sm font-medium mb-1', TONE_TEXT[tone])}>{title}</p>
      ) : null}
      <div className="text-sm text-ink-secondary leading-relaxed [&_p+p]:mt-2">
        {children}
      </div>
    </div>
  );
}

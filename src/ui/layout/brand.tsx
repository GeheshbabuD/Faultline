import { cn } from '@/lib/cn';

/**
 * The mark is the same geometry as the reasoning rail: a path that continues
 * across a lateral displacement. Product and logo say the same thing, so the
 * identity holds even when the wordmark is absent.
 */
export function FaultlineMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn('size-4', className)}
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 7.5h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M8 7.5c2.2 0 1.8 5 4 5"
        stroke="var(--fl-faultline)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M12 12.5h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <FaultlineMark className="size-[18px] text-ink-strong" />
      <span className="text-sm font-semibold tracking-[-0.01em] text-ink-strong">
        Faultline
      </span>
    </span>
  );
}

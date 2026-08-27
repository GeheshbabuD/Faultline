import { cn } from '@/lib/cn';
import { Button } from '@/ui/primitives/button';

/**
 * Empty, loading and error are designed states, not gaps left over when data is
 * missing. Each one says what happened and what the reader can do next.
 */

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({
  className,
  title,
  description,
  action,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 border border-dashed border-line rounded-lg',
        'px-6 py-8',
        className,
      )}
      {...props}
    >
      {/* An interrupted rule: the visual shorthand for "no trace here yet". */}
      <svg width="44" height="8" viewBox="0 0 44 8" fill="none" aria-hidden="true">
        <path d="M0 4h14" stroke="var(--fl-border-strong)" strokeWidth="1" />
        <path d="M30 4h14" stroke="var(--fl-border-strong)" strokeWidth="1" />
        <circle cx="22" cy="4" r="1.5" fill="var(--fl-border-strong)" />
      </svg>
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? (
          <p className="text-sm text-ink-muted max-w-prose">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  onRetry?: () => void;
  /** Technical detail, shown on request. Never leaks a stack trace to students. */
  detail?: string;
}

export function ErrorState({
  className,
  title = 'Something went wrong',
  description = 'The request did not complete. Your work has not been lost.',
  onRetry,
  detail,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn('border border-danger-border bg-danger-bg/50 rounded-lg px-5 py-4', className)}
      {...props}
    >
      <p className="text-sm font-medium text-danger">{title}</p>
      <p className="mt-1 text-sm text-ink-secondary max-w-prose">{description}</p>
      {detail ? (
        <details className="mt-3 group">
          <summary className="text-xs text-ink-muted cursor-pointer select-none hover:text-ink-secondary marker:content-['']">
            <span className="underline underline-offset-2 decoration-line-strong">
              Technical detail
            </span>
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-sm bg-surface-sunken px-3 py-2 font-mono text-2xs text-ink-secondary">
            {detail}
          </pre>
        </details>
      ) : null}
      {onRetry ? (
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Width as a Tailwind class, so skeletons match the shape of real content. */
  className?: string;
}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('h-3.5 rounded-xs bg-surface-sunken animate-pulse', className)}
      {...props}
    />
  );
}

export interface LoadingStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Describes what is happening. Analysis takes real time; say what it is doing. */
  label: string;
}

export function LoadingState({ className, label, ...props }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center gap-3 px-1 py-3', className)}
      {...props}
    >
      <span className="flex gap-1" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1 rounded-full bg-ink-faint"
            style={{
              animation: `fl-step-in 900ms ease-in-out ${i * 140}ms infinite alternate`,
            }}
          />
        ))}
      </span>
      <span className="text-sm text-ink-muted">{label}</span>
    </div>
  );
}

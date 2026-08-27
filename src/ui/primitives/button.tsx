'use client';

import { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * The primary action is ink, not colour. Colour in Faultline means a reasoning
 * state, so spending it on buttons would dilute the one signal that matters.
 */
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: cn(
    'bg-ink-strong text-canvas border border-ink-strong',
    'hover:bg-ink hover:border-ink',
    'active:bg-ink-strong',
  ),
  secondary: cn(
    'bg-surface text-ink border border-line',
    'hover:bg-surface-sunken hover:border-line-strong',
    'active:bg-surface-sunken',
  ),
  ghost: cn(
    'bg-transparent text-ink-secondary border border-transparent',
    'hover:bg-surface-sunken hover:text-ink',
    'active:bg-surface-sunken',
  ),
  danger: cn(
    'bg-transparent text-danger border border-danger-border',
    'hover:bg-danger-bg',
    'active:bg-danger-bg',
  ),
};

const SIZE_STYLES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-sm',
  md: 'h-8.5 px-3 text-sm gap-2 rounded-md',
  lg: 'h-10 px-4 text-base gap-2 rounded-md',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render as the child element (a Next `Link`, for instance) instead of a button. */
  asChild?: boolean;
  /** Shows a progress indicator and blocks interaction without collapsing width. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'secondary',
    size = 'md',
    asChild = false,
    loading = false,
    disabled,
    children,
    ...props
  },
  ref,
) {
  const Component = asChild ? Slot : 'button';
  const isDisabled = disabled || loading;

  return (
    <Component
      ref={ref}
      // A Slot child owns its own element type, so `type` would be wrong there.
      {...(asChild ? {} : { type: props.type ?? 'button' })}
      disabled={asChild ? undefined : isDisabled}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center whitespace-nowrap',
        'font-medium tracking-[-0.006em]',
        'transition-colors duration-150 ease-[var(--ease-out-quart)]',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANT_STYLES[variant],
        SIZE_STYLES[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <>
          {/* Keeps the label's width so the button does not resize mid-action. */}
          <span className="invisible contents">{children}</span>
          <span className="absolute inset-0 grid place-items-center">
            <Spinner />
          </span>
        </>
      ) : (
        children
      )}
    </Component>
  );
});

function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 animate-spin"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

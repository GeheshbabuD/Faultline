'use client';

import { createContext, useContext, useId, forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * Field wires a label, description and error message to a control and threads
 * the right `id` / `aria-describedby` / `aria-invalid` through automatically.
 * Accessibility here is structural rather than something each screen remembers
 * to add.
 */

type FieldContextValue = {
  controlId: string;
  descriptionId: string;
  errorId: string;
  hasError: boolean;
  hasDescription: boolean;
};

const FieldContext = createContext<FieldContextValue | null>(null);

function useFieldContext(component: string): FieldContextValue {
  const context = useContext(FieldContext);
  if (!context) {
    throw new Error(`${component} must be used inside a <Field>`);
  }
  return context;
}

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  error?: string | undefined;
  description?: string | undefined;
}

export function Field({
  className,
  children,
  error,
  description,
  ...props
}: FieldProps) {
  const id = useId();
  const value: FieldContextValue = {
    controlId: `${id}-control`,
    descriptionId: `${id}-description`,
    errorId: `${id}-error`,
    hasError: Boolean(error),
    hasDescription: Boolean(description),
  };

  return (
    <FieldContext.Provider value={value}>
      <div className={cn('flex flex-col gap-1.5', className)} {...props}>
        {children}
        {description && !error ? (
          <p id={value.descriptionId} className="text-xs text-ink-muted">
            {description}
          </p>
        ) : null}
        {error ? (
          <p
            id={value.errorId}
            role="alert"
            className="flex items-start gap-1.5 text-xs text-danger"
          >
            <svg
              viewBox="0 0 12 12"
              className="mt-0.5 size-3 shrink-0"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.25" />
              <path d="M6 3.5v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              <circle cx="6" cy="8.5" r="0.6" fill="currentColor" />
            </svg>
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** Marks the field required, both visually and for assistive technology. */
  required?: boolean;
}

export function Label({ className, children, required, ...props }: LabelProps) {
  const { controlId } = useFieldContext('Label');
  return (
    <label
      htmlFor={controlId}
      className={cn(
        'text-sm font-medium text-ink-secondary tracking-[-0.004em]',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-faultline" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}

/** Shared surface treatment so Input and Textarea cannot drift apart. */
const controlStyles = cn(
  'w-full bg-surface text-ink placeholder:text-ink-faint',
  'border border-line rounded-md',
  'transition-colors duration-150 ease-[var(--ease-out-quart)]',
  'hover:border-line-strong',
  'focus:border-line-strong',
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted',
  'aria-[invalid=true]:border-danger-border aria-[invalid=true]:bg-danger-bg/40',
);

function useControlAria() {
  const { controlId, descriptionId, errorId, hasError, hasDescription } =
    useFieldContext('form control');
  const describedBy =
    [hasError ? errorId : null, hasDescription && !hasError ? descriptionId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  return {
    id: controlId,
    'aria-invalid': hasError || undefined,
    'aria-describedby': describedBy,
  } as const;
}

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  const aria = useControlAria();
  return (
    <input
      ref={ref}
      {...aria}
      className={cn(controlStyles, 'h-8.5 px-2.5 text-sm', className)}
      {...props}
    />
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grows with content instead of scrolling — reasoning answers vary in length. */
  autoResize?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoResize = false, onChange, rows = 3, ...props },
  ref,
) {
  const aria = useControlAria();

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (autoResize) {
      const el = event.currentTarget;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
    onChange?.(event);
  };

  return (
    <textarea
      ref={ref}
      rows={rows}
      {...aria}
      onChange={handleChange}
      className={cn(
        controlStyles,
        'resize-y px-2.5 py-2 text-base leading-relaxed',
        autoResize && 'resize-none overflow-hidden',
        className,
      )}
      {...props}
    />
  );
});
